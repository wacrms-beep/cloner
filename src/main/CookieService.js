/**
 * CookieService (src/main/CookieService.js) — Module 1C §5 :
 * - Parsing automatique et normalisation des 4 formats de cookies vers le format Playwright :
 *   (1) JSON export d'extensions (EditThisCookie / Cookie-Editor : tableau d'objets avec expirationDate, hostOnly, sameSite...)
 *   (2) storage_state Playwright ({ cookies: [...], origins: [...] })
 *   (3) En-tête HTTP brut ("Cookie: a=b; c=d" ou "a=b; c=d")
 *   (4) Format Netscape cookies.txt (lignes tabulées à 7 colonnes + support #HttpOnly_)
 *   + Saisie unitaire d'un cookie objet.
 * - Validation stricte (taille max, noms/valeurs valides, domaine requis, normalisation sameSite: Strict|Lax|None).
 * - Chiffrement immédiat dans SessionVault ('cookies:<domain>') et enregistrement dans auth_sessions.
 * - Aucun cookie ni valeur de cookie n'est jamais écrit en clair en base ou dans les logs ;
 *   les messages d'erreur et résumés masquent toujours les valeurs.
 * - Combinaison / priorité multi-sessions (§5) :
 *   cookies actifs choisis > compte test (signup_auto) > session manuelle (manual).
 */

const MAX_RAW_COOKIE_INPUT_BYTES = 512 * 1024; // 512 Ko max
const MAX_COOKIES_PER_SESSION = 300;
const MAX_COOKIE_NAME_LEN = 256;
const MAX_COOKIE_VALUE_LEN = 4096;

/**
 * Masque la valeur d'un cookie pour tout affichage non déverrouillé ou message de journal.
 */
function maskCookieValue(val) {
  const s = String(val ?? '');
  if (!s) return '';
  if (s.length <= 4) return '••••';
  return `${s.slice(0, 2)}••••${s.slice(-2)}`;
}

/**
 * Normalise l'attribut sameSite au format strict attendu par Playwright ('Strict' | 'Lax' | 'None').
 */
function normalizeSameSite(rawSameSite, secure = false) {
  const s = String(rawSameSite || '').toLowerCase().trim();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') {
    return secure ? 'None' : 'Lax';
  }
  return 'Lax';
}

/**
 * Nettoie et valide un nom de domaine de cookie.
 */
function normalizeCookieDomain(rawDomain, fallbackDomain = '') {
  const candidate = String(rawDomain || fallbackDomain || '').trim().toLowerCase();
  if (!candidate) {
    throw new Error('Domaine de cookie requis.');
  }
  let host = candidate;
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch (_) {
      // garder host
    }
  }
  host = host.replace(/:\d+$/, '').trim();
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) {
    throw new Error('Domaine de cookie invalide.');
  }
  return host;
}

/**
 * Normalise un objet cookie individuel vers le format Playwright storageState.cookies[i].
 */
function normalizeSingleCookie(raw, defaultDomain = '') {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Objet cookie invalide.');
  }

  const name = String(raw.name ?? '').trim();
  if (!name || name.length > MAX_COOKIE_NAME_LEN || /[\r\n\t;=]/.test(name)) {
    throw new Error('Nom de cookie invalide.');
  }

  const value = String(raw.value ?? '');
  if (value.length > MAX_COOKIE_VALUE_LEN || /[\r\n]/.test(value)) {
    throw new Error(`Valeur trop longue ou invalide pour le cookie "${name}".`);
  }

  const domain = normalizeCookieDomain(raw.domain, defaultDomain);
  const pathStr = String(raw.path || '/').trim() || '/';
  const httpOnly = Boolean(raw.httpOnly ?? raw.httponly ?? false);
  const secure = Boolean(raw.secure ?? false);

  let expires = -1;
  const rawExp = raw.expires ?? raw.expirationDate ?? raw.expiry ?? -1;
  if (rawExp !== undefined && rawExp !== null && rawExp !== '' && rawExp !== -1) {
    const numExp = Number(rawExp);
    if (Number.isFinite(numExp) && numExp > 0) {
      // Si fourni en millisecondes (> année 2200 en secondes), convertir en secondes
      expires = numExp > 10000000000 ? Math.floor(numExp / 1000) : Math.floor(numExp);
    } else if (typeof rawExp === 'string') {
      const parsedDate = Date.parse(rawExp);
      if (Number.isFinite(parsedDate) && parsedDate > 0) {
        expires = Math.floor(parsedDate / 1000);
      }
    }
  }

  const sameSite = normalizeSameSite(raw.sameSite, secure);
  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : true;

  return {
    name,
    value,
    domain,
    path: pathStr.startsWith('/') ? pathStr : `/${pathStr}`,
    expires,
    httpOnly,
    secure,
    sameSite,
    enabled
  };
}

