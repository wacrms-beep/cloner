/**
 * Dépôt pour les tâches de clonage (table clones) et les tables déduites (table clone_tables).
 * 100 % requêtes préparées.
 */
class CloneRepository {
  /**
   * @param {import('../Database').AppDatabase} db
   */
  constructor(db) {
    this.db = db;
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO clones (
          url, domain, status, options_json, output_dir, current_phase, progress, acquire_strategy, created_at
        ) VALUES (?, ?, ?, ?, ?, 'prepare', 0, ?, ?)
      `),
      getById: db.prepare('SELECT * FROM clones WHERE id = ?'),
      listAll: db.prepare('SELECT * FROM clones ORDER BY id DESC LIMIT ? OFFSET ?'),
      listByStatus: db.prepare('SELECT * FROM clones WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?'),
      searchAll: db.prepare('SELECT * FROM clones WHERE (url LIKE ? OR domain LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?'),
      searchByStatus: db.prepare('SELECT * FROM clones WHERE status = ? AND (url LIKE ? OR domain LIKE ?) ORDER BY id DESC LIMIT ? OFFSET ?'),
      updateStatus: db.prepare('UPDATE clones SET status = ?, error = COALESCE(?, error), started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at) WHERE id = ?'),
      updateProgress: db.prepare('UPDATE clones SET current_phase = ?, progress = ? WHERE id = ?'),
      updateStats: db.prepare(`
        UPDATE clones
        SET pages_count = ?, assets_count = ?, assets_bytes = ?, endpoints_count = ?, tables_count = ?
        WHERE id = ?
      `),
      updateResult: db.prepare(`
        UPDATE clones
        SET status = 'done',
            output_dir = ?,
            zip_path = ?,
            pages_count = ?,
            assets_count = ?,
            assets_bytes = ?,
            endpoints_count = ?,
            tables_count = ?,
            current_phase = 'package',
            progress = 100,
            finished_at = ?
        WHERE id = ?
      `),
      deleteById: db.prepare('DELETE FROM clones WHERE id = ?'),
      insertTable: db.prepare(`
        INSERT INTO clone_tables (clone_id, table_name, columns_json, rows_count)
        VALUES (?, ?, ?, ?)
      `),
      clearTablesForClone: db.prepare('DELETE FROM clone_tables WHERE clone_id = ?'),
      listTablesForClone: db.prepare('SELECT * FROM clone_tables WHERE clone_id = ? ORDER BY id ASC')
    };
  }

  create({ url, domain, status = 'queued', options = {}, outputDir = null, acquireStrategy = 'none' }) {
    const now = new Date().toISOString();
    const strategy = ['signup_auto', 'cookies', 'manual', 'none'].includes(acquireStrategy)
      ? acquireStrategy
      : 'none';
    const info = this.stmts.insert.run(
      String(url),
      String(domain),
      String(status),
      JSON.stringify(options || {}),
      outputDir ? String(outputDir) : null,
      strategy,
      now
    );
    return this.getById(Number(info.lastInsertRowid));
  }

  getById(id) {
    const row = this.stmts.getById.get(Number(id));
    return row ? this._hydrate(row) : null;
  }

  list({ status = null, search = '', limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 100), 500);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const trimmedSearch = String(search || '').trim();

    let rows;
    if (status && trimmedSearch) {
      const pattern = `%${trimmedSearch}%`;
      rows = this.stmts.searchByStatus.all(String(status), pattern, pattern, safeLimit, safeOffset);
    } else if (status) {
      rows = this.stmts.listByStatus.all(String(status), safeLimit, safeOffset);
    } else if (trimmedSearch) {
      const pattern = `%${trimmedSearch}%`;
      rows = this.stmts.searchAll.all(pattern, pattern, safeLimit, safeOffset);
    } else {
      rows = this.stmts.listAll.all(safeLimit, safeOffset);
    }
    return rows.map((r) => this._hydrate(r));
  }

  updateStatus(id, status, { error = null, startedAt = null, finishedAt = null } = {}) {
    this.stmts.updateStatus.run(
      String(status),
      error !== null ? String(error) : null,
      startedAt !== null ? String(startedAt) : null,
      finishedAt !== null ? String(finishedAt) : null,
      Number(id)
    );
    return this.getById(id);
  }

  updateProgress(id, phase, progress) {
    this.stmts.updateProgress.run(
      String(phase || 'crawl'),
      Math.max(0, Math.min(100, Number(progress) || 0)),
      Number(id)
    );
  }

  updateStats(id, { pages = 0, assets = 0, bytes = 0, endpoints = 0, tables = 0 }) {
    this.stmts.updateStats.run(
      Number(pages) || 0,
      Number(assets) || 0,
      Number(bytes) || 0,
      Number(endpoints) || 0,
      Number(tables) || 0,
      Number(id)
    );
  }

  completeClone(id, { outputDir, zipPath, summary = {} }) {
    const now = new Date().toISOString();
    this.stmts.updateResult.run(
      outputDir ? String(outputDir) : null,
      zipPath ? String(zipPath) : null,
      Number(summary.pages) || 0,
      Number(summary.assets) || 0,
      Number(summary.bytes) || 0,
      Number(summary.endpoints) || 0,
      Number(summary.tables) || 0,
      now,
      Number(id)
    );
    if (Array.isArray(summary.tableSpecs)) {
      this.saveCloneTables(id, summary.tableSpecs);
    }
    return this.getById(id);
  }

  saveCloneTables(cloneId, tableSpecs) {
    const tx = this.db.transaction((cid, specs) => {
      this.stmts.clearTablesForClone.run(Number(cid));
      for (const spec of specs) {
        this.stmts.insertTable.run(
          Number(cid),
          String(spec.table_name || spec.name || 'items'),
          JSON.stringify(spec.columns || []),
          Number(spec.rows_count || spec.rowsCount || 0)
        );
      }
    });
    tx(cloneId, tableSpecs);
  }

  listCloneTables(cloneId) {
    return this.stmts.listTablesForClone.all(Number(cloneId)).map((r) => ({
      ...r,
      columns: safeParseJson(r.columns_json, [])
    }));
  }

  delete(id) {
    return this.stmts.deleteById.run(Number(id)).changes > 0;
  }

  _hydrate(row) {
    return {
      ...row,
      options: safeParseJson(row.options_json, {})
    };
  }
}

function safeParseJson(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback;
  }
}

module.exports = { CloneRepository };
