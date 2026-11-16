/**
 * Tests d'intégration d'EngineBridge avec le vrai moteur Python (engine/engine.py) :
 * - Démarrage et réception de l'événement {"type":"ready"}
 * - Test ping/pong
 * - Simulation de crash du processus Python (kill SIGKILL) pendant un job 'running'
 *   -> Vérification que le clone passe en statut 'interrupted' et que le moteur
 *      redémarre automatiquement vers l'état 'ready'.
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
const { EngineBridge } = require('../src/main/EngineBridge');

describe('EngineBridge & Python Engine Integration', () => {
  let tmpDir;
  let db;
  let bridge;
  let cloneRepo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uclone-bridge-test-'));
    const dbPath = path.join(tmpDir, 'app.sqlite');
    db = new AppDatabase(dbPath).init();

    const settingsRepo = new SettingsRepository(db);
    cloneRepo = new CloneRepository(db);
    const pageRepo = new PageRepository(db);
    const endpointRepo = new EndpointRepository(db);
    const logRepo = new LogRepository(db);

    const licenseManager = new LicenseManager(settingsRepo);
    const rootDir = path.resolve(__dirname, '..');
    const settingsService = new SettingsService(settingsRepo, {
      rootDir,
      defaultOutputDir: path.join(tmpDir, 'output')
    });
    const projectFileService = new ProjectFileService(settingsService);

    bridge = new EngineBridge({
      settingsService,
      cloneRepo,
      pageRepo,
      endpointRepo,
      logRepo,
      projectFileService,
      licenseManager
    });
  });

  afterEach(async () => {
    if (bridge) await bridge.shutdown();
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('démarre le moteur Python, reçoit ready, répond à ping et se rétablit après un crash SIGKILL', async () => {
    const st = await bridge.start();
    assert.equal(st.state, 'ready');
    assert.equal(st.version, '1.0.0');
    assert.ok(st.pid > 0);

    const pong = await bridge.ping();
    assert.equal(pong.ok, true);
    assert.ok(pong.latencyMs >= 0);

    // Simuler un clone actif puis tuer brutalement le processus Python
    const dummyClone = cloneRepo.create({
      url: 'https://example.com',
      domain: 'example.com',
      status: 'running',
      options: {}
    });
    bridge.activeCloneId = dummyClone.id;
    const oldPid = bridge.proc.pid;

    const readyAgainPromise = new Promise((resolve) => {
      bridge.once('ready_signal', resolve);
    });

    process.kill(oldPid, 'SIGKILL');

    await readyAgainPromise;
    const updatedClone = cloneRepo.getById(dummyClone.id);
    assert.equal(updatedClone.status, 'interrupted');
    assert.equal(bridge.getStatus().state, 'ready');
    assert.notEqual(bridge.getStatus().pid, oldPid);
  });
});