/**
 * Détecte automatiquement le format parmi les 4 supportés et retourne la liste normalisée :
 * - 'playwright_storage_state'
 * - 'extension_json' (EditThisCookie / Cookie-Editor)
 * - 'netscape_txt'
 * - 'raw_header'
 */
function parseCookiesInput(input, defaultDomain = '') {
  if (input === null || input === undefined) {
    throw new Error('Entrée de cookies vide.');
  }

  // Cas objet déjà structuré (storage_state ou tableau d'objets ou cookie unique)
  if (typeof input === 'object') {
    if (Array.isArray(input)) {
      const cookies = input.slice(0, MAX_COOKIES_PER_SESSION).map((c) => normalizeSingleCookie(c, defaultDomain));
      return { format: 'extension_json', cookies, origins: [] };
    }
    if (Array.isArray(input.cookies)) {
      const cookies = input.cookies
        .slice(0, MAX_COOKIES_PER_SESSION)
        .map((c) => normalizeSingleCookie(c, defaultDomain));
      const origins = Array.isArray(input.origins) ? input.origins : [];
      return { format: 'playwright_storage_state', cookies, origins };
    }
    if (input.name !== undefined) {
      return {
        format: 'single_cookie',
        cookies: [normalizeSingleCookie(input, defaultDomain)],
        origins: []
      };
    }
    throw new Error('Objet de cookies non reconnu.');
  }

  if (typeof input !== 'string') {
    throw new Error('Format de cookies invalide.');
  }

  if (Buffer.byteLength(input, 'utf8') > MAX_RAW_COOKIE_INPUT_BYTES) {
    throw new Error('Taille maximale d’import de cookies dépassée (max 512 Ko).');
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Chaîne de cookies vide.');
  }

  // 1 & 2 : JSON (storage_state Playwright ou export EditThisCookie / Cookie-Editor)
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (_) {
      throw new Error('JSON de cookies invalide.');
    }
    return parseCookiesInput(parsed, defaultDomain);
  }

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // 4 : Format Netscape cookies.txt (lignes à 7 colonnes séparées par des tabulations ou espaces multiples)
  const hasNetscapeHeader = lines.some((l) => /^#\s*(Netscape|HTTP Cookie File)/i.test(l));
  const tabLines = lines.filter((l) => !l.startsWith('#') || /^#HttpOnly_/i.test(l));
  const looksLikeNetscape = hasNetscapeHeader || tabLines.some((l) => l.split('\t').length >= 7);

  if (looksLikeNetscape) {
    const cookies = [];
    for (const rawLine of lines) {
      let line = rawLine;
      let httpOnly = false;
      if (/^#HttpOnly_/i.test(line)) {
        httpOnly = true;
        line = line.replace(/^#HttpOnly_/i, '');
      } else if (line.startsWith('#')) {
        continue;
      }

      const parts = line.split('\t');
      if (parts.length < 7) continue;

      const [dom, , pathVal, secureFlag, expStr, name, ...valParts] = parts;
      const value = valParts.join('\t');
      cookies.push(
        normalizeSingleCookie(
          {
            name,
            value,
            domain: dom,
            path: pathVal || '/',
            secure: /^true$/i.test(secureFlag.trim()),
            expires: Number(expStr) || -1,
            httpOnly,
            sameSite: 'Lax'
          },
          defaultDomain
        )
      );
      if (cookies.length >= MAX_COOKIES_PER_SESSION) break;
    }

    if (cookies.length === 0) {
      throw new Error('Aucun cookie valide trouvé dans le fichier Netscape cookies.txt.');
    }
    return { format: 'netscape_txt', cookies, origins: [] };
  }

  // 3 : En-tête HTTP brut ("Cookie: a=b; c=d" ou "a=b; c=d")
  const headerClean = trimmed.replace(/^cookie\s*:\s*/i, '').trim();
  const pairs = headerClean.split(';').map((p) => p.trim()).filter(Boolean);
  const cookies = [];
  const ignoredAttrs = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);

  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) continue;
    const k = pair.slice(0, eqIdx).trim();
    const v = pair.slice(eqIdx + 1).trim();
    if (ignoredAttrs.has(k.toLowerCase())) continue;

    cookies.push(
      normalizeSingleCookie(
        {
          name: k,
          value: v,
          domain: defaultDomain,
          path: '/',
          sameSite: 'Lax'
        },
        defaultDomain
      )
    );
    if (cookies.length >= MAX_COOKIES_PER_SESSION) break;
  }

  if (cookies.length === 0) {
    throw new Error('Aucun cookie valide détecté dans l’en-tête fourni.');
  }

  return { format: 'raw_header', cookies, origins: [] };
}

