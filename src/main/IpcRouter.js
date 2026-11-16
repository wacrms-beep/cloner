/**
 * IpcRouter : enregistre et valide rigoureusement tous les canaux IPC.
 * Chaque handler valide ses arguments (type, longueur, plage, valeurs autorisées)
 * avant d'invoquer les services métier.
 */
const fs = require('node:fs');
const path = require('node:path');

// Table des modules pour l'extensibilité (§11)
const MODULES_REGISTRY = Object.freeze([
  {
    name: 'web_clone',
    title: 'Module 1 : Cloneur Web & API',
    supportedInputs: ['http', 'https'],
    status: 'active',
    description: 'Aspiration Frontend Chromium, Sniffer XHR/Fetch, Schéma SQL & Backend PHP 8 PDO.'
  },
  {
    name: 'apk_clone',
    title: 'Module 2 : Analyseur APK Android',
    supportedInputs: ['.apk'],
    status: 'planned',
    description: 'Extensibilité préparée pour l’analyse d’applications mobiles (hors périmètre Module 1).'
  },
  {
    name: 'exe_clone',
    title: 'Module 3 : Analyseur Binaire Desktop',
    supportedInputs: ['.exe'],
    status: 'planned',
    description: 'Extensibilité préparée pour l’analyse d’applications bureau (hors périmètre Module 1).'
  }
]);

const ALLOWED_CLONE_STATUSES = ['queued', 'running', 'paused', 'done', 'failed', 'cancelled', 'interrupted'];
const ALLOWED_WAIT_STRATEGIES = ['networkidle', 'load', 'domcontentloaded'];
const ALLOWED_EXPORT_FORMATS = ['csv', 'json', 'sql'];
const ALLOWED_ACQUIRE_STRATEGIES = ['none', 'auto', 'signup_auto', 'cookies', 'manual'];

/**
 * Vérifie si un hôte correspond à localhost ou à une adresse IP privée/locale.
 */
function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().trim();
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || h === '[::1]' || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  // IPv4
  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

/**
 * Valide une URL à cloner (http/https uniquement, bloque localhost/IP privées sauf réglage explicite).
 */
function validateCloneUrl(rawUrl, allowLocalNetwork = false) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0 || rawUrl.length > 2048) {
    throw new Error('URL invalide (doit être une chaîne entre 1 et 2048 caractères).');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_) {
    throw new Error('Format d’URL invalide. Exemple attendu : https://example.com');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Seuls les protocoles http:// et https:// sont autorisés.');
  }
  if (!allowLocalNetwork && isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error('Les adresses locales ou privées (localhost, 127.0.0.1, LAN) sont refusées par défaut.');
  }
  return parsed.toString();
}

/**
 * Valide et nettoie les options de clonage.
 */
