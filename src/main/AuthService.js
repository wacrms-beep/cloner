/**
 * AuthService (src/main/AuthService.js) — Modules 1B & 1C :
 * Orchestre côté Node.js :
 * - Les comptes tests (test_accounts) : génération de mot de passe cryptographique 20 caractères,
 *   chiffrement safeStorage dans SessionVault, rate-limit local (max 3 créations de comptes / jour
 *   toutes cibles confondues, réglable), limite de 1 compte par domaine.
 * - La résolution des sessions d'authentification (auth_sessions) avec priorité :
 *   cookies actifs choisis > compte test (signup_auto) > session manuelle (manual).
 * - Le pont entre l'événement Python `auth.need_verification` et `GmailService.waitForVerification`,
 *   renvoyant `auth.verification_result` ou `auth.verification_timeout` au moteur Python.
 */
const crypto = require('node:crypto');
const { normalizeCookieDomain } = require('./CookieService');

const PASSWORD_LOWER = 'abcdefghijkmnopqrstuvwxyz';
const PASSWORD_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PASSWORD_DIGITS = '23456789';
const PASSWORD_SYMBOLS = '!@#$%^&*_-+=';
const PASSWORD_ALL = PASSWORD_LOWER + PASSWORD_UPPER + PASSWORD_DIGITS + PASSWORD_SYMBOLS;

/**
 * Génère un mot de passe aléatoire cryptographique de 20 caractères (par défaut)
 * garantissant au moins 2 minuscules, 2 majuscules, 2 chiffres et 2 symboles (§2).
 */
function generateCryptographicPassword(length = 20) {
  const targetLen = Math.max(12, Math.min(64, Number(length) || 20));
  const pick = (alphabet) => alphabet[crypto.randomInt(0, alphabet.length)];

  const chars = [
    pick(PASSWORD_LOWER),
    pick(PASSWORD_LOWER),
    pick(PASSWORD_UPPER),
    pick(PASSWORD_UPPER),
    pick(PASSWORD_DIGITS),
    pick(PASSWORD_DIGITS),
    pick(PASSWORD_SYMBOLS),
    pick(PASSWORD_SYMBOLS)
  ];

  while (chars.length < targetLen) {
    chars.push(pick(PASSWORD_ALL));
  }

  // Mélange de Fisher-Yates cryptographique
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }

  return chars.join('');
}

/**
 * Génère un pseudo test clairement fictif (ex: clone_ab12) (§3.3).
 */
function generateFictionalUsername() {
  const suffix = crypto.randomBytes(2).toString('hex').toLowerCase();
  return `clone_${suffix}`;
}

class AuthService {
  /**
   * @param {object} deps
   * @param {import('./SessionVault').SessionVault} deps.sessionVault
   * @param {import('./db/repositories/AuthRepository').AuthRepository} deps.authRepo
   * @param {import('./GmailService').GmailService} deps.gmailService
   * @param {import('./CookieService').CookieService} deps.cookieService
   * @param {import('./SettingsService').SettingsService} deps.settingsService
   * @param {import('./LicenseManager').LicenseManager} deps.licenseManager
   * @param {import('./Logger').Logger} [deps.logger]
   */
  constructor(deps = {}) {
    this.sessionVault = deps.sessionVault;
    this.authRepo = deps.authRepo;
    this.gmailService = deps.gmailService;
    this.cookieService = deps.cookieService;
    this.settingsService = deps.settingsService;
    this.licenseManager = deps.licenseManager;
    this.logger = deps.logger || null;
  }

  /**
   * Vérifie le rate-limit local (§7 : max 3 créations de comptes par jour toutes cibles confondues, réglable).
   */
  checkDailyAccountRateLimit() {
    const settings = this.settingsService ? this.settingsService.getAll() : {};
    const maxPerDay = Math.max(1, Number(settings.maxAccountsPerDay) || 3);
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const createdLast24h = this.authRepo.countAccountsCreatedSince(sinceIso);
    if (createdLast24h >= maxPerDay) {
      throw new Error(
        `Limite quotidienne atteinte (${createdLast24h}/${maxPerDay} comptes tests créés en 24h). Ajustable dans Réglages.`
      );
    }
    return { createdLast24h, maxPerDay };
  }

