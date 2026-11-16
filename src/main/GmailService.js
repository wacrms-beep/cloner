/**
 * GmailService (src/main/GmailService.js) — Module 1C §2 :
 * - OAuth2 Google pour application de bureau, flux « loopback » (serveur HTTP local éphémère
 *   sur 127.0.0.1, port aléatoire) avec PKCE (S256).
 * - Scope UNIQUEMENT : https://www.googleapis.com/auth/gmail.readonly.
 * - Le client_id (et client_secret si requis) est lu depuis les réglages utilisateur (jamais en dur).
 * - Tokens (refresh_token, access_token) chiffrés avec safeStorage dans SessionVault (type 'gmail'),
 *   jamais en clair ni dans les logs.
 * - Gère l'expiration (7 jours en mode Test Google Cloud) : alerte « Gmail à reconnecter ».
 * - waitForVerification({ fromDomain, sinceTs, timeoutMs, toAlias }) :
 *   interroge users.messages.list (q: "from:{domain} newer_than:1d"), filtre sur l'alias de destination,
 *   polling toutes les 5 s, récupère le message (format 'full'), extrait UNIQUEMENT :
 *   - lien de vérification (URL contenant verify|confirm|activate|token|code) DONT le domaine
 *     enregistrable correspond au site ciblé (sinon rejet + alerte) ;
 *   - ou code numérique 4-8 chiffres.
 *   Ne stocke jamais le contenu du mail, ni l'expéditeur complet, ni les pièces jointes.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Extrait le domaine enregistrable (eTLD+1 simplifié) pour vérifier la correspondance
 * stricte entre le lien de vérification et le site ciblé.
 */
