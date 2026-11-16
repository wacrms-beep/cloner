/**
 * WindowManager : gère la fenêtre principale Electron avec des règles de sécurité strictes :
 * - contextIsolation: true
 * - nodeIntegration: false
 * - sandbox: true
 * - webSecurity: true
 * - Navigation externe bloquée (ouverture via shell.openExternal uniquement pour http/https validé)
 */
const path = require('node:path');
const { BrowserWindow, shell } = require('electron');

class WindowManager {
  constructor(logger = null) {
    this.logger = logger;
    this.mainWindow = null;
  }

  createMainWindow() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.focus();
      return this.mainWindow;
    }

    const preloadPath = path.join(__dirname, '..', 'preload', 'preload.js');
    const indexHtmlPath = path.join(__dirname, '..', 'renderer', 'index.html');

    this.mainWindow = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 1024,
      minHeight: 700,
      title: 'Universal Clone',
      backgroundColor: '#F5F6FA',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false
      }
    });

    // Bloquer toute navigation hors de l'interface locale index.html
    this.mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
      const currentUrl = this.mainWindow.webContents.getURL();
      if (targetUrl !== currentUrl && !targetUrl.startsWith('file://')) {
        event.preventDefault();
        this._openSafeExternal(targetUrl);
      }
    });

    // Bloquer l'ouverture de nouvelles fenêtres (window.open / target="_blank")
    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      this._openSafeExternal(url);
      return { action: 'deny' };
    });

    this.mainWindow.once('ready-to-show', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.show();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    this.mainWindow.loadFile(indexHtmlPath);

    if (process.argv.includes('--dev')) {
      this.mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    return this.mainWindow;
  }

  send(channel, payload) {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }

  getMainWindow() {
    return this.mainWindow;
  }

  _openSafeExternal(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl));
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(parsed.toString());
      }
    } catch (_) {
      if (this.logger) {
        this.logger.warn('WindowManager', `URL externe refusée : ${rawUrl}`);
      }
    }
  }
}

module.exports = { WindowManager };