  /**
   * Prépare ou récupère les identifiants d'inscription automatique pour un domaine (§2 & §3) :
   * - Limite codée : 1 compte par domaine (si un compte test existe déjà pour ce domaine, on le réutilise
   *   ou on prépare la création si aucun n'existe).
   * - Génère un alias plus-addressing, un pseudo `clone_xxxx`, un mot de passe cryptographique 20 caractères,
   *   et chiffre le mot de passe via SessionVault.
   */
  prepareSignupCredentials(domain, options = {}) {
    const cleanDomain = normalizeCookieDomain(domain);
    const existing = this.authRepo.getAccountByDomain(cleanDomain);
    if (existing && !options.forceNew) {
      const decryptedPassword = this.sessionVault.decryptString(existing.password_enc);
      return {
        reused: true,
        accountId: existing.id,
        domain: cleanDomain,
        alias: existing.email_alias,
        username: existing.username,
        password: decryptedPassword
      };
    }

    this.checkDailyAccountRateLimit();

    const alias = options.customAlias || this.gmailService.buildPlusAlias(cleanDomain);
    const username = generateFictionalUsername();
    const password = generateCryptographicPassword(20);
    const passwordEnc = this.sessionVault.encryptString(password);

    const created = this.authRepo.createTestAccount({
      domain: cleanDomain,
      emailAlias: alias,
      username,
      passwordEnc,
      verified: 0,
      notes: 'Créé par SignupFlow (Module 1C)'
    });

    if (this.logger) {
      this.logger.info('AuthService', `Compte test préparé pour ${cleanDomain}`, {
        domain: cleanDomain,
        username
      });
    }

    return {
      reused: false,
      accountId: created.id,
      domain: cleanDomain,
      alias,
      username,
      password
    };
  }

  /**
   * Enregistre un storage_state Playwright issu de Python (signup_auto, manual ou cookies)
   * dans SessionVault et met à jour auth_sessions + test_accounts.
   */
  saveAcquiredSession({ domain, strategy = 'signup_auto', storageState, accountId = null, verified = true }) {
    const cleanDomain = normalizeCookieDomain(domain);
    const cleanStrategy = ['signup_auto', 'cookies', 'manual'].includes(strategy) ? strategy : 'manual';
    const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];
    const origins = Array.isArray(storageState?.origins) ? storageState.origins : [];

    const vaultKey = this.sessionVault.store(cleanStrategy, cleanDomain, {
      domain: cleanDomain,
      strategy: cleanStrategy,
      cookies,
      origins,
      updatedAt: new Date().toISOString()
    });

    const sessionRecord = this.authRepo.createOrUpdateSession({
      domain: cleanDomain,
      label: `${cleanStrategy.toUpperCase()} (${cleanDomain})`,
      strategy: cleanStrategy,
      vaultKey,
      cookiesCount: cookies.length,
      status: 'active'
    });

    const targetAcc = accountId
      ? this.authRepo.getAccountById(accountId)
      : this.authRepo.getAccountByDomain(cleanDomain);

    if (targetAcc && cleanStrategy === 'signup_auto') {
      this.authRepo.updateAccountVerified(targetAcc.id, {
        verified: verified ? 1 : 0,
        sessionId: sessionRecord.id
      });
    }

    return sessionRecord;
  }

  /**
   * Liste les comptes tests pour l'interface Réglages > Comptes tests.
   * Par défaut, ne renvoie JAMAIS le mot de passe en clair.
   */
  listTestAccounts() {
    const rows = this.authRepo.listAccounts();
    return rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      emailAlias: r.email_alias,
      username: r.username,
      createdAt: r.created_at,
      verified: Boolean(r.verified),
      sessionId: r.session_id,
      notes: r.notes
    }));
  }

  /**
   * Déchiffre et retourne le mot de passe d'un compte test uniquement sur confirmation explicite de l'utilisateur (§6).
   */
  revealAccountPassword(id, confirmed = false) {
    if (confirmed !== true) {
      throw new Error('Confirmation explicite requise pour afficher le mot de passe.');
    }
    const acc = this.authRepo.getAccountById(Number(id));
    if (!acc) {
      throw new Error('Compte test introuvable.');
    }
    const password = this.sessionVault.decryptString(acc.password_enc);
    return { id: acc.id, domain: acc.domain, username: acc.username, password };
  }

  /**
   * Supprime un compte test et sa session associée dans le coffre-fort.
   */
  deleteTestAccount(id) {
    const acc = this.authRepo.getAccountById(Number(id));
    if (!acc) return { deleted: false };
    if (acc.session_id) {
      const sess = this.authRepo.getSessionById(acc.session_id);
      if (sess) {
        this.sessionVault.remove(sess.vault_key);
        this.authRepo.deleteSession(sess.id);
      }
    }
    this.sessionVault.remove('signup_auto', acc.domain);
    const deleted = this.authRepo.deleteAccount(Number(id));
    return { deleted };
  }

  /**
   * Liste toutes les sessions d'authentification enregistrées (Réglages > Sessions 1B/1C).
   */
  listSessions(domain = null) {
    return this.authRepo.listSessions(domain);
  }

  /**
   * Supprime une session d'authentification et son fichier chiffré dans SessionVault.
   */
  deleteSession(id) {
    const sess = this.authRepo.getSessionById(Number(id));
    if (!sess) return { deleted: false };
    this.sessionVault.remove(sess.vault_key);
    const deleted = this.authRepo.deleteSession(Number(id));
    return { deleted };
  }
}

module.exports = {
  AuthService,
  generateCryptographicPassword,
  generateFictionalUsername
};