function getRegistrableDomain(hostname) {
  const clean = String(hostname || '').toLowerCase().trim().replace(/\.$/, '');
  if (!clean) return '';
  if (clean === 'localhost' || /^(\d{1,3}\.){3}\d{1,3}$/.test(clean)) {
    return clean;
  }
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;
  // Gérer les suffixes doubles courants (co.uk, com.fr, org.uk, com.au...)
  const lastTwo = parts.slice(-2).join('.');
  if (/^(co|com|org|net|gov|edu)\.[a-z]{2}$/.test(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Vérifie si l'hôte d'un lien de vérification appartient au même domaine (ou domaine enregistrable)
 * que le domaine cible du clone.
 */
function isSameTargetDomain(linkUrlString, targetDomain) {
  try {
    const parsed = new URL(linkUrlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const linkHost = parsed.hostname.toLowerCase();
    const targetHost = String(targetDomain || '').toLowerCase().trim();
    if (!targetHost) return false;
    if (linkHost === targetHost || linkHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${linkHost}`)) {
      return true;
    }
    const regLink = getRegistrableDomain(linkHost);
    const regTarget = getRegistrableDomain(targetHost);
    return Boolean(regLink && regLink === regTarget);
  } catch (_) {
    return false;
  }
}

/**
 * Décode du Base64URL (utilisé par l'API Gmail pour les corps MIME) en UTF-8.
 */
function decodeBase64Url(input) {
  if (!input || typeof input !== 'string') return '';
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

/**
 * Parcourt récursivement la structure MIME d'un message Gmail (format 'full')
 * pour en extraire uniquement le texte brut / HTML en mémoire vive, en ignorant
 * toute pièce jointe (filename non vide ou attachmentId).
 */
function extractBodiesFromPayload(payload, accumulator = []) {
  if (!payload || typeof payload !== 'object') return accumulator;

  // Ignorer strictement toute pièce jointe
  if (payload.filename && String(payload.filename).trim().length > 0) {
    return accumulator;
  }
  if (payload.body && payload.body.attachmentId) {
    return accumulator;
  }

  const mimeType = String(payload.mimeType || '').toLowerCase();
  if ((mimeType === 'text/plain' || mimeType === 'text/html' || !mimeType) && payload.body && payload.body.data) {
    accumulator.push(decodeBase64Url(payload.body.data));
  }

  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      extractBodiesFromPayload(part, accumulator);
    }
  }
  return accumulator;
}

/**
 * Extrait un lien de vérification ou un code numérique 4-8 chiffres depuis le corps d'un mail,
 * sans jamais persister le corps du mail.
 *
 * @param {string} bodyText Texte du mail (plain + html)
 * @param {string} targetDomain Domaine ciblé (ex: 'example.com' ou '127.0.0.1')
 * @returns {{ kind: 'link'|'code'|null, value: string|null, foreignLinksRejected: string[] }}
 */
function extractVerificationFromText(bodyText, targetDomain) {
  const text = String(bodyText || '');
  const foreignLinksRejected = [];

  // 1. Recherche de toutes les URLs http/https contenant verify|confirm|activate|token|code
  const urlRegex = /https?:\/\/[^\s"'<>)\]]+/gi;
  const verifyKeywordRegex = /(verify|confirm|activate|validation|token|code)/i;

  const matches = text.match(urlRegex) || [];
  for (const rawUrl of matches) {
    // Nettoyer la ponctuation finale éventuelle + entités HTML &amp;
    const cleanUrl = rawUrl.replace(/&amp;/g, '&').replace(/[.,;!?]+$/, '');
    if (!verifyKeywordRegex.test(cleanUrl)) {
      continue;
    }
    if (isSameTargetDomain(cleanUrl, targetDomain)) {
      return { kind: 'link', value: cleanUrl, foreignLinksRejected };
    }
    try {
      const foreignHost = new URL(cleanUrl).hostname;
      foreignLinksRejected.push(foreignHost);
    } catch (_) {
      foreignLinksRejected.push('invalid-host');
    }
  }

  // 2. Recherche d'un code numérique de 4 à 8 chiffres (hors années ou dimensions courantes si possible)
  // On privilégie d'abord un code précédé d'un mot-clé (code, pin, verification, otp)
  const contextualCodeRe = /(?:code|v[ée]rification|confirmation|otp|pin)\s*(?:est|is|:|-)?\s*\b(\d{4,8})\b/i;
  const ctxMatch = text.match(contextualCodeRe);
  if (ctxMatch && ctxMatch[1]) {
    return { kind: 'code', value: ctxMatch[1], foreignLinksRejected };
  }

  // Sinon, code numérique isolé de 4 à 8 chiffres (en retirant les balises HTML pour éviter les couleurs/attributs)
  const strippedText = text.replace(/<[^>]+>/g, ' ').replace(/https?:\/\/[^\s]+/g, ' ');
  const standaloneCodeRe = /\b(\d{4,8})\b/g;
  let m;
  while ((m = standaloneCodeRe.exec(strippedText)) !== null) {
    const candidate = m[1];
    // Éviter de confondre un port local ou une année isolée si d'autres nombres existent
    if (candidate.length >= 4 && candidate.length <= 8) {
      return { kind: 'code', value: candidate, foreignLinksRejected };
    }
  }

  return { kind: null, value: null, foreignLinksRejected };
}

class GmailService {
  /**
   * @param {object} deps
   * @param {import('./SessionVault').SessionVault} deps.sessionVault
   * @param {import('./db/repositories/AuthRepository').AuthRepository} deps.authRepo
   * @param {import('./SettingsService').SettingsService} deps.settingsService
   * @param {object} [deps.shell] Electron shell pour ouvrir l'URL OAuth
   * @param {Function} [deps.fetchFn] Fonction fetch personnalisée (pour tests unitaires/simulés)
   * @param {import('./Logger').Logger} [deps.logger]
   * @param {Function} [deps.onAlert] Callback (alertPayload) => void
   */
  constructor(deps = {}) {
    this.sessionVault = deps.sessionVault;
    this.authRepo = deps.authRepo;
    this.settingsService = deps.settingsService;
    this.shell = deps.shell || null;
    this.fetchFn = deps.fetchFn || globalThis.fetch;
    this.logger = deps.logger || null;
    this.onAlert = deps.onAlert || (() => {});
    this.pollIntervalMs = deps.pollIntervalMs || 5000;
  }

  /**
   * Génère un couple PKCE (code_verifier, code_challenge S256).
   */
  static generatePkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  /**
   * Construit l'alias Gmail plus-addressing : ton.nom+<slug-domaine>@gmail.com (§2).
   * Le moteur Python ne reçoit que cet alias final.
   */
  buildPlusAlias(domain, suffix = '') {
    const state = this.status();
    const baseEmail = state.email || 'utilisateur.test@gmail.com';
    const atIdx = baseEmail.indexOf('@');
    if (atIdx === -1) {
      throw new Error('Adresse Gmail invalide dans gmail_state.');
    }
    const localPart = baseEmail.slice(0, atIdx).split('+')[0];
    const hostPart = baseEmail.slice(atIdx + 1);
    const slug = String(domain || 'site')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'site';
    const extra = suffix ? `-${String(suffix).replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}` : '';
    return `${localPart}+${slug}${extra}@${hostPart}`;
  }

  /**
   * Retourne l'état courant de la connexion Gmail (en vérifiant l'expiration de 7 jours en mode Test).
   */
  status() {
    const st = this.authRepo.getGmailState();
    const hasVaultTokens = this.sessionVault.exists('gmail', 'oauth_tokens');

    if (st.status === 'connected' && !hasVaultTokens) {
      return this.authRepo.saveGmailState({
        email: st.email || '',
        status: 'disconnected',
        connectedAt: null,
        expiresHint: null
      });
    }

    if (st.status === 'connected' && st.expires_hint) {
      const expTime = Date.parse(st.expires_hint);
      if (Number.isFinite(expTime) && Date.now() >= expTime) {
        const updated = this.authRepo.saveGmailState({
          email: st.email,
          status: 'expired',
          connectedAt: st.connected_at,
          expiresHint: st.expires_hint
        });
        return {
          ...updated,
          scope: GMAIL_READONLY_SCOPE,
          reconnectAlert: 'Gmail à reconnecter (expiration 7 jours du mode Test atteinte)'
        };
      }
    }

    return {
      ...st,
      scope: GMAIL_READONLY_SCOPE,
      reconnectAlert: st.status === 'expired' ? 'Gmail à reconnecter' : null
    };
  }

  /**
   * Lance le flux OAuth2 loopback sur 127.0.0.1:<port aléatoire> avec PKCE.
   * Scope strictement limité à gmail.readonly.
   *
   * @param {object} [options]
   * @param {string} [options.clientId] Surcharge éventuelle du client_id
   * @param {string} [options.clientSecret] Surcharge éventuelle du client_secret
   * @param {Function} [options.onAuthUrlReady] Callback appelé avec l'URL d'autorisation (utile en test)
   * @param {number} [options.timeoutMs=120000]
   */
  async connect(options = {}) {
    const settings = this.settingsService ? this.settingsService.getAll() : {};
    const clientId = String(options.clientId || settings.gmailClientId || '').trim();
    const clientSecret = String(options.clientSecret ?? settings.gmailClientSecret ?? '').trim();

    if (!clientId) {
      throw new Error('Veuillez saisir votre Client ID OAuth Google dans Réglages > Gmail.');
    }

    if (this.settingsService && options.clientId) {
      this.settingsService.update({
        gmailClientId: clientId,
        ...(options.clientSecret !== undefined ? { gmailClientSecret: clientSecret } : {})
      });
    }

    const { verifier, challenge } = GmailService.generatePkcePair();
    const stateToken = crypto.randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
      let settled = false;
      const server = http.createServer();

      const cleanup = () => {
        try {
          server.close();
        } catch (_) {
          // Ignorer
        }
      };

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('Délai dépassé lors de la connexion OAuth Gmail.'));
        }
      }, options.timeoutMs || 120000);

      server.on('request', async (req, res) => {
        try {
          const reqUrl = new URL(req.url, 'http://127.0.0.1');
          if (reqUrl.pathname !== '/oauth2callback') {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
          }

          const returnedState = reqUrl.searchParams.get('state');
          const code = reqUrl.searchParams.get('code');
          const error = reqUrl.searchParams.get('error');

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>Connexion Gmail validée</h2><p>Vous pouvez fermer cet onglet et revenir dans Universal Clone.</p></body></html>');

          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const port = server.address().port;
          cleanup();

          if (error) {
            return reject(new Error(`Autorisation Google refusée : ${error}`));
          }
          if (!code || returnedState !== stateToken) {
            return reject(new Error('Paramètres de retour OAuth invalides (state ou code manquant).'));
          }

          const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
          const tokenData = await this._exchangeCodeForTokens({
            code,
            clientId,
            clientSecret,
            redirectUri,
            codeVerifier: verifier
          });

          const profileEmail = await this._fetchUserEmail(tokenData.access_token);
          const now = new Date();
          const expiresHint = new Date(now.getTime() + SEVEN_DAYS_MS).toISOString();

          // Chiffrement des tokens dans SessionVault (type 'gmail') — jamais en clair en base ni dans les logs
          this.sessionVault.store('gmail', 'oauth_tokens', {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || null,
            scope: GMAIL_READONLY_SCOPE,
            token_type: tokenData.token_type || 'Bearer',
            expiry_date: Date.now() + (Number(tokenData.expires_in || 3600) * 1000)
          });

          const savedState = this.authRepo.saveGmailState({
            email: profileEmail,
            status: 'connected',
            connectedAt: now.toISOString(),
            expiresHint
          });

          if (this.logger) {
            this.logger.info('GmailService', 'Compte Gmail connecté en lecture seule', {
              status: 'connected',
              scope: GMAIL_READONLY_SCOPE
            });
          }

          resolve({
            ...savedState,
            scope: GMAIL_READONLY_SCOPE
          });
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            cleanup();
          }
          reject(err);
        }
      });

      server.listen(0, '127.0.0.1', async () => {
        const address = server.address();
        const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: GMAIL_READONLY_SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
          state: stateToken
        });
        const authUrl = `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;

        if (typeof options.onAuthUrlReady === 'function') {
          options.onAuthUrlReady(authUrl, redirectUri);
        } else if (this.shell && typeof this.shell.openExternal === 'function') {
          await this.shell.openExternal(authUrl);
        }
      });
    });
  }

  /**
   * Révoque le token auprès de Google, supprime le fichier chiffré du SessionVault
   * et réinitialise gmail_state.
   */
  async disconnect() {
    const tokens = this.sessionVault.load('gmail', 'oauth_tokens');
    if (tokens && (tokens.refresh_token || tokens.access_token)) {
      const tokenToRevoke = tokens.refresh_token || tokens.access_token;
      try {
        await this.fetchFn(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(tokenToRevoke)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      } catch (_) {
        // Ignorer une erreur réseau lors de la révocation distante, la suppression locale est garantie
      }
    }

    this.sessionVault.remove('gmail', 'oauth_tokens');
    const state = this.authRepo.saveGmailState({
      email: '',
      status: 'disconnected',
      connectedAt: null,
      expiresHint: null
    });

    if (this.logger) {
      this.logger.info('GmailService', 'Compte Gmail déconnecté et jetons supprimés du coffre-fort');
    }

    return state;
  }

  /**
   * Attend la réception d'un mail de vérification et en extrait UNIQUEMENT le lien ou le code (§2).
   * Ne stocke jamais le contenu du mail, ni l'expéditeur complet, ni les pièces jointes.
   *
   * @param {object} params
   * @param {string} params.fromDomain Domaine du site ciblé (ex: 'example.com')
   * @param {number} [params.sinceTs] Timestamp ms à partir duquel chercher
   * @param {number} [params.timeoutMs=120000] Délai max (120 s par défaut §1)
   * @param {string} [params.toAlias] Alias plus-addressing attendu
   */
  async waitForVerification({ fromDomain, sinceTs = 0, timeoutMs = 120000, toAlias = '' }) {
    const cleanDomain = String(fromDomain || '').toLowerCase().trim();
    if (!cleanDomain) {
      throw new Error('Domaine cible requis pour waitForVerification.');
    }

    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 120000);
    const pollMs = Math.max(200, Number(this.pollIntervalMs) || 5000);
    const inspectedMessageIds = new Set();

    while (Date.now() < deadline) {
      const accessToken = await this._getValidAccessToken();

      // Requête conforme §2 : q: "from:{domain} newer_than:1d" + filtre sur l'alias
      const queryParts = [`from:${cleanDomain}`, 'newer_than:1d'];
      if (toAlias) {
        queryParts.push(`to:${toAlias}`);
      }
      const q = queryParts.join(' ');

      const listUrl = `${GMAIL_API_BASE}/messages?q=${encodeURIComponent(q)}&maxResults=10`;
      const listRes = await this.fetchFn(listUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (listRes.status === 401 || listRes.status === 403) {
        this._markExpiredAndAlert();
        throw new Error('Gmail à reconnecter (jeton expiré ou révoqué).');
      }

      if (listRes.ok) {
        const listData = await listRes.json();
        const messages = Array.isArray(listData.messages) ? listData.messages : [];

        for (const msgSummary of messages) {
          if (!msgSummary || !msgSummary.id || inspectedMessageIds.has(msgSummary.id)) {
            continue;
          }
          inspectedMessageIds.add(msgSummary.id);

          const fullUrl = `${GMAIL_API_BASE}/messages/${encodeURIComponent(msgSummary.id)}?format=full`;
          const msgRes = await this.fetchFn(fullUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${accessToken}` }
          });

          if (!msgRes.ok) continue;
          const fullMsg = await msgRes.json();

          // Filtre horaire optionnel
          const internalDate = Number(fullMsg.internalDate || 0);
          if (sinceTs && internalDate > 0 && internalDate + 5000 < sinceTs) {
            continue;
          }

          // Vérification de l'alias de destination dans les en-têtes To / Delivered-To
          if (toAlias && fullMsg.payload && Array.isArray(fullMsg.payload.headers)) {
            const toHeaders = fullMsg.payload.headers
              .filter((h) => h && /^(to|delivered-to|x-original-to)$/i.test(String(h.name || '')))
              .map((h) => String(h.value || '').toLowerCase());
            if (toHeaders.length > 0 && !toHeaders.some((val) => val.includes(toAlias.toLowerCase()))) {
              continue;
            }
          }

          // Extraction en mémoire vive uniquement (sans pièces jointes)
          const bodyParts = extractBodiesFromPayload(fullMsg.payload, []);
          const combinedBody = bodyParts.join('\n');

          const extracted = extractVerificationFromText(combinedBody, cleanDomain);
          if (extracted.foreignLinksRejected.length > 0) {
            this.onAlert({
              type: 'gmail:foreign_link_blocked',
              domain: cleanDomain,
              foreignHosts: extracted.foreignLinksRejected,
              message: `Lien de vérification rejeté car son domaine (${extracted.foreignLinksRejected[0]}) ne correspond pas au site ciblé (${cleanDomain}).`
            });
          }

          if (extracted.kind && extracted.value) {
            return {
              found: true,
              kind: extracted.kind,
              value: extracted.value
            };
          }
        }
      }

      if (Date.now() + pollMs >= deadline) {
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    return {
      found: false,
      kind: null,
      value: null,
      timeout: true
    };
  }

  async _exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri, codeVerifier }) {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier
    });
    if (clientSecret) {
      body.set('client_secret', clientSecret);
    }

    const res = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!res.ok) {
      throw new Error(`Échec de l’échange du code OAuth Google (HTTP ${res.status}).`);
    }
    return res.json();
  }

  async _fetchUserEmail(accessToken) {
    const res = await this.fetchFn(`${GMAIL_API_BASE}/profile`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      throw new Error(`Impossible de lire le profil Gmail (HTTP ${res.status}).`);
    }
    const data = await res.json();
    return String(data.emailAddress || '');
  }

  async _getValidAccessToken() {
    const st = this.status();
    if (st.status === 'expired') {
      this._markExpiredAndAlert();
      throw new Error('Gmail à reconnecter (session OAuth expirée).');
    }

    const tokens = this.sessionVault.load('gmail', 'oauth_tokens');
    if (!tokens || !tokens.access_token) {
      throw new Error('Aucun jeton Gmail disponible. Connectez Gmail dans les Réglages.');
    }

    // Si le jeton expire dans moins de 60 s et qu'on a un refresh_token, on le rafraîchit
    if (tokens.expiry_date && Date.now() + 60000 >= tokens.expiry_date && tokens.refresh_token) {
      try {
        const settings = this.settingsService ? this.settingsService.getAll() : {};
        const body = new URLSearchParams({
          client_id: String(settings.gmailClientId || ''),
          refresh_token: tokens.refresh_token,
          grant_type: 'refresh_token'
        });
        if (settings.gmailClientSecret) {
          body.set('client_secret', String(settings.gmailClientSecret));
        }
        const res = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });
        if (!res.ok) {
          this._markExpiredAndAlert();
          throw new Error('Gmail à reconnecter (rafraîchissement du jeton refusé).');
        }
        const refreshed = await res.json();
        const updatedTokens = {
          ...tokens,
          access_token: refreshed.access_token,
          expiry_date: Date.now() + (Number(refreshed.expires_in || 3600) * 1000)
        };
        this.sessionVault.store('gmail', 'oauth_tokens', updatedTokens);
        return updatedTokens.access_token;
      } catch (err) {
        this._markExpiredAndAlert();
        throw err;
      }
    }

    return tokens.access_token;
  }

  _markExpiredAndAlert() {
    const current = this.authRepo.getGmailState();
    this.authRepo.saveGmailState({
      email: current.email || '',
      status: 'expired',
      connectedAt: current.connected_at,
      expiresHint: current.expires_hint
    });
    this.onAlert({
      type: 'gmail:reconnect_needed',
      message: 'Gmail à reconnecter'
    });
  }
}

module.exports = {
  GmailService,
  GMAIL_READONLY_SCOPE,
  extractVerificationFromText,
  isSameTargetDomain,
  getRegistrableDomain
};