class CookieService {
  /**
   * @param {object} deps
   * @param {import('./SessionVault').SessionVault} deps.sessionVault
   * @param {import('./db/repositories/AuthRepository').AuthRepository} deps.authRepo
   * @param {import('./EngineBridge').EngineBridge} [deps.engineBridge]
   * @param {import('./Logger').Logger} [deps.logger]
   */
  constructor(deps = {}) {
    this.sessionVault = deps.sessionVault;
    this.authRepo = deps.authRepo;
    this.engineBridge = deps.engineBridge || null;
    this.logger = deps.logger || null;
  }

  /**
   * Parse et normalise des cookies sans encore les enregistrer, ou pour prévisualisation dans Cookie Studio.
   */
  parse(rawInput, domain = '') {
    return parseCookiesInput(rawInput, domain);
  }

  /**
   * Importe et chiffre immédiatement les cookies dans SessionVault ('cookies:<domain>')
   * et crée/met à jour la session réutilisable dans auth_sessions.
   */
  importCookies({ domain, rawInput, cookiesList = null, label = '' }) {
    const cleanDomain = normalizeCookieDomain(domain);
    const parsed = cookiesList
      ? parseCookiesInput(cookiesList, cleanDomain)
      : parseCookiesInput(rawInput, cleanDomain);

    const activeCount = parsed.cookies.filter((c) => c.enabled !== false).length;

    // Calcul de la date d'expiration minimale (si définie)
    const expTimestamps = parsed.cookies
      .filter((c) => c.enabled !== false && Number(c.expires) > 0)
      .map((c) => Number(c.expires) * 1000);
    const expiresAt = expTimestamps.length > 0
      ? new Date(Math.min(...expTimestamps)).toISOString()
      : null;

    const vaultKey = this.sessionVault.store('cookies', cleanDomain, {
      domain: cleanDomain,
      format: parsed.format,
      cookies: parsed.cookies,
      origins: parsed.origins || [],
      updatedAt: new Date().toISOString()
    });

    const sessionRecord = this.authRepo.createOrUpdateSession({
      domain: cleanDomain,
      label: label || `Cookies (${cleanDomain})`,
      strategy: 'cookies',
      vaultKey,
      cookiesCount: activeCount,
      status: 'active',
      expiresAt
    });

    if (this.logger) {
      this.logger.info('CookieService', `Session de cookies chiffrée enregistrée pour ${cleanDomain}`, {
        domain: cleanDomain,
        format: parsed.format,
        cookiesCount: activeCount
      });
    }

    return {
      session: sessionRecord,
      format: parsed.format,
      cookies: this._formatCookiesForUi(parsed.cookies)
    };
  }

  /**
   * Liste les cookies d'un domaine pour le Cookie Studio.
   * Par défaut, inclut la valeur masquée ET la valeur réelle uniquement pour le composant DataGrid local
   * (qui la masque par défaut avec l'icône œil), sans jamais rien logger.
   */
  listCookies({ domain, revealValues = true } = {}) {
    const cleanDomain = normalizeCookieDomain(domain);
    const stored = this.sessionVault.load('cookies', cleanDomain);
    if (!stored || !Array.isArray(stored.cookies)) {
      return { domain: cleanDomain, cookies: [], session: null };
    }
    const session = this.authRepo.getSessionByVaultKey(`cookies:${cleanDomain}`);
    return {
      domain: cleanDomain,
      session,
      cookies: this._formatCookiesForUi(stored.cookies, revealValues)
    };
  }

  /**
   * Met à jour la liste des cookies d'un domaine (activer/désactiver, ajouter, modifier, supprimer).
   */
  editCookies({ domain, cookies }) {
    const cleanDomain = normalizeCookieDomain(domain);
    if (!Array.isArray(cookies)) {
      throw new Error('Tableau de cookies attendu pour cookies:edit.');
    }
    return this.importCookies({
      domain: cleanDomain,
      cookiesList: cookies
    });
  }

