/**
 * Tests unitaires Node.js pour IpcRouter (validation d'URL, validation des options,
 * garde de licence et routage des canaux).
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
const { LicenseManager } = require('../src/main/LicenseManager');
const { SettingsService } = require('../src/main/SettingsService');
const { ProjectFileService } = require('../src/main/ProjectFileService');
const { DataStudioService } = require('../src/main/DataStudioService');
const { IpcRouter, validateCloneUrl, validateCloneOptions } = require('../src/main/IpcRouter');

describe('IpcRouter & Validation', () => {
  let tmpDir;
  let db;
  let router;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uclone-ipc-test-'));
    const dbPath = path.join(tmpDir, 'app.sqlite');
    db = new AppDatabase(dbPath).init();

    const settingsRepo = new SettingsRepository(db);
    const cloneRepo = new CloneRepository(db);
    const pageRepo = new PageRepository(db);
    const endpointRepo = new EndpointRepository(db);
    const logRepo = new LogRepository(db);

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

    const fakeEngineBridge = {
      getStatus: () => ({ state: 'ready', version: '1.0.0', activeCloneId: null, queueLength: 0 }),
      ping: async () => ({ ok: true, latencyMs: 2, state: 'ready' }),
      enqueueClone: async ({ url, options }) => cloneRepo.create({ url, domain: new URL(url).hostname, status: 'queued', options }),
      pauseActiveClone: async () => ({ ok: true, status: 'paused' }),
      resumeActiveClone: async () => ({ ok: true, status: 'running' }),
      cancelClone: async (id) => ({ ok: true, cloneId: id, status: 'cancelled' })
    };

    router = new IpcRouter({
      ipcMain: null,
      dialog: null,
      shell: null,
      windowManager: { getMainWindow: () => null },
      settingsService,
      licenseManager,
      engineBridge: fakeEngineBridge,
      cloneRepo,
      pageRepo,
      endpointRepo,
      logRepo,
      projectFileService,
      previewServer: { start: async () => ({ url: 'http://127.0.0.1:4321/' }) },
      dataStudioService
    });
    router.registerAll();
  });

  afterEach(() => {
    if (router && router.dataStudioService) router.dataStudioService.close();
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('valide les URLs (accepte https public, refuse file://, javascript:, localhost et IP privées)', () => {
    assert.equal(validateCloneUrl('https://quotes.toscrape.com'), 'https://quotes.toscrape.com/');
    assert.throws(() => validateCloneUrl('ftp://example.com'), /protocoles http/);
    assert.throws(() => validateCloneUrl('javascript:alert(1)'), /protocoles http/);
    assert.throws(() => validateCloneUrl('http://localhost:8080'), /locales ou privées/);
    assert.throws(() => validateCloneUrl('http://127.0.0.1/admin'), /locales ou privées/);
    assert.throws(() => validateCloneUrl('http://192.168.1.10/'), /locales ou privées/);
    assert.equal(validateCloneUrl('http://127.0.0.1:8080/test', true), 'http://127.0.0.1:8080/test');
  });

  it('valide et borne les options de clonage', () => {
    const clean = validateCloneOptions({
      max_depth: 99,
      max_pages: 5000,
      viewport: '1440x900',
      wait_strategy: 'networkidle',
      respect_robots: true
    });
    assert.equal(clean.max_depth, 10);
    assert.equal(clean.max_pages, 1000);
    assert.throws(() => validateCloneOptions({ viewport: 'invalid' }), /viewport invalide/);
    assert.throws(() => validateCloneOptions({ wait_strategy: 'hack' }), /Stratégie d'attente/);
  });

  it('gère legal:status, legal:accept, license:status, modules:list et clone:start', async () => {
    const st0 = await router.invoke('legal:status');
    assert.equal(st0.acceptance, null);

    await assert.rejects(() => router.invoke('legal:accept', { confirmed: false }), /confirmer/);
    const st1 = await router.invoke('legal:accept', { confirmed: true });
    assert.ok(st1.acceptance.accepted_at);

    const lic = await router.invoke('license:status');
    assert.equal(lic.status, 'valid');
    assert.equal(lic.plan, 'full');

    const mods = await router.invoke('modules:list');
    assert.equal(mods.length, 3);
    assert.equal(mods[0].name, 'web_clone');

    const created = await router.invoke('clone:start', {
      url: 'https://example.com',
      options: { max_depth: 1, max_pages: 5 }
    });
    assert.equal(created.domain, 'example.com');
    assert.equal(created.status, 'queued');
  });
});
