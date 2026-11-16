/**
 * Dépôt pour les pages aspirées d'un clone (table clone_pages).
 * 100 % requêtes préparées.
 */
class PageRepository {
  /**
   * @param {import('../Database').AppDatabase} db
   */
  constructor(db) {
    this.db = db;
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO clone_pages (clone_id, url, local_path, status_code, title, depth, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      listByClone: db.prepare('SELECT * FROM clone_pages WHERE clone_id = ? ORDER BY id ASC LIMIT ? OFFSET ?'),
      countByClone: db.prepare('SELECT COUNT(*) AS total FROM clone_pages WHERE clone_id = ?')
    };
  }

  add({ cloneId, url, localPath, status = 200, title = '', depth = 0 }) {
    const now = new Date().toISOString();
    const info = this.stmts.insert.run(
      Number(cloneId),
      String(url),
      String(localPath),
      Number(status) || 200,
      String(title || ''),
      Number(depth) || 0,
      now
    );
    return Number(info.lastInsertRowid);
  }

  listByClone(cloneId, { limit = 500, offset = 0 } = {}) {
    return this.stmts.listByClone.all(Number(cloneId), Number(limit) || 500, Number(offset) || 0);
  }

  countByClone(cloneId) {
    const row = this.stmts.countByClone.get(Number(cloneId));
    return row ? Number(row.total) : 0;
  }
}

module.exports = { PageRepository };