function validateCloneOptions(rawOpts = {}) {
  if (rawOpts !== null && typeof rawOpts !== 'object') {
    throw new Error('Les options de clonage doivent être un objet.');
  }
  const opts = {};
  const clampInt = (val, min, max, fallback) => {
    if (val === undefined || val === null) return fallback;
    const n = Number(val);
    if (!Number.isFinite(n)) throw new Error(`Valeur numérique invalide : ${val}`);
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };

  if (rawOpts.max_depth !== undefined) opts.max_depth = clampInt(rawOpts.max_depth, 0, 10, 2);
  if (rawOpts.max_pages !== undefined) opts.max_pages = clampInt(rawOpts.max_pages, 1, 1000, 50);
  if (rawOpts.same_domain_only !== undefined) opts.same_domain_only = Boolean(rawOpts.same_domain_only);
  if (rawOpts.include_subdomains !== undefined) opts.include_subdomains = Boolean(rawOpts.include_subdomains);
  if (rawOpts.viewport !== undefined) {
    const vp = String(rawOpts.viewport);
    if (!/^\d{3,4}x\d{3,4}$/.test(vp)) throw new Error('Format de viewport invalide (attendu : 1440x900).');
    opts.viewport = vp;
  }
  if (rawOpts.mobile_emulation !== undefined) opts.mobile_emulation = Boolean(rawOpts.mobile_emulation);
  if (rawOpts.user_agent !== undefined && rawOpts.user_agent !== null) {
    const ua = String(rawOpts.user_agent).slice(0, 300);
    opts.user_agent = ua || null;
  }
  if (rawOpts.wait_strategy !== undefined) {
    if (!ALLOWED_WAIT_STRATEGIES.includes(rawOpts.wait_strategy)) {
      throw new Error(`Stratégie d'attente non autorisée : ${rawOpts.wait_strategy}`);
    }
    opts.wait_strategy = rawOpts.wait_strategy;
  }
  if (rawOpts.extra_wait_ms !== undefined) opts.extra_wait_ms = clampInt(rawOpts.extra_wait_ms, 0, 30000, 1500);
  if (rawOpts.scroll_to_bottom !== undefined) opts.scroll_to_bottom = Boolean(rawOpts.scroll_to_bottom);
  if (rawOpts.scroll_steps !== undefined) opts.scroll_steps = clampInt(rawOpts.scroll_steps, 1, 50, 8);
  if (rawOpts.respect_robots !== undefined) opts.respect_robots = Boolean(rawOpts.respect_robots);
  if (rawOpts.request_delay_ms !== undefined) opts.request_delay_ms = clampInt(rawOpts.request_delay_ms, 0, 10000, 300);
  if (rawOpts.concurrency !== undefined) opts.concurrency = clampInt(rawOpts.concurrency, 1, 16, 4);
  if (rawOpts.max_asset_mb !== undefined) opts.max_asset_mb = clampInt(rawOpts.max_asset_mb, 1, 500, 50);
  if (rawOpts.max_total_mb !== undefined) opts.max_total_mb = clampInt(rawOpts.max_total_mb, 10, 10000, 1500);
  if (rawOpts.strip_trackers !== undefined) opts.strip_trackers = Boolean(rawOpts.strip_trackers);
  if (rawOpts.sniff_api !== undefined) opts.sniff_api = Boolean(rawOpts.sniff_api);
  if (rawOpts.generate_backend !== undefined) opts.generate_backend = Boolean(rawOpts.generate_backend);
  if (rawOpts.sample_limit_per_endpoint !== undefined) {
    opts.sample_limit_per_endpoint = clampInt(rawOpts.sample_limit_per_endpoint, 1, 200, 20);
  }
  if (rawOpts.timeout_s !== undefined) opts.timeout_s = clampInt(rawOpts.timeout_s, 5, 180, 45);
  if (rawOpts.outputDir && typeof rawOpts.outputDir === 'string') {
    opts.outputDir = rawOpts.outputDir.slice(0, 512);
  }
  if (rawOpts.acquire_strategy !== undefined) {
    const strat = String(rawOpts.acquire_strategy).toLowerCase().trim();
    if (!ALLOWED_ACQUIRE_STRATEGIES.includes(strat)) {
      throw new Error(`Stratégie d'acquisition non autorisée : ${strat}`);
    }
    opts.acquire_strategy = strat;
  }
  return opts;
}

function validateDomainArg(rawDomain) {
  if (typeof rawDomain !== 'string' || !rawDomain.trim() || rawDomain.length > 253) {
    throw new Error('Domaine invalide (doit être une chaîne de 1 à 253 caractères).');
  }
  let host = rawDomain.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch (_) {
      throw new Error('Domaine ou URL invalide.');
    }
  }
  host = host.replace(/:\d+$/, '');
  if (!host || /[\s/\\]/.test(host)) {
    throw new Error('Format de domaine invalide.');
  }
  return host;
}

