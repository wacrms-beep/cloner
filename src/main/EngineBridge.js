/**
 * EngineBridge : supervise le moteur Python (engine/engine.py) en processus enfant,
 * gère la communication JSON Lines (stdin/stdout), la corrélation par id (UUID) avec timeout,
 * le heartbeat ping toutes les 10 s, le redémarrage automatique (max 3 tentatives avec backoff),
 * la file d'attente FIFO des tâches de clonage (une seule active à la fois),
 * la persistance temps réel dans SQLite et la diffusion vers le renderer ('engine:event').
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');

class EngineBridge extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./SettingsService').SettingsService} deps.settingsService
   * @param {import('./db/repositories/CloneRepository').CloneRepository} deps.cloneRepo
   * @param {import('./db/repositories/PageRepository').PageRepository} deps.pageRepo
   * @param {import('./db/repositories/EndpointRepository').EndpointRepository} deps.endpointRepo
   * @param {import('./db/repositories/LogRepository').LogRepository} deps.logRepo
   * @param {import('./ProjectFileService').ProjectFileService} deps.projectFileService
   * @param {import('./LicenseManager').LicenseManager} deps.licenseManager
   * @param {import('./Logger').Logger} [deps.logger]
   * @param {Function} [deps.onRendererBroadcast] Fonction (channel, payload) => void
   * @param {string} [deps.engineScriptPath]
   */
  constructor(deps) {
    super();
    this.settingsService = deps.settingsService;
    this.cloneRepo = deps.cloneRepo;
    this.pageRepo = deps.pageRepo;
    this.endpointRepo = deps.endpointRepo;
    this.logRepo = deps.logRepo;
    this.projectFileService = deps.projectFileService;
    this.licenseManager = deps.licenseManager;
    this.logger = deps.logger || null;
    this.onRendererBroadcast = deps.onRendererBroadcast || (() => {});

    const rootDir = path.resolve(__dirname, '../..');
    const prodEngineScript = process.resourcesPath
      ? path.join(process.resourcesPath, 'engine', 'engine.py')
      : null;
    this.engineScriptPath = deps.engineScriptPath || (
      prodEngineScript && fs.existsSync(prodEngineScript)
        ? prodEngineScript
        : path.join(rootDir, 'engine', 'engine.py')
    );

    this.proc = null;
    this.stdoutBuffer = '';
    this.state = 'stopped'; // 'starting' | 'ready' | 'busy' | 'error' | 'stopped'
    this.engineVersion = null;
    this.pendingCommands = new Map(); // id -> { resolve, reject, timer }
    this.heartbeatTimer = null;
    this.restartAttempts = 0;
    this.maxRestartAttempts = 3;
    this.isShuttingDown = false;

    // File d'attente FIFO : une seule tâche de clonage active à la fois
    this.activeCloneId = null;
    this.queue = []; // [{ cloneId, url, options, outputDir }]
  }

  /**
   * Démarre le processus Python et attend l'événement {"type":"ready"}.
   */
  async start() {
    if (this.proc && (this.state === 'ready' || this.state === 'busy' || this.state === 'starting')) {
      return this.getStatus();
    }

    this.isShuttingDown = false;
    this._setState('starting');

    const pythonPath = this.settingsService.detectPythonPath();
    if (!fs.existsSync(this.engineScriptPath)) {
      this._setState('error', `Script moteur introuvable : ${this.engineScriptPath}`);
      throw new Error(`Script moteur introuvable : ${this.engineScriptPath}`);
    }

    if (this.logger) {
      this.logger.info('EngineBridge', `Démarrage du moteur Python`, {
        pythonPath,
        engineScriptPath: this.engineScriptPath
      });
    }

    return new Promise((resolve, reject) => {
      let readyResolved = false;
      const readyTimeout = setTimeout(() => {
        if (!readyResolved) {
          readyResolved = true;
          this._setState('error', 'Délai dépassé en attendant le signal ready du moteur Python');
          reject(new Error('Délai dépassé lors de l’initialisation du moteur Python'));
        }
      }, 15000);

      const onReadyOnce = (evt) => {
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(readyTimeout);
          this.restartAttempts = 0;
          this._startHeartbeat();
          resolve(this.getStatus());
          this._processQueue();
        }
      };

      this.once('ready_signal', onReadyOnce);

      try {
        this.proc = spawn(pythonPath, ['-u', this.engineScriptPath], {
          cwd: path.dirname(this.engineScriptPath),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            PYTHONIOENCODING: 'utf-8'
          }
        });
      } catch (err) {
        this.removeListener('ready_signal', onReadyOnce);
        clearTimeout(readyTimeout);
        this._setState('error', err.message);
        return reject(err);
      }

      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => this._onStdoutChunk(chunk));

      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (chunk) => {
        const msg = chunk.trim();
        if (msg && this.logger) {
          this.logger.warn('EnginePythonStderr', msg);
        }
      });

      this.proc.on('error', (err) => {
        if (this.logger) {
          this.logger.error('EngineBridge', `Erreur processus Python : ${err.message}`);
        }
        if (!readyResolved) {
          readyResolved = true;
          clearTimeout(readyTimeout);
          this.removeListener('ready_signal', onReadyOnce);
          this._setState('error', err.message);
          reject(err);
        }
      });

      this.proc.on('close', (code, signal) => {
        this._handleProcessExit(code, signal);
      });
    });
  }

  /**
   * Arrête proprement le moteur Python.
   */
  async shutdown() {
    this.isShuttingDown = true;
    this._stopHeartbeat();

    if (!this.proc) {
      this._setState('stopped');
      return;
    }

    try {
      await this.sendCommand('shutdown', {}, 3000);
    } catch (_) {
      // Forcer la fermeture si non réactif
    }

    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch (_) {
        // Ignorer
      }
      this.proc = null;
    }
    this._setState('stopped');
  }

  /**
   * Envoie une commande JSON Lines au moteur Python et attend l'ack correspondant.
   */
  sendCommand(cmd, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
        return reject(new Error('Le moteur Python n’est pas démarré.'));
      }

      const id = crypto.randomUUID();
      const payload = JSON.stringify({ id, cmd, params }) + '\n';

      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Timeout (${timeoutMs} ms) sur la commande "${cmd}"`));
      }, timeoutMs);

      this.pendingCommands.set(id, { resolve, reject, timer, cmd });

      try {
        this.proc.stdin.write(payload, 'utf8');
      } catch (err) {
        clearTimeout(timer);
        this.pendingCommands.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Envoie un ping au moteur et retourne la latence en ms.
   */
  async ping() {
    if (!this.proc) {
      await this.start();
    }
    const start = Date.now();
    await this.sendCommand('ping', {}, 5000);
    return {
      ok: true,
      latencyMs: Date.now() - start,
      ...this.getStatus()
    };
  }

  /**
   * Met en file d'attente ou démarre immédiatement une tâche de clonage.
   */
  async enqueueClone({ url, options = {} }) {
    // Porte d'entrée unique de licence avant chaque clone.start
    this.licenseManager.guard('clone_web');

    const parsed = new URL(url);
    const domain = parsed.hostname;
    const mergedOptions = {
      ...this.settingsService.getAll().defaultCloneOptions,
      ...options
    };

    const outputDir = this.projectFileService.prepareCloneOutputDir(
      domain,
      options.outputDir || null
    );

    const cloneRecord = this.cloneRepo.create({
      url,
      domain,
      status: 'queued',
      options: mergedOptions,
      outputDir
    });

    this.queue.push({
      cloneId: cloneRecord.id,
      url,
      options: mergedOptions,
      outputDir
    });

    this._broadcast({
      type: 'queue',
      cloneId: cloneRecord.id,
      status: 'queued',
      queueLength: this.queue.length
    });

    if (!this.proc || this.state === 'stopped' || this.state === 'error') {
      await this.start();
    } else {
      await this._processQueue();
    }

    return this.cloneRepo.getById(cloneRecord.id);
  }

  async pauseActiveClone() {
    if (!this.activeCloneId) return { ok: false, message: 'Aucun clone actif' };
    await this.sendCommand('clone.pause', { cloneId: this.activeCloneId });
    this.cloneRepo.updateStatus(this.activeCloneId, 'paused');
    this._broadcast({ type: 'status', cloneId: this.activeCloneId, status: 'paused' });
    return { ok: true, cloneId: this.activeCloneId, status: 'paused' };
  }

  async resumeActiveClone() {
    if (!this.activeCloneId) return { ok: false, message: 'Aucun clone actif' };
    await this.sendCommand('clone.resume', { cloneId: this.activeCloneId });
    this.cloneRepo.updateStatus(this.activeCloneId, 'running');
    this._broadcast({ type: 'status', cloneId: this.activeCloneId, status: 'running' });
    return { ok: true, cloneId: this.activeCloneId, status: 'running' };
  }

  async cancelClone(cloneId = null) {
    const targetId = cloneId ? Number(cloneId) : this.activeCloneId;
    if (!targetId) return { ok: false, message: 'Aucun clone spécifié' };

    // S'il est dans la file d'attente
    const qIdx = this.queue.findIndex((item) => item.cloneId === targetId);
    if (qIdx !== -1) {
      this.queue.splice(qIdx, 1);
      this.cloneRepo.updateStatus(targetId, 'cancelled', { finishedAt: new Date().toISOString() });
      this._broadcast({ type: 'status', cloneId: targetId, status: 'cancelled' });
      return { ok: true, cloneId: targetId, status: 'cancelled' };
    }

    // S'il est actif dans le moteur Python
    if (this.activeCloneId === targetId) {
      await this.sendCommand('clone.cancel', { cloneId: targetId }, 8000);
      this.cloneRepo.updateStatus(targetId, 'cancelled', { finishedAt: new Date().toISOString() });
      this._broadcast({ type: 'status', cloneId: targetId, status: 'cancelled' });
      this.activeCloneId = null;
      this._setState('ready');
      await this._processQueue();
      return { ok: true, cloneId: targetId, status: 'cancelled' };
    }

    return { ok: false, message: 'Clone déjà terminé' };
  }

  getStatus() {
    return {
      state: this.state,
      version: this.engineVersion,
      activeCloneId: this.activeCloneId,
      queueLength: this.queue.length,
      restartAttempts: this.restartAttempts,
      pid: this.proc ? this.proc.pid : null
    };
  }

  async _processQueue() {
    if (this.activeCloneId !== null) return;
    if (this.queue.length === 0) return;
    if (!this.proc || (this.state !== 'ready' && this.state !== 'busy')) return;

    const nextJob = this.queue.shift();
    this.activeCloneId = nextJob.cloneId;
    this._setState('busy');

    const now = new Date().toISOString();
    this.cloneRepo.updateStatus(nextJob.cloneId, 'running', { startedAt: now });
    this._broadcast({ type: 'status', cloneId: nextJob.cloneId, status: 'running' });

    try {
      await this.sendCommand('clone.start', {
        cloneId: nextJob.cloneId,
        url: nextJob.url,
        options: nextJob.options,
        outputDir: nextJob.outputDir
      }, 15000);
    } catch (err) {
      this.cloneRepo.updateStatus(nextJob.cloneId, 'failed', {
        error: err.message,
        finishedAt: new Date().toISOString()
      });
      this._broadcast({
        type: 'error',
        cloneId: nextJob.cloneId,
        code: 'START_FAILED',
        message: err.message,
        fatal: true
      });
      this.activeCloneId = null;
      this._setState('ready');
      await this._processQueue();
    }
  }

  _onStdoutChunk(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this._handleJsonLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  _handleJsonLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      if (this.logger) {
        this.logger.warn('EngineBridge', `Ligne JSON invalide reçue sur stdout : ${line.slice(0, 200)}`);
      }
      return;
    }

    const type = msg.type;

    if (type === 'ready') {
      this.engineVersion = msg.version || '1.0.0';
      this._setState('ready');
      this.emit('ready_signal', msg);
      this._broadcast(msg);
      return;
    }

    if (type === 'ack') {
      const pending = this.pendingCommands.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCommands.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg);
        }
      }
      return;
    }

    const cloneId = msg.cloneId ? Number(msg.cloneId) : this.activeCloneId;

    switch (type) {
      case 'log':
        if (cloneId) {
          this.logRepo.add({
            cloneId,
            level: msg.level || 'info',
            phase: msg.phase || 'general',
            message: msg.message || '',
            data: msg.data || null
          });
        }
        break;

      case 'progress':
        if (cloneId) {
          this.cloneRepo.updateProgress(cloneId, msg.phase || 'crawl', msg.percent || 0);
        }
        break;

      case 'stat':
        if (cloneId) {
          this.cloneRepo.updateStats(cloneId, {
            pages: msg.pages,
            assets: msg.assets,
            bytes: msg.bytes,
            endpoints: msg.endpoints,
            tables: msg.tables
          });
        }
        break;

      case 'page':
        if (cloneId) {
          this.pageRepo.add({
            cloneId,
            url: msg.url,
            localPath: msg.localPath,
            status: msg.status,
            title: msg.title,
            depth: msg.depth
          });
        }
        break;

      case 'endpoint':
        if (cloneId) {
          this.endpointRepo.upsert({
            cloneId,
            method: msg.method,
            normalizedPath: msg.normalizedPath,
            sampleUrl: msg.sampleUrl,
            requestExample: msg.requestExample,
            responseExample: msg.responseExample,
            statusCode: msg.statusCode,
            contentType: msg.contentType,
            hits: msg.hits
          });
        }
        break;

      case 'result':
        if (cloneId) {
          this.cloneRepo.completeClone(cloneId, {
            outputDir: msg.outputDir,
            zipPath: msg.zipPath,
            summary: msg.summary || {}
          });
          if (this.activeCloneId === cloneId) {
            this.activeCloneId = null;
            this._setState('ready');
            setImmediate(() => this._processQueue());
          }
        }
        break;

      case 'error':
        if (cloneId) {
          this.logRepo.add({
            cloneId,
            level: 'error',
            phase: msg.phase || 'error',
            message: `${msg.code || 'ERROR'}: ${msg.message || 'Erreur inconnue'}`,
            data: { fatal: Boolean(msg.fatal) }
          });
          if (msg.fatal) {
            const current = this.cloneRepo.getById(cloneId);
            if (current && current.status !== 'cancelled') {
              this.cloneRepo.updateStatus(cloneId, 'failed', {
                error: msg.message || 'Erreur fatale',
                finishedAt: new Date().toISOString()
              });
            }
            if (this.activeCloneId === cloneId) {
              this.activeCloneId = null;
              this._setState('ready');
              setImmediate(() => this._processQueue());
            }
          }
        }
        break;

      default:
        break;
    }

    this._broadcast(msg);
    this.emit('event', msg);
  }

  _handleProcessExit(code, signal) {
    this._stopHeartbeat();
    this.proc = null;

    // Rejeter toutes les commandes en attente
    for (const [id, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Le processus Python s'est arrêté (code=${code}, signal=${signal})`));
      this.pendingCommands.delete(id);
    }

    // Si un clone était en cours, le marquer 'interrupted'
    if (this.activeCloneId !== null) {
      const interruptedId = this.activeCloneId;
      this.activeCloneId = null;
      this.cloneRepo.updateStatus(interruptedId, 'interrupted', {
        error: `Moteur Python interrompu (code=${code}, signal=${signal})`,
        finishedAt: new Date().toISOString()
      });
      this._broadcast({
        type: 'status',
        cloneId: interruptedId,
        status: 'interrupted',
        message: 'Moteur interrompu'
      });
    }

    if (this.isShuttingDown) {
      this._setState('stopped');
      return;
    }

    // Redémarrage automatique avec backoff (max 3 tentatives)
    if (this.restartAttempts < this.maxRestartAttempts) {
      this.restartAttempts += 1;
      const delayMs = 500 * Math.pow(2, this.restartAttempts - 1);
      if (this.logger) {
        this.logger.warn('EngineBridge', `Redémarrage automatique du moteur (tentative ${this.restartAttempts}/${this.maxRestartAttempts}) dans ${delayMs} ms`);
      }
      this._setState('starting', `Redémarrage automatique (${this.restartAttempts}/${this.maxRestartAttempts})...`);
      setTimeout(() => {
        if (!this.isShuttingDown) {
          this.start().catch((err) => {
            if (this.logger) {
              this.logger.error('EngineBridge', `Échec du redémarrage automatique : ${err.message}`);
            }
          });
        }
      }, delayMs);
    } else {
      this._setState('error', 'Le moteur Python a cessé de fonctionner après 3 tentatives de redémarrage.');
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (!this.proc || this.isShuttingDown) return;
      try {
        await this.sendCommand('ping', {}, 5000);
      } catch (err) {
        if (this.logger) {
          this.logger.warn('EngineBridge', `Échec du heartbeat ping : ${err.message}`);
        }
      }
    }, 10000);
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _setState(nextState, detail = null) {
    this.state = nextState;
    this._broadcast({
      type: 'engine:state',
      state: this.state,
      version: this.engineVersion,
      detail,
      activeCloneId: this.activeCloneId
    });
  }

  _broadcast(payload) {
    try {
      this.onRendererBroadcast('engine:event', payload);
    } catch (_) {
      // Ignorer si la fenêtre est fermée
    }
  }
}

module.exports = { EngineBridge };
