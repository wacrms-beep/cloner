/**
 * Tests unitaires Node.js pour la Phase 1 du Module 1C :
 * - Migration 003 (gmail_state, test_accounts, clones.acquire_strategy) + Migration 002 (auth_sessions)
 * - SessionVault (chiffrement safeStorage / repli AES-256-GCM, zéro secret en clair sur disque)
 * - GmailService avec API Gmail simulée :
 *   - Flux OAuth2 loopback + PKCE (scope gmail.readonly)
 *   - Extraction lien de vérification (domaine cible valide)
 *   - Rejet strict d'un lien de vérification pointant vers un domaine étranger + alerte
 *   - Extraction code numérique 4-8 chiffres
 *   - Aucun stockage du contenu du mail, de l'expéditeur ni des pièces jointes en base ou dans le coffre
 *   - Gestion de l'expiration 7 jours (mode Test) et révocation (disconnect)
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { AppDatabase } = require('../src/main/db/Database');
const { SettingsRepository } = require('../src/main/db/repositories/SettingsRepository');
const { CloneRepository } = require('../src/main/db/repositories/CloneRepository');
const { AuthRepository } = require('../src/main/db/repositories/AuthRepository');
const { SettingsService } = require('../src/main/SettingsService');
const { SessionVault } = require('../src/main/SessionVault');
const {
  GmailService,
  GMAIL_READONLY_SCOPE,
  extractVerificationFromText,
  isSameTargetDomain
} = require('../src/main/GmailService');

function toBase64Url(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}

describe('Phase 1 — Migration 003, SessionVault & GmailService', () => {
  let tmpDir;
  let dbPath;
  let vaultDir;
  let db;
  let authRepo;
  let settingsService;
  let vault;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uclone-gmail-test-'));
    dbPath = path.join(tmpDir, 'app.sqlite');
    vaultDir = path.join(tmpDir, 'vault');
    db = new AppDatabase(dbPath).init();

    const settingsRepo = new SettingsRepository(db);
    authRepo = new AuthRepository(db);
    settingsService = new SettingsService(settingsRepo, {
      rootDir: tmpDir,
      defaultOutputDir: path.join(tmpDir, 'output')
    });
    vault = new SessionVault({ vaultDir });
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applique la migration 003_acquisition.sql (gmail_state, test_accounts, clones.acquire_strategy)', () => {
    const mig3 = db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get();
    assert.ok(mig3);
    assert.equal(mig3.version, 3);

    const gState = authRepo.getGmailState();
    assert.equal(gState.status, 'disconnected');

    const cloneRepo = new CloneRepository(db);
    const c = cloneRepo.create({
      url: 'https://example.com',
      domain: 'example.com',
      acquireStrategy: 'signup_auto'
    });
    assert.equal(c.acquire_strategy, 'signup_auto');

    // Priorité des sessions : cookies > signup_auto > manual
    authRepo.createOrUpdateSession({
      domain: 'example.com',
      strategy: 'manual',
      vaultKey: 'manual:example.com',
      cookiesCount: 1
    });
    authRepo.createOrUpdateSession({
      domain: 'example.com',
      strategy: 'signup_auto',
      vaultKey: 'signup_auto:example.com',
      cookiesCount: 2
    });
    authRepo.createOrUpdateSession({
      domain: 'example.com',
      strategy: 'cookies',
      vaultKey: 'cookies:example.com',
      cookiesCount: 3
    });

    const ordered = authRepo.getActiveSessionsForDomain('example.com');
    assert.equal(ordered.length, 3);
    assert.equal(ordered[0].strategy, 'cookies');
    assert.equal(ordered[1].strategy, 'signup_auto');
    assert.equal(ordered[2].strategy, 'manual');
  });

  it('chiffre les tokens et mots de passe dans SessionVault sans jamais écrire de secret en clair sur disque', () => {
    const secretToken = 'ya29.SUPER_SECRET_ACCESS_TOKEN_998877';
    const secretRefresh = '1//0gSUPER_SECRET_REFRESH_TOKEN_112233';
    vault.store('gmail', 'oauth_tokens', {
      access_token: secretToken,
      refresh_token: secretRefresh
    });

    const files = fs.readdirSync(vaultDir).filter((f) => f.endsWith('.enc'));
    assert.equal(files.length, 1);

    const rawDiskContent = fs.readFileSync(path.join(vaultDir, files[0]), 'utf8');
    assert.equal(rawDiskContent.includes(secretToken), false);
    assert.equal(rawDiskContent.includes(secretRefresh), false);

    const loaded = vault.load('gmail', 'oauth_tokens');
    assert.equal(loaded.access_token, secretToken);
    assert.equal(loaded.refresh_token, secretRefresh);

    // Test avec un mock safeStorage Electron
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s.split('').reverse().join(''), 'utf8'),
      decryptString: (b) => b.toString('utf8').split('').reverse().join('')
    };
    const ssVault = new SessionVault({ vaultDir: path.join(tmpDir, 'ssvault'), safeStorage: fakeSafeStorage });
    const encPwd = ssVault.encryptString('MonMotDePasseSecret!2026');
    assert.ok(encPwd.startsWith('ss1:'));
    assert.equal(encPwd.includes('MonMotDePasseSecret'), false);
    assert.equal(ssVault.decryptString(encPwd), 'MonMotDePasseSecret!2026');
  });

  it('exécute le flux OAuth loopback PKCE, connecte Gmail, génère un alias plus-addressing et déconnecte', async () => {
    let revokedToken = null;
    const fakeFetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'access_tok_xyz',
            refresh_token: 'refresh_tok_xyz',
            expires_in: 3600,
            token_type: 'Bearer'
          })
        };
      }
      if (u.includes('/users/me/profile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ emailAddress: 'jean.dupont@gmail.com' })
        };
      }
      if (u.includes('oauth2.googleapis.com/revoke')) {
        revokedToken = new URL(u).searchParams.get('token');
        return { ok: true, status: 200, json: async () => ({}) };
      }
      throw new Error(`URL inattendue: ${u}`);
    };

    const gmail = new GmailService({
      sessionVault: vault,
      authRepo,
      settingsService,
      fetchFn: fakeFetch
    });

    const connected = await gmail.connect({
      clientId: '123456-test.apps.googleusercontent.com',
      onAuthUrlReady: (authUrl) => {
        const parsedAuth = new URL(authUrl);
        assert.equal(parsedAuth.searchParams.get('scope'), GMAIL_READONLY_SCOPE);
        assert.equal(parsedAuth.searchParams.get('code_challenge_method'), 'S256');
        const redirectUri = parsedAuth.searchParams.get('redirect_uri');
        const state = parsedAuth.searchParams.get('state');
        // Simuler le callback loopback du navigateur vers 127.0.0.1
        http.get(`${redirectUri}?code=fake_oauth_code_123&state=${state}`);
      }
    });

    assert.equal(connected.status, 'connected');
    assert.equal(connected.email, 'jean.dupont@gmail.com');
    assert.equal(connected.scope, GMAIL_READONLY_SCOPE);

    // Génération de l'alias plus-addressing
    const alias = gmail.buildPlusAlias('app.demo-site.com');
    assert.equal(alias, 'jean.dupont+app-demo-site-com@gmail.com');

    // Vérifier qu'aucun token n'est dans SQLite
    const dbDump = fs.readFileSync(dbPath, 'latin1');
    assert.equal(dbDump.includes('access_tok_xyz'), false);
    assert.equal(dbDump.includes('refresh_tok_xyz'), false);

    // Déconnexion + révocation + suppression du fichier chiffré
    const afterDisc = await gmail.disconnect();
    assert.equal(afterDisc.status, 'disconnected');
    assert.equal(revokedToken, 'refresh_tok_xyz');
    assert.equal(vault.exists('gmail', 'oauth_tokens'), false);
  });

  it('extrait uniquement le lien de vérification du domaine cible, rejette les domaines étrangers et ne stocke jamais le mail', async () => {
    vault.store('gmail', 'oauth_tokens', {
      access_token: 'valid_token',
      refresh_token: 'valid_refresh',
      expiry_date: Date.now() + 3600000
    });
    authRepo.saveGmailState({
      email: 'alice@gmail.com',
      status: 'connected',
      connectedAt: new Date().toISOString(),
      expiresHint: new Date(Date.now() + 5 * 86400000).toISOString()
    });

    const alerts = [];
    const secretMailBodySentence = 'Ceci est un paragraphe confidentiel dans le corps du mail qui ne doit JAMAIS etre stocke.';

    const fakeFetch = async (url) => {
      const u = String(url);
      if (u.includes('/users/me/messages?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: 'msg_foreign' }, { id: 'msg_valid' }] })
        };
      }
      if (u.includes('/users/me/messages/msg_foreign')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'msg_foreign',
            internalDate: String(Date.now()),
            payload: {
              headers: [{ name: 'To', value: 'alice+monsite-fr@gmail.com' }],
              mimeType: 'text/html',
              body: {
                data: toBase64Url(
                  `<p>${secretMailBodySentence}</p><a href="https://phishing-evil.org/verify?token=999">Activer</a>`
                )
              }
            }
          })
        };
      }
      if (u.includes('/users/me/messages/msg_valid')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'msg_valid',
            internalDate: String(Date.now()),
            payload: {
              headers: [
                { name: 'From', value: 'Support Secret <noreply@monsite.fr>' },
                { name: 'To', value: 'alice+monsite-fr@gmail.com' }
              ],
              parts: [
                {
                  mimeType: 'text/html',
                  body: {
                    data: toBase64Url(
                      `<p>${secretMailBodySentence}</p><a href="https://sub.monsite.fr/auth/verify?token=abc123xyz">Confirmer</a>`
                    )
                  }
                },
                {
                  filename: 'piece_jointe_secrete.pdf',
                  mimeType: 'application/pdf',
                  body: { attachmentId: 'att_1', data: toBase64Url('https://sub.monsite.fr/verify?token=WRONG_FROM_ATTACHMENT') }
                }
              ]
            }
          })
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const gmail = new GmailService({
      sessionVault: vault,
      authRepo,
      settingsService,
      fetchFn: fakeFetch,
      pollIntervalMs: 50,
      onAlert: (a) => alerts.push(a)
    });

    const res = await gmail.waitForVerification({
      fromDomain: 'monsite.fr',
      toAlias: 'alice+monsite-fr@gmail.com',
      timeoutMs: 3000
    });

    assert.equal(res.found, true);
    assert.equal(res.kind, 'link');
    assert.equal(res.value, 'https://sub.monsite.fr/auth/verify?token=abc123xyz');

    // Le lien étranger phishing-evil.org a bien déclenché une alerte et a été rejeté
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, 'gmail:foreign_link_blocked');
    assert.ok(alerts[0].foreignHosts.includes('phishing-evil.org'));

    // Aucun contenu du mail ni pièce jointe n'est stocké dans SQLite ou dans le dossier temporaire
    const dbContent = fs.readFileSync(dbPath, 'utf8');
    assert.equal(dbContent.includes(secretMailBodySentence), false);
    assert.equal(dbContent.includes('Support Secret'), false);
    assert.equal(dbContent.includes('piece_jointe_secrete'), false);
  });

  it('extrait un code numérique 4-8 chiffres et détecte l’expiration à 7 jours en mode Test', () => {
    const codeRes = extractVerificationFromText(
      'Bonjour, votre code de vérification est : 482910. Merci.',
      'example.com'
    );
    assert.equal(codeRes.kind, 'code');
    assert.equal(codeRes.value, '482910');

    assert.equal(isSameTargetDomain('https://auth.example.com/verify?t=1', 'example.com'), true);
    assert.equal(isSameTargetDomain('https://attacker.com/verify?t=1', 'example.com'), false);

    // Simuler une connexion dont expires_hint est dépassé (> 7 jours)
    authRepo.saveGmailState({
      email: 'test@gmail.com',
      status: 'connected',
      connectedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      expiresHint: new Date(Date.now() - 1000).toISOString()
    });
    vault.store('gmail', 'oauth_tokens', { access_token: 'old' });

    const gmail = new GmailService({ sessionVault: vault, authRepo, settingsService });
    const st = gmail.status();
    assert.equal(st.status, 'expired');
    assert.ok(st.reconnectAlert.includes('Gmail à reconnecter'));
  });
});