class IpcRouter {
  /**
   * @param {object} deps
   */
  constructor(deps) {
    this.ipcMain = deps.ipcMain;
    this.dialog = deps.dialog;
    this.shell = deps.shell;
    this.windowManager = deps.windowManager;
    this.settingsService = deps.settingsService;
    this.licenseManager = deps.licenseManager;
    this.engineBridge = deps.engineBridge;
    this.cloneRepo = deps.cloneRepo;
    this.pageRepo = deps.pageRepo;
    this.endpointRepo = deps.endpointRepo;
    this.logRepo = deps.logRepo;
    this.projectFileService = deps.projectFileService;
    this.previewServer = deps.previewServer;
    this.dataStudioService = deps.dataStudioService;
    this.gmailService = deps.gmailService || null;
    this.cookieService = deps.cookieService || null;
    this.authService = deps.authService || null;
    this.logger = deps.logger || null;

    this.handlers = new Map();
  }

  /**
   * Enregistre un canal IPC avec gestion d'erreur unifiée.
   */
  _register(channel, fn) {
    this.handlers.set(channel, fn);
    if (this.ipcMain) {
      this.ipcMain.handle(channel, async (event, payload) => {
        try {
          return await fn(payload, event);
        } catch (err) {
          if (this.logger) {
            this.logger.warn('IpcRouter', `Erreur sur canal ${channel} : ${err.message}`);
          }
          throw new Error(err.message || 'Erreur lors du traitement de la requête IPC.');
        }
      });
    }
  }

