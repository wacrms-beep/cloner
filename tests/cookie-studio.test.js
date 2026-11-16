/**
 * Tests unitaires Node.js pour la Phase 2 du Module 1C :
 * - CookieService : parsing et normalisation des 4 formats vers le format Playwright :
 *   (1) JSON export d'extensions (EditThisCookie / Cookie-Editor)
 *   (2) storage_state Playwright
 *   (3) En-tête brut "Cookie: a=b; c=d"
 *   (4) Format Netscape cookies.txt (avec #HttpOnly_)
 * - Édition, activation/désactivation (enabled), chiffrement dans SessionVault (zéro valeur en clair en base/logs)
 * - Priorité et combinaison multi-sessions : cookies > compte test (signup_auto) > session manuelle (manual)
 * - Validation IPC sur les canaux gmail:*, auth:* et cookies:*
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../src/main/db/Database');
const { SettingsRepository } = require('../src/main/db/repositories/SettingsRepository');
const { CloneRepository } = require('../src/main/db/repositories/CloneRepository');
const { PageRepository } = require('../src/main/db/repositories/PageRepository');
const { EndpointRepository } = require('../src/main/db/repositories/EndpointRepository');
const { LogRepository } = require('../src/main/db/repositories/LogRepository');
const { AuthRepository } = require('../src/main/db/repositories/AuthRepository');
const { LicenseManager } = require('../src/main/LicenseManager');
const { SettingsService } = require('../src/main/SettingsService');
const { ProjectFileService } = require('../src/main/ProjectFileService');
const { DataStudioService } = require('../src/main/DataStudioService');
const { SessionVault } = require('../src/main/SessionVault');
const { GmailService } = require('../src/main/GmailService');
const { CookieService } = require('../src/main/CookieService');
const { AuthService } = require('../src/main/AuthService');
const { IpcRouter } = require('../src/main/IpcRouter');

describe('Phase 2 — CookieService (4 formats, chiffrement, priorité) & Validation IPC', () => {
  let tmpDir;
  let dbPath;
  let db;
  let vault;
  let authRepo;
  let cookieService;
  let authService;
  let router;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uclone-cookie-test-'));
    dbPath = path.join(tmpDir, 'app.sqlite');
    db = new AppDatabase(dbPath).init();

    const settingsRepo = new SettingsRepository(db);
    const cloneRepo = new CloneRepository(db);
    const pageRepo = new PageRepository(db);
    const endpointRepo = new EndpointRepository(db);
    const logRepo = new LogRepository(db);
    authRepo = new AuthRepository(db);

    const licenseManager = new LicenseManager(settingsRepo);
    const settingsService = new SettingsService(settingsRepo, {
      rootDir: tmpDir,
      defaultOutputDir: path.join(tmpDir, 'output')
    });
    const projectFileService = new ProjectFileService(settingsService);
    const dataStudioService = new DataStudioService({
      appDbPath: dbPath,
      backupsDir: path.join(tmpDir, 'backups')
    });

    vault = new SessionVault({ vaultDir: path.join(tmpDir, 'vault') });
    const gmailService = new GmailService({ sessionVault: vault, authRepo, settingsService });
    cookieService = new CookieService({ sessionVault: vault, authRepo });
    authService = new AuthService({
      sessionVault: vault,
      authRepo,
      gmailService,
      cookieService,
      settingsService,
      licenseManager
    });

    router = new IpcRouter({
      ipcMain: null,
      dialog: null,
      shell: null,
      windowManager: { getMainWindow: () => null },
      settingsService,
      licenseManager,
      engineBridge: {
        getStatus: () => ({ state: 'ready' }),
        acquireAuthSession: async (p) => ({ ok: true, ...p }),
        resumeAuthSession: async (p) => ({ ok: true, ...p }),
        cancelAuthSession: async (id) => ({ ok: true, cloneId: id })
      },
      cloneRepo,
      pageRepo,
      endpointRepo,
      logRepo,
      projectFileService,
      previewServer: { start: async () => ({ url: 'http://127.0.0.1:4000/' }) },
      dataStudioService,
      gmailService,
      cookieService,
      authService
    });
    router.registerAll();
  });

  afterEach(() => {
    if (router && router.dataStudioService) router.dataStudioService.close();
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parse et normalise les 4 formats de cookies vers le format Playwright', () => {
    // 1. Export JSON EditThisCookie / Cookie-Editor
    const extJson = JSON.stringify([
      {
        domain: '.app.example.com',
        expirationDate: 1950000000.45,
        hostOnly: false,
        httpOnly: true,
        name: 'sid_ext',
        path: '/',
        sameSite: 'no_restriction',
        secure: true,
        value: 'val_ext_123456'
      }
    ]);
    const p1 = cookieService.parse(extJson);
    assert.equal(p1.format, 'extension_json');
    assert.equal(p1.cookies.length, 1);
    assert.equal(p1.cookies[0].name, 'sid_ext');
    assert.equal(p1.cookies[0].sameSite, 'None');
    assert.equal(p1.cookies[0].expires, 1950000000);

    // 2. Playwright storage_state
    const pwJson = JSON.stringify({
      cookies: [
        {
          name: 'pw_sess',
          value: 'pw_secret_9876',
          domain: 'app.example.com',
          path: '/dashboard',
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: 'Strict'
        }
      ],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'k', value: 'v' }] }]
    });
    const p2 = cookieService.parse(pwJson);
    assert.equal(p2.format, 'playwright_storage_state');
    assert.equal(p2.cookies[0].name, 'pw_sess');
    assert.equal(p2.cookies[0].sameSite, 'Strict');
    assert.equal(p2.origins.length, 1);

    // 3. En-tête HTTP brut "Cookie: a=b; c=d"
    const rawHeader = 'Cookie: csrf_tok=abc999; session_id=xyz888; theme=light';
    const p3 = cookieService.parse(rawHeader, 'app.example.com');
    assert.equal(p3.format, 'raw_header');
    assert.equal(p3.cookies.length, 3);
    assert.equal(p3.cookies[1].name, 'session_id');
    assert.equal(p3.cookies[1].value, 'xyz888');
    assert.equal(p3.cookies[1].domain, 'app.example.com');

    // 4. Netscape cookies.txt (avec #HttpOnly_)
    const netscapeTxt = [
      '# Netscape HTTP Cookie File',
      '# https://curl.se/docs/http-cookies.html',
      '#HttpOnly_.app.example.com\tTRUE\t/\tTRUE\t1950000000\tnetscape_auth\tnetscape_val_777',
      'app.example.com\tFALSE\t/app\tFALSE\t0\tpref_lang\tfr'
    ].join('\n');
    const p4 = cookieService.parse(netscapeTxt);
    assert.equal(p4.format, 'netscape_txt');
    assert.equal(p4.cookies.length, 2);
    assert.equal(p4.cookies[0].name, 'netscape_auth');
    assert.equal(p4.cookies[0].httpOnly, true);
    assert.equal(p4.cookies[0].secure, true);
    assert.equal(p4.cookies[1].name, 'pref_lang');
  });

  it('chiffre les cookies importés, masque les valeurs par défaut et respecte la priorité cookies > signup_auto > manual', () => {
    const secretCookieVal = 'COOKIE_ULTRA_SECRET_VALUE_2026_XYZ';
    cookieService.importCookies({
      domain: 'portal.example.com',
      rawInput: `Cookie: auth_token=${secretCookieVal}; secondary=cookie_sec`
    });

    // Vérifier qu'aucune valeur de cookie n'apparaît dans la base SQLite
    const dbRaw = fs.readFileSync(dbPath, 'utf8');
    assert.equal(dbRaw.includes(secretCookieVal), false);

    // Ajouter aussi une session signup_auto et une session manual sur le même domaine
    authService.saveAcquiredSession({
      domain: 'portal.example.com',
      strategy: 'signup_auto',
      storageState: {
        cookies: [
          { name: 'auth_token', value: 'FROM_SIGNUP_AUTO_LOWER_PRIORITY', domain: 'portal.example.com', path: '/' },
          { name: 'signup_extra', value: 'EXTRA_FROM_TEST_ACCOUNT', domain: 'portal.example.com', path: '/' }
        ],
        origins: []
      }
    });
    authService.saveAcquiredSession({
      domain: 'portal.example.com',
      strategy: 'manual',
      storageState: {
        cookies: [
          { name: 'auth_token', value: 'FROM_MANUAL_LOWEST_PRIORITY', domain: 'portal.example.com', path: '/' }
        ],
        origins: []
      }
    });

    // Fusion avec priorité : cookies > compte test (signup_auto) > manual
    const merged = cookieService.buildMergedStorageState('portal.example.com');
    assert.ok(merged);
    assert.equal(merged.primaryStrategy, 'cookies');

    const authCookie = merged.storageState.cookies.find((c) => c.name === 'auth_token');
    const extraCookie = merged.storageState.cookies.find((c) => c.name === 'signup_extra');
    assert.equal(authCookie.value, secretCookieVal); // Le cookie choisi par l'utilisateur l'emporte sur signup_auto et manual
    assert.equal(extraCookie.value, 'EXTRA_FROM_TEST_ACCOUNT'); // Utilisation simultanée : les cookies complémentaires du compte test sont conservés
  });

  it('valide les canaux IPC cookies:*, auth:* et applique le rate-limit de 3 comptes/jour', async () => {
    const imp = await router.invoke('cookies:import', {
      domain: 'shop.example.com',
      rawInput: 'Cookie: cart_id=c123; logged_in=yes'
    });
    assert.equal(imp.cookies.length, 2);
    assert.ok(imp.cookies[0].maskedValue.includes('••••'));

    // Désactiver le premier cookie via cookies:edit ("utiliser ces cookies" = cases cochées seulement)
    const edited = await router.invoke('cookies:edit', {
      domain: 'shop.example.com',
      cookies: [
        { ...imp.cookies[0], enabled: false },
        { ...imp.cookies[1], enabled: true }
      ]
    });
    assert.equal(edited.session.cookies_count, 1);

    const mergedAfterEdit = cookieService.buildMergedStorageState('shop.example.com');
    assert.equal(mergedAfterEdit.storageState.cookies.length, 1);
    assert.equal(mergedAfterEdit.storageState.cookies[0].name, 'logged_in');

    // Rate-limit local : max 3 créations de comptes tests par jour toutes cibles confondues
    authService.prepareSignupCredentials('site1.example.com');
    authService.prepareSignupCredentials('site2.example.com');
    authService.prepareSignupCredentials('site3.example.com');
    assert.throws(
      () => authService.prepareSignupCredentials('site4.example.com'),
      /Limite quotidienne atteinte/
    );

    // Vérifier auth:listAccounts et auth:revealPassword
    const accounts = await router.invoke('auth:listAccounts');
    assert.equal(accounts.length, 3);
    assert.equal(accounts[0].password, undefined);

    await assert.rejects(
      () => router.invoke('auth:revealPassword', { id: accounts[0].id, confirmed: false }),
      /Confirmation/
    );
    const revealed = await router.invoke('auth:revealPassword', { id: accounts[0].id, confirmed: true });
    assert.equal(revealed.password.length, 20);
  });
});