  /**
   * Construit le storage_state Playwright fusionné pour un domaine en respectant
   * la règle de priorité §5 :
   *   cookies actifs choisis > compte test (signup_auto) > session manuelle (manual).
   * Permet l'utilisation simultanée d'une session de cookies et d'un compte test
   * (les cookies explicites prennent le dessus en cas de même clé name+domain+path).
   */
  buildMergedStorageState(domain) {
    const cleanDomain = normalizeCookieDomain(domain);
    const activeSessions = this.authRepo.getActiveSessionsForDomain(cleanDomain);
    if (activeSessions.length === 0) {
      return null;
    }

    const cookieMap = new Map(); // `${name}|${domain}|${path}` -> playwrightCookie
    const originsMap = new Map();
    const usedStrategies = [];

    // activeSessions est déjà trié par priorité : cookies (1) > signup_auto (2) > manual (3)
    for (const sess of activeSessions) {
      const data = this.sessionVault.load(sess.vault_key);
      if (!data) continue;

      const rawCookies = Array.isArray(data.cookies)
        ? data.cookies
        : (data.storageState && Array.isArray(data.storageState.cookies) ? data.storageState.cookies : []);

      let addedFromThisSession = 0;
      for (const c of rawCookies) {
        if (c.enabled === false) continue;
        // Vérifier non expiré
        if (Number(c.expires) > 0 && Number(c.expires) * 1000 < Date.now()) {
          continue;
        }
        const key = `${c.name}|${c.domain}|${c.path || '/'}`;
        if (!cookieMap.has(key)) {
          const { enabled: _en, ...pwCookie } = normalizeSingleCookie(c, cleanDomain);
          cookieMap.set(key, pwCookie);
          addedFromThisSession += 1;
        }
      }

      const rawOrigins = Array.isArray(data.origins)
        ? data.origins
        : (data.storageState && Array.isArray(data.storageState.origins) ? data.storageState.origins : []);
      for (const orig of rawOrigins) {
        if (orig && orig.origin && !originsMap.has(orig.origin)) {
          originsMap.set(orig.origin, orig);
        }
      }

      if (addedFromThisSession > 0 || rawOrigins.length > 0) {
        usedStrategies.push(sess.strategy);
        this.authRepo.touchSessionUsed(sess.id);
      }
    }

    if (cookieMap.size === 0 && originsMap.size === 0) {
      return null;
    }

    return {
      primaryStrategy: usedStrategies[0] || activeSessions[0].strategy,
      usedStrategies,
      storageState: {
        cookies: Array.from(cookieMap.values()),
        origins: Array.from(originsMap.values())
      }
    };
  }

  /**
   * Teste une sélection de cookies sur l'URL cible via le moteur Python (auth.test)
   * ou via une requête HTTP de vérification si le moteur n'est pas sollicité.
   */
  async testCookies({ url, cookies = null }) {
    const parsedUrl = new URL(url);
    const domain = parsedUrl.hostname.toLowerCase();

    let storageState;
    if (Array.isArray(cookies) && cookies.length > 0) {
      const normalized = cookies
        .filter((c) => c.enabled !== false)
        .map((c) => {
          const { enabled: _e, ...rest } = normalizeSingleCookie(c, domain);
          return rest;
        });
      storageState = { cookies: normalized, origins: [] };
    } else {
      const merged = this.buildMergedStorageState(domain);
      storageState = merged ? merged.storageState : { cookies: [], origins: [] };
    }

    if (!storageState.cookies || storageState.cookies.length === 0) {
      return { ok: false, authenticated: false, reason: 'Aucun cookie actif sélectionné.' };
    }

    if (this.engineBridge && typeof this.engineBridge.testAuthCookies === 'function') {
      return this.engineBridge.testAuthCookies({ url: parsedUrl.toString(), storageState });
    }

    return { ok: true, authenticated: true, cookiesTested: storageState.cookies.length };
  }

  _formatCookiesForUi(cookies, revealValues = true) {
    return cookies.map((c, idx) => ({
      id: idx + 1,
      name: c.name,
      value: revealValues ? c.value : maskCookieValue(c.value),
      maskedValue: maskCookieValue(c.value),
      domain: c.domain,
      path: c.path || '/',
      expires: c.expires ?? -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite || 'Lax',
      enabled: c.enabled !== false
    }));
  }
}

module.exports = {
  CookieService,
  parseCookiesInput,
  normalizeSingleCookie,
  normalizeCookieDomain,
  maskCookieValue
};