  /**
   * Permet d'invoquer directement un canal dans les tests unitaires Node.js.
   */
  async invoke(channel, payload = {}) {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`Canal IPC non enregistré : ${channel}`);
    }
    return handler(payload, {});
  }

  registerAll() {
    // 1. Mentions légales & Initialisation
    this._register('legal:status', () => {
      return { acceptance: this.settingsService.getLegalState() };
    });

    this._register('legal:accept', (payload = {}) => {
      if (!payload || payload.confirmed !== true) {
        throw new Error('Vous devez confirmer avoir le droit de copier le contenu visé.');
      }
      return { acceptance: this.settingsService.acceptLegal('1.0.0') };
    });

    // 2. Licence (§10)
    this._register('license:status', () => {
      return this.licenseManager.check();
    });

    this._register('license:activate', (payload = {}) => {
      if (typeof payload.key !== 'string' || payload.key.trim().length < 3 || payload.key.length > 256) {
        throw new Error('Clé de licence invalide.');
      }
      return this.licenseManager.activate(payload.key);
    });

    // 3. Extensibilité Modules (§11)
    this._register('modules:list', () => {
      return MODULES_REGISTRY;
    });

    // 4. Réglages
    this._register('settings:get', () => {
      return this.settingsService.getAll();
    });

    this._register('settings:update', (payload = {}) => {
      if (!payload || typeof payload !== 'object') {
        throw new Error('Objet de réglages attendu.');
      }
      if (payload.theme !== undefined && !['light', 'dark', 'auto'].includes(payload.theme)) {
        throw new Error('Thème invalide (valeurs autorisées : light, dark, auto).');
      }
      if (payload.concurrency !== undefined) {
        const c = Number(payload.concurrency);
        if (!Number.isInteger(c) || c < 1 || c > 16) {
          throw new Error('La concurrence doit être un entier entre 1 et 16.');
        }
      }
      return this.settingsService.update(payload);
    });

    this._register('settings:testPython', (payload = {}) => {
      const candidate = payload && typeof payload.pythonPath === 'string'
        ? payload.pythonPath.trim()
        : null;
      return this.settingsService.testPythonPath(candidate);
    });

    this._register('settings:pickDirectory', async () => {
      if (!this.dialog) return { canceled: true, path: null };
      const res = await this.dialog.showOpenDialog(this.windowManager.getMainWindow(), {
        title: 'Choisir le dossier de sortie',
        properties: ['openDirectory', 'createDirectory']
      });
      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { canceled: true, path: null };
      }
      return { canceled: false, path: res.filePaths[0] };
    });

    // 5. État et diagnostic du moteur Python
    this._register('engine:status', () => {
      return this.engineBridge.getStatus();
    });

    this._register('engine:ping', async () => {
      return this.engineBridge.ping();
    });

    // 6. Tâches de clonage (clone:*)
    this._register('clone:start', async (payload = {}) => {
      this.licenseManager.guard('clone_web');
      const currentSettings = this.settingsService.getAll();
      const validUrl = validateCloneUrl(payload.url, Boolean(currentSettings.allowLocalNetwork));
      const validOptions = validateCloneOptions(payload.options || {});
      return this.engineBridge.enqueueClone({ url: validUrl, options: validOptions });
    });

    this._register('clone:pause', async () => {
      return this.engineBridge.pauseActiveClone();
    });

    this._register('clone:resume', async () => {
      return this.engineBridge.resumeActiveClone();
    });

    this._register('clone:cancel', async (payload = {}) => {
      const cloneId = payload && payload.cloneId ? Number(payload.cloneId) : null;
      if (cloneId !== null && (!Number.isInteger(cloneId) || cloneId <= 0)) {
        throw new Error('Identifiant de clone invalide.');
      }
      return this.engineBridge.cancelClone(cloneId);
    });

    this._register('clone:get', (payload = {}) => {
      const id = Number(payload.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error('Identifiant de clone invalide.');
      }
      const clone = this.cloneRepo.getById(id);
      if (!clone) {
        throw new Error(`Clone #${id} introuvable.`);
      }
      return {
        ...clone,
        thumbnail: this.projectFileService.getThumbnailDataUrl(clone.output_dir),
        pages: this.pageRepo.listByClone(id, { limit: 200 }),
        endpoints: this.endpointRepo.listByClone(id),
        tables: this.cloneRepo.listCloneTables(id),
        logs: this.logRepo.listByClone(id, { limit: 500 })
      };
    });

    this._register('clone:list', (payload = {}) => {
      const status = payload.status || null;
      if (status && !ALLOWED_CLONE_STATUSES.includes(status)) {
        throw new Error(`Filtre de statut invalide : ${status}`);
      }
      const search = payload.search ? String(payload.search).slice(0, 120) : '';
      const limit = Math.min(Math.max(1, Number(payload.limit) || 100), 500);
      const offset = Math.max(0, Number(payload.offset) || 0);

      const list = this.cloneRepo.list({ status, search, limit, offset });
      return list.map((item) => ({
        ...item,
        thumbnail: this.projectFileService.getThumbnailDataUrl(item.output_dir)
      }));
    });

    this._register('clone:logs', (payload = {}) => {
      const cloneId = Number(payload.cloneId);
      if (!Number.isInteger(cloneId) || cloneId <= 0) {
        throw new Error('Identifiant de clone invalide.');
      }
      const level = payload.level && ['info', 'warn', 'error', 'debug'].includes(payload.level)
        ? payload.level
        : null;
      return this.logRepo.listByClone(cloneId, { level, limit: 1000 });
    });

    this._register('clone:delete', (payload = {}) => {
      const id = Number(payload.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error('Identifiant de clone invalide.');
      }
      const clone = this.cloneRepo.getById(id);
      if (!clone) return { deleted: false };
      if (payload.deleteFiles) {
        this.projectFileService.deleteCloneArtifacts(clone.output_dir, clone.zip_path);
      }
      const deleted = this.cloneRepo.delete(id);
      return { deleted };
    });

    this._register('clone:openFolder', async (payload = {}) => {
      const id = Number(payload.id);
      const clone = this.cloneRepo.getById(id);
      if (!clone || !clone.output_dir || !fs.existsSync(clone.output_dir)) {
        throw new Error('Le dossier de sortie de ce clone est introuvable.');
      }
      if (this.shell) {
        await this.shell.openPath(clone.output_dir);
      }
      return { ok: true, path: clone.output_dir };
    });

    this._register('clone:openZip', async (payload = {}) => {
      const id = Number(payload.id);
      const clone = this.cloneRepo.getById(id);
      if (!clone || !clone.zip_path || !fs.existsSync(clone.zip_path)) {
        throw new Error('L’archive .zip de ce clone est introuvable.');
      }
      if (this.shell) {
        this.shell.showItemInFolder(clone.zip_path);
      }
      return { ok: true, path: clone.zip_path };
    });

    this._register('clone:preview', async (payload = {}) => {
      const id = Number(payload.id);
      const clone = this.cloneRepo.getById(id);
      if (!clone || !clone.output_dir) {
        throw new Error('Clone ou dossier de sortie introuvable.');
      }
      const endpoints = this.endpointRepo.listByClone(id);
      const res = await this.previewServer.start(clone.output_dir, endpoints);
      if (this.shell && payload.openBrowser !== false) {
        await this.shell.openExternal(res.url);
      }
      return res;
    });

    // 7. Data Studio (§5)
    this._register('studio:openDb', async (payload = {}) => {
      this.licenseManager.guard('data_studio');
      if (payload && payload.pickFile && this.dialog) {
        const res = await this.dialog.showOpenDialog(this.windowManager.getMainWindow(), {
          title: 'Ouvrir une base SQLite',
          filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db', 'sqlite3'] }],
          properties: ['openFile']
        });
        if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
          return { canceled: true };
        }
        return this.dataStudioService.openDatabase(res.filePaths[0]);
      }

      if (payload && payload.cloneId) {
        const clone = this.cloneRepo.getById(Number(payload.cloneId));
        if (!clone || !clone.output_dir) {
          throw new Error('Clone introuvable.');
        }
        const previewDb = path.join(clone.output_dir, 'preview.sqlite');
        return this.dataStudioService.openDatabase(previewDb);
      }

      const targetPath = payload && payload.path ? String(payload.path) : 'app';
      return this.dataStudioService.openDatabase(targetPath);
    });

    this._register('studio:listTables', () => {
      this.licenseManager.guard('data_studio');
      return {
        dbPath: this.dataStudioService.currentPath,
        isAppDb: this.dataStudioService.currentPath === this.dataStudioService.appDbPath,
        tables: this.dataStudioService.listTables()
      };
    });

    this._register('studio:describe', (payload = {}) => {
      this.licenseManager.guard('data_studio');
      if (!payload || typeof payload.table !== 'string' || !payload.table.trim()) {
        throw new Error('Nom de table requis.');
      }
      return this.dataStudioService.describeTable(payload.table.trim());
    });

    this._register('studio:rows', (payload = {}) => {
      this.licenseManager.guard('data_studio');
      if (!payload || typeof payload.table !== 'string' || !payload.table.trim()) {
        throw new Error('Nom de table requis.');
      }
      return this.dataStudioService.getRows({
        table: payload.table.trim(),
        page: payload.page,
        pageSize: payload.pageSize,
        sortBy: payload.sortBy || null,
        sortDir: payload.sortDir || 'ASC',
        search: payload.search || '',
        columnFilters: payload.columnFilters || {}
      });
    });

    this._register('studio:updateCell', (payload = {}) => {
      this.licenseManager.guard('data_studio');
      if (!payload || typeof payload.table !== 'string' || typeof payload.column !== 'string') {
        throw new Error('Table et colonne requises pour la mise à jour.');
      }
      return this.dataStudioService.updateCell({
        table: payload.table.trim(),
        locator: payload.locator,
        column: payload.column.trim(),
        value: payload.value
      });
    });

    this._register('studio:insertRow', (payload = {}) => {
      this.licenseManager.guard('data_studio');
      if (!payload || typeof payload.table !== 'string' || typeof payload.row !== 'object') {
        throw new Error('Table et données de ligne requises.');
      }
      return this.dataStudioService.insertRow({
        table: payload.table.trim(),
        row: payload.row
      });
    });

    this._register('studio:deleteRow', (payload = {}) => {
      this.licenseManager.guard('data_studio');
      if (payload && payload.undoToken) {
        return this.dataStudioService.undoDelete(String(payload.undoToken));
      }
      if (!payload || typeof payload.table !== 'string' || !payload.locator) {
        throw new Error('Table et identifiant de ligne requis pour la suppression.');
      }
      return this.dataStudioService.deleteRow({
        table: payload.table.trim(),
        locator: payload.locator
      });
    });

    this._register('studio:runSql', (payload = {}) => {
      this.licenseManager.guard('data_studio');
      if (!payload || typeof payload.sql !== 'string' || !payload.sql.trim()) {
        throw new Error('Requête SQL requise.');
      }
      return this.dataStudioService.runSql({
        sql: payload.sql,
        readOnly: payload.readOnly !== false
      });
    });

    this._register('studio:export', async (payload = {}) => {
      this.licenseManager.guard('data_studio');
      if (!payload || typeof payload.table !== 'string') {
        throw new Error('Nom de table requis pour l’export.');
      }
      const format = String(payload.format || 'csv').toLowerCase();
      if (!ALLOWED_EXPORT_FORMATS.includes(format)) {
        throw new Error(`Format d'export non autorisé : ${format}`);
      }

      let targetPath = payload.targetPath ? String(payload.targetPath) : null;
      if (!targetPath && payload.saveDialog && this.dialog) {
        const res = await this.dialog.showSaveDialog(this.windowManager.getMainWindow(), {
          title: `Exporter ${payload.table} en ${format.toUpperCase()}`,
          defaultPath: `${payload.table}.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }]
        });
        if (res.canceled || !res.filePath) {
          return { canceled: true };
        }
        targetPath = res.filePath;
      }

      return this.dataStudioService.exportTable({
        table: payload.table.trim(),
        format,
        targetPath
      });
    });

    this._register('studio:import', async (payload = {}) => {
      this.licenseManager.guard('data_studio');
      if (!payload || typeof payload.table !== 'string') {
        throw new Error('Nom de table requis pour l’import CSV.');
      }

      let csvContent = payload.csvContent ? String(payload.csvContent) : null;
      if (!csvContent && payload.pickFile && this.dialog) {
        const res = await this.dialog.showOpenDialog(this.windowManager.getMainWindow(), {
          title: 'Importer un fichier CSV',
          filters: [{ name: 'CSV', extensions: ['csv'] }],
          properties: ['openFile']
        });
        if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
          return { canceled: true };
        }
        csvContent = fs.readFileSync(res.filePaths[0], 'utf8');
      }

      if (!csvContent) {
        throw new Error('Aucun contenu CSV fourni.');
      }
      return this.dataStudioService.importCsv({
        table: payload.table.trim(),
        csvContent
      });
    });

    // 8. Gmail OAuth Lecture Seule (§2 & §4)
    this._register('gmail:status', () => {
      this.licenseManager.guard('gmail_verify');
      if (!this.gmailService) {
        return { id: 1, email: '', status: 'disconnected', connected_at: null, expires_hint: null };
      }
      return this.gmailService.status();
    });

    this._register('gmail:connect', async (payload = {}) => {
      this.licenseManager.guard('gmail_verify');
      if (!this.gmailService) {
        throw new Error('Service Gmail non initialisé.');
      }
      const clientId = payload.clientId !== undefined ? String(payload.clientId).trim() : '';
      const clientSecret = payload.clientSecret !== undefined ? String(payload.clientSecret).trim() : '';
      if (clientId.length > 256 || clientSecret.length > 256) {
        throw new Error('Identifiants OAuth Gmail trop longs (max 256 caractères).');
      }
      return this.gmailService.connect({
        clientId: clientId || undefined,
        clientSecret: clientSecret || undefined
      });
    });

    this._register('gmail:disconnect', async () => {
      this.licenseManager.guard('gmail_verify');
      if (!this.gmailService) {
        return { status: 'disconnected' };
      }
      return this.gmailService.disconnect();
    });

    // 9. Acquisition de session & Comptes Tests (§1, §3, §4)
    this._register('auth:acquire', async (payload = {}) => {
      this.licenseManager.guard('signup_auto');
      const currentSettings = this.settingsService.getAll();
      const validUrl = validateCloneUrl(payload.url, Boolean(currentSettings.allowLocalNetwork));
      const strategy = String(payload.strategy || 'auto').toLowerCase().trim();
      if (!ALLOWED_ACQUIRE_STRATEGIES.includes(strategy) || strategy === 'none') {
        throw new Error(`Stratégie d'acquisition invalide : ${strategy}`);
      }
      const cloneId = payload.cloneId !== undefined && payload.cloneId !== null
        ? Number(payload.cloneId)
        : null;
      if (cloneId !== null && (!Number.isInteger(cloneId) || cloneId <= 0)) {
        throw new Error('Identifiant de clone invalide.');
      }
      if (!this.engineBridge || typeof this.engineBridge.acquireAuthSession !== 'function') {
        throw new Error('Pont d’acquisition moteur indisponible.');
      }
      return this.engineBridge.acquireAuthSession({
        cloneId,
        url: validUrl,
        strategy,
        cookies: Array.isArray(payload.cookies) ? payload.cookies : undefined
      });
    });

    this._register('auth:resume', async (payload = {}) => {
      this.licenseManager.guard('signup_auto');
      const cloneId = payload && payload.cloneId ? Number(payload.cloneId) : this.engineBridge?.activeCloneId;
      if (!cloneId || !Number.isInteger(cloneId) || cloneId <= 0) {
        throw new Error('Identifiant de clone requis pour reprendre l’acquisition.');
      }
      const nextStrategy = payload.strategy ? String(payload.strategy).toLowerCase().trim() : null;
      if (nextStrategy && !ALLOWED_ACQUIRE_STRATEGIES.includes(nextStrategy)) {
        throw new Error(`Stratégie de reprise invalide : ${nextStrategy}`);
      }
      if (!this.engineBridge || typeof this.engineBridge.resumeAuthSession !== 'function') {
        throw new Error('Pont de reprise moteur indisponible.');
      }
      return this.engineBridge.resumeAuthSession({
        cloneId,
        strategy: nextStrategy,
        openVisibleBrowser: Boolean(payload.openVisibleBrowser),
        cookies: Array.isArray(payload.cookies) ? payload.cookies : undefined
      });
    });

    this._register('auth:cancel', async (payload = {}) => {
      const cloneId = payload && payload.cloneId ? Number(payload.cloneId) : this.engineBridge?.activeCloneId;
      if (cloneId !== null && cloneId !== undefined && (!Number.isInteger(cloneId) || cloneId <= 0)) {
        throw new Error('Identifiant de clone invalide.');
      }
      if (this.engineBridge && typeof this.engineBridge.cancelAuthSession === 'function') {
        return this.engineBridge.cancelAuthSession(cloneId);
      }
      return this.engineBridge.cancelClone(cloneId);
    });

    this._register('auth:listAccounts', () => {
      if (!this.authService) return [];
      return this.authService.listTestAccounts();
    });

    this._register('auth:revealPassword', (payload = {}) => {
      const id = Number(payload.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error('Identifiant de compte invalide.');
      }
      if (payload.confirmed !== true) {
        throw new Error('Confirmation explicite requise.');
      }
      if (!this.authService) throw new Error('Service Auth non initialisé.');
      return this.authService.revealAccountPassword(id, true);
    });

    this._register('auth:deleteAccount', (payload = {}) => {
      const id = Number(payload.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error('Identifiant de compte invalide.');
      }
      if (!this.authService) return { deleted: false };
      return this.authService.deleteTestAccount(id);
    });

    this._register('auth:listSessions', (payload = {}) => {
      const domain = payload && payload.domain ? validateDomainArg(payload.domain) : null;
      if (!this.authService) return [];
      return this.authService.listSessions(domain);
    });

    this._register('auth:deleteSession', (payload = {}) => {
      const id = Number(payload.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error('Identifiant de session invalide.');
      }
      if (!this.authService) return { deleted: false };
      return this.authService.deleteSession(id);
    });

    // 10. Cookie Studio (§4 & §5)
    this._register('cookies:parse', (payload = {}) => {
      this.licenseManager.guard('cookie_import');
      if (!this.cookieService) throw new Error('CookieService non initialisé.');
      const domain = payload.domain ? validateDomainArg(payload.domain) : '';
      if (payload.rawInput === undefined || payload.rawInput === null) {
        throw new Error('Contenu de cookies requis pour cookies:parse.');
      }
      if (typeof payload.rawInput === 'string' && payload.rawInput.length > 524288) {
        throw new Error('Contenu de cookies trop volumineux (max 512 Ko).');
      }
      return this.cookieService.parse(payload.rawInput, domain);
    });

    this._register('cookies:import', async (payload = {}) => {
      this.licenseManager.guard('cookie_import');
      if (!this.cookieService) throw new Error('CookieService non initialisé.');
      const domain = validateDomainArg(payload.domain);

      let rawInput = payload.rawInput;
      if (!rawInput && !payload.cookiesList && payload.pickFile && this.dialog) {
        const res = await this.dialog.showOpenDialog(this.windowManager.getMainWindow(), {
          title: 'Importer un fichier de cookies (.json / .txt)',
          filters: [{ name: 'Cookies', extensions: ['json', 'txt'] }],
          properties: ['openFile']
        });
        if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
          return { canceled: true };
        }
        rawInput = fs.readFileSync(res.filePaths[0], 'utf8');
      }

      if (typeof rawInput === 'string' && rawInput.length > 524288) {
        throw new Error('Fichier de cookies trop volumineux (max 512 Ko).');
      }

      return this.cookieService.importCookies({
        domain,
        rawInput,
        cookiesList: payload.cookiesList || null,
        label: payload.label ? String(payload.label).slice(0, 120) : ''
      });
    });

    this._register('cookies:list', (payload = {}) => {
      this.licenseManager.guard('cookie_import');
      if (!this.cookieService) return { domain: '', cookies: [], session: null };
      const domain = validateDomainArg(payload.domain);
      return this.cookieService.listCookies({ domain, revealValues: payload.revealValues !== false });
    });

    this._register('cookies:edit', (payload = {}) => {
      this.licenseManager.guard('cookie_import');
      if (!this.cookieService) throw new Error('CookieService non initialisé.');
      const domain = validateDomainArg(payload.domain);
      if (!Array.isArray(payload.cookies) || payload.cookies.length > 300) {
        throw new Error('Liste de cookies invalide (max 300 cookies).');
      }
      return this.cookieService.editCookies({
        domain,
        cookies: payload.cookies
      });
    });

    this._register('cookies:test', async (payload = {}) => {
      this.licenseManager.guard('cookie_import');
      if (!this.cookieService) throw new Error('CookieService non initialisé.');
      const currentSettings = this.settingsService.getAll();
      const validUrl = validateCloneUrl(payload.url, Boolean(currentSettings.allowLocalNetwork));
      if (payload.cookies !== undefined && (!Array.isArray(payload.cookies) || payload.cookies.length > 300)) {
        throw new Error('Sélection de cookies invalide.');
      }
      return this.cookieService.testCookies({
        url: validUrl,
        cookies: payload.cookies || null
      });
    });
  }
}

module.exports = {
  IpcRouter,
  validateCloneUrl,
  validateCloneOptions,
  isPrivateOrLocalHost,
  MODULES_REGISTRY
};
