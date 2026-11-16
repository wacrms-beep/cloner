/**
 * Dépôt pour les journaux d'exécution d'un clone (table clone_logs).
 * 100 % requêtes préparées.
 */
class LogRepository {
  /**
   * @param {import('../Database').AppDatabase} db
   */
  constructor(db) {
    this.db = db;
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO clone_logs (clone_id, level, phase, message, data_json, ts)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      listByClone: db.prepare(`
        SELECT * FROM clone_logs
        WHERE clone_id = ?
        ORDER BY id ASC
        LIMIT ? OFFSET ?
      `),
      listByCloneAndLevel: db.prepare(`
        SELECT * FROM clone_logs
        WHERE clone_id = ? AND level = ?
        ORDER BY id ASC
        LIMIT ? OFFSET ?
      `)
    };
  }

  add({ cloneId, level = 'info', phase = 'general', message = '', data = null, ts = null }) {
    const timestamp = ts ? String(ts) : new Date().toISOString();
    const dataJson = data !== null && data !== undefined ? JSON.stringify(data) : null;
    const info = this.stmts.insert.run(
      Number(cloneId),
      String(level),
      String(phase),
      String(message),
      dataJson,
      timestamp
    );
    return Number(info.lastInsertRowid);
  }

  listByClone(cloneId, { level = null, limit = 1000, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 1000), 5000);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const rows = level
      ? this.stmts.listByCloneAndLevel.all(Number(cloneId), String(level), safeLimit, safeOffset)
      : this.stmts.listByClone.all(Number(cloneId), safeLimit, safeOffset);

    return rows.map((r) => ({
      ...r,
      data: r.data_json ? safeParse(r.data_json) : null
    }));
  }
}

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

module.exports = { LogRepository };
