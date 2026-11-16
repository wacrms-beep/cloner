/**
 * Gestionnaire de connexion SQLite, migrations et transactions.
 * Active systématiquement le mode WAL et les clés étrangères (foreign_keys = ON).
 * Au démarrage, convertit tout clone resté à l'état 'running' en 'interrupted'.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Charge le pilote SQLite (better-sqlite3 en priorité, avec repli compatible sur node:sqlite
 * si l'addon natif est compilé pour une autre ABI lors de l'exécution de tests CLI hors Electron).
 */
function openSqliteConnection(filePath, options = {}) {
  try {
    const BetterSqlite3 = require('better-sqlite3');
    return new BetterSqlite3(filePath, { readonly: Boolean(options.readonly) });
  } catch (err) {
    // Repli transparent vers node:sqlite avec interface identique à better-sqlite3
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(filePath, { readOnly: Boolean(options.readonly) });
    return createNodeSqliteAdapter(raw);
  }
}

/**
 * Adaptateur léger rendant node:sqlite (DatabaseSync) 100 % compatible avec l'API better-sqlite3
 * (pragma, transaction, prepare().run/get/all).
 */
function createNodeSqliteAdapter(raw) {
  const adapter = {
    pragma(expr, opts = {}) {
      const stmt = raw.prepare(`PRAGMA ${expr}`);
      if (expr.includes('=')) {
        stmt.run();
        return undefined;
      }
      const rows = stmt.all();
      if (opts && opts.simple) {
        if (rows.length === 0) return undefined;
        const firstKey = Object.keys(rows[0])[0];
        return rows[0][firstKey];
      }
      return rows;
    },
    exec(sql) {
      raw.exec(sql);
      return adapter;
    },
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        run(...args) {
          const params = flattenArgs(args);
          return stmt.run(...params);
        },
        get(...args) {
          const params = flattenArgs(args);
          return stmt.get(...params);
        },
        all(...args) {
          const params = flattenArgs(args);
          return stmt.all(...params);
        }
      };
    },
    transaction(fn) {
      return (...args) => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const res = fn(...args);
          raw.exec('COMMIT');
          return res;
        } catch (err) {
          try {
            raw.exec('ROLLBACK');
          } catch (_) {
            // Ignorer erreur rollback
          }
          throw err;
        }
      };
    },
    close() {
      raw.close();
    }
  };
  return adapter;
}

function flattenArgs(args) {
  if (args.length === 1 && Array.isArray(args[0])) {
    return args[0];
  }
  return args;
}

class AppDatabase {
  /**
   * @param {string} dbPath Chemin complet du fichier SQLite (ou ':memory:')
   * @param {object} [options] Options de connexion
   */
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.options = options;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.conn = openSqliteConnection(dbPath, options);

    if (!options.readonly) {
      this.conn.pragma('journal_mode = WAL');
    }
    this.conn.pragma('foreign_keys = ON');
  }

  /**
   * Applique les migrations SQL présentes dans migrations/ et nettoie les jobs interrompus.
   */
  init() {
    this.runMigrations();
    this.markRunningAsInterrupted();
    return this;
  }

  /**
   * Exécute toutes les migrations non encore appliquées dans une transaction.
   */
  runMigrations() {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const checkStmt = this.conn.prepare('SELECT version FROM schema_migrations WHERE version = ?');
    const insertStmt = this.conn.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10);
      if (Number.isNaN(version)) continue;

      const existing = checkStmt.get(version);
      if (!existing) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        const apply = this.conn.transaction(() => {
          this.conn.exec(sql);
          insertStmt.run(version, new Date().toISOString());
        });
        apply();
      }
    }
  }

  /**
   * Marque tout clone resté en statut 'running' ou 'paused' comme 'interrupted' au lancement.
   */
  markRunningAsInterrupted() {
    const now = new Date().toISOString();
    const stmt = this.conn.prepare(`
      UPDATE clones
      SET status = 'interrupted',
          error = COALESCE(error, 'Exécution interrompue lors de la fermeture précédente'),
          finished_at = ?
      WHERE status IN ('running', 'paused')
    `);
    return stmt.run(now).changes;
  }

  /**
   * Crée une requête préparée.
   * @param {string} sql Requête SQL avec paramètres ?
   */
  prepare(sql) {
    return this.conn.prepare(sql);
  }

  /**
   * Enveloppe une fonction dans une transaction atomique SQLite.
   * @param {Function} fn Fonction transactionnelle
   */
  transaction(fn) {
    return this.conn.transaction(fn);
  }

  /**
   * Exécute un PRAGMA SQLite.
   */
  pragma(expr, opts) {
    return this.conn.pragma(expr, opts);
  }

  /**
   * Ferme proprement la connexion SQLite.
   */
  close() {
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
  }
}

module.exports = {
  AppDatabase,
  openSqliteConnection
};
