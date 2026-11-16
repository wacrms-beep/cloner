/**
 * Journaliseur rotatif sur disque (dans userData/logs/universal-clone.log).
 * N'enregistre jamais de données sensibles (masquage automatique des clés secrètes).
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 Mo par fichier
const MAX_ROTATIONS = 3;
const SENSITIVE_KEY_RE = /(password|token|secret|authorization|cookie|api_key|apikey|iban|card)/i;

class Logger {
  /**
   * @param {string} logsDir Dossier de stockage des journaux
   */
  constructor(logsDir) {
    this.logsDir = logsDir;
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.logFile = path.join(this.logsDir, 'universal-clone.log');
  }

  info(scope, message, meta = null) {
    this._write('INFO', scope, message, meta);
  }

  warn(scope, message, meta = null) {
    this._write('WARN', scope, message, meta);
  }

  error(scope, message, meta = null) {
    this._write('ERROR', scope, message, meta);
  }

  debug(scope, message, meta = null) {
    if (process.env.NODE_ENV === 'development') {
      this._write('DEBUG', scope, message, meta);
    }
  }

  _write(level, scope, message, meta) {
    const ts = new Date().toISOString();
    const safeMeta = meta ? ` ${JSON.stringify(this._sanitize(meta))}` : '';
    const line = `[${ts}] [${level}] [${scope}] ${String(message)}${safeMeta}\n`;

    try {
      this._rotateIfNeeded();
      fs.appendFileSync(this.logFile, line, 'utf8');
    } catch (_) {
      // Ignorer erreur d'écriture disque non fatale
    }
  }

  _rotateIfNeeded() {
    if (!fs.existsSync(this.logFile)) return;
    const stat = fs.statSync(this.logFile);
    if (stat.size < MAX_LOG_BYTES) return;

    for (let i = MAX_ROTATIONS - 1; i >= 1; i -= 1) {
      const src = `${this.logFile}.${i}`;
      const dst = `${this.logFile}.${i + 1}`;
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
      }
    }
    fs.renameSync(this.logFile, `${this.logFile}.1`);
  }

  _sanitize(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((v) => this._sanitize(v));

    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        clean[k] = '[REDACTED]';
      } else {
        clean[k] = this._sanitize(v);
      }
    }
    return clean;
  }
}

module.exports = { Logger };
