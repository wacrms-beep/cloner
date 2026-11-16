/**
 * Point d'entrée principal Electron (src/main/main.js).
 * Initialise la base SQLite dans userData/universal-clone.sqlite,
 * vérifie la licence (guard), démarre le moteur Python en arrière-plan,
 * enregistre l'IpcRouter et ouvre la fenêtre principale.
 */
const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { Logger } = require('./Logger');
const { AppDatabase } = require('./db/Database');
const { SettingsRepository } = require('./db/repositories/SettingsRepository');
const { CloneRepository } = require('./db/repositories/CloneRepository');
const { PageRepository } = require('./db/repositories/PageRepository');
const { EndpointRepository } = require('./db/repositories/EndpointRepository');
const { LogRepository } = require('./db/repositories/LogRepository');
const { LicenseManager } = require('./LicenseManager');
const { SettingsService } = require('./SettingsService');
const { ProjectFileService } = require('./ProjectFileService');
const { PreviewServer } = require('./PreviewServer');
const { DataStudioService } = require('./DataStudioService');
const { EngineBridge } = require('./EngineBridge');
const { WindowManager } = require('./WindowManager');
const { IpcRouter } = require('./IpcRouter');

let logger = null;
let appDb = null;
let engineBridge = null;
let previewServer = null;
let dataStudioService = null;
let windowManager = null;

async function bootstrap() {
  const userDataDir = app.getPath('userData');
  const logsDir = path.join(userDataDir, 'logs');
  const backupsDir = path.join(userDataDir, 'backups');
  const dbPath = path.join(userDataDir, 'universal-clone.sqlite');
  const rootDir = path.resolve(__dirname, '../..');
  const defaultOutputDir = path.join(rootDir, 'output');

  logger = new Logger(logsDir);
  logger.info('Main', 'Démarrage de Universal Clone', { version: app.getVersion(), userDataDir });

  // 1. Base de données SQLite (WAL, foreign_keys=ON, running -> interrupted)
  appDb = new AppDatabase(dbPath).init();
  const settingsRepo = new SettingsRepository(appDb);
  const cloneRepo = new CloneRepository(appDb);
  const pageRepo = new PageRepository(appDb);
  const endpointRepo = new EndpointRepository(appDb);
  const logRepo = new LogRepository(appDb);

  // 2. Licence : porte d'entrée unique au démarrage
  const licenseManager = new LicenseManager(settingsRepo, logger);
  licenseManager.check();
  licenseManager.guard('clone_web');

  // 3. Services métier
  const settingsService = new SettingsService(settingsRepo, { rootDir, defaultOutputDir });
  const projectFileService = new ProjectFileService(settingsService, logger);
  previewServer = new PreviewServer(logger);
  dataStudioService = new DataStudioService({
    appDbPath: dbPath,
    backupsDir,
    logger
  });

  // 4. Fenêtre et moteur Python
  windowManager = new WindowManager(logger);
  engineBridge = new EngineBridge({
    settingsService,
    cloneRepo,
    pageRepo,
    endpointRepo,
    logRepo,
    projectFileService,
    licenseManager,
    logger,
    onRendererBroadcast: (channel, payload) => {
      if (windowManager) {
        windowManager.send(channel, payload);
      }
    }
  });

  // 5. Routeur IPC
  const ipcRouter = new IpcRouter({
    ipcMain,
    dialog,
    shell,
    windowManager,
    settingsService,
    licenseManager,
    engineBridge,
    cloneRepo,
    pageRepo,
    endpointRepo,
    logRepo,
    projectFileService,
    previewServer,
    dataStudioService,
    logger
  });
  ipcRouter.registerAll();

  // 6. Création de la fenêtre principale
  windowManager.createMainWindow();

  // 7. Lancement asynchrone du moteur Python
  engineBridge.start().catch((err) => {
    logger.warn('Main', `Le moteur Python n'a pas pu démarrer immédiatement : ${err.message}`);
  });
}

app.whenReady().then(bootstrap).catch((err) => {
  if (logger) {
    logger.error('Main', `Erreur critique au démarrage : ${err.message}`);
  } else {
    console.error('Erreur critique au démarrage :', err);
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && windowManager) {
    windowManager.createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  try {
    if (previewServer) await previewServer.stop();
    if (engineBridge) await engineBridge.shutdown();
    if (dataStudioService) dataStudioService.close();
    if (appDb) appDb.close();
  } catch (_) {
    // Ignorer lors de la fermeture
  }
});
