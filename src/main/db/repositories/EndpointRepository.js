/**
 * Dépôt pour les endpoints XHR/Fetch capturés lors d'un clonage (table clone_endpoints).
 * 100 % requêtes préparées.
 */
class EndpointRepository {
  /**
   * @param {import('../Database').AppDatabase} db
   */
  constructor(db) {
    this.db = db;
    this.stmts = {
      findExisting: db.prepare(`
        SELECT id, hits FROM clone_endpoints
        WHERE clone_id = ? AND method = ? AND normalized_path = ?
        LIMIT 1
      `),
      insert: db.prepare(`
        INSERT INTO clone_endpoints (
          clone_id, method, normalized_path, sample_url,
          request_example_json, response_example_json,
          status_code, content_type, hits
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateExisting: db.prepare(`
        UPDATE clone_endpoints
        SET hits = ?,
            sample_url = ?,
            request_example_json = COALESCE(?, request_example_json),
            response_example_json = COALESCE(?, response_example_json),
            status_code = ?
        WHERE id = ?
      `),
      listByClone: db.prepare('SELECT * FROM clone_endpoints WHERE clone_id = ? ORDER BY id ASC')
    };
  }

  upsert({
    cloneId,
    method = 'GET',
    normalizedPath,
    sampleUrl,
    requestExample = null,
    responseExample = null,
    statusCode = 200,
    contentType = 'application/json',
    hits = 1
  }) {
    const cid = Number(cloneId);
    const normMethod = String(method).toUpperCase();
    const normPath = String(normalizedPath);
    const reqJson = requestExample !== null && requestExample !== undefined
      ? (typeof requestExample === 'string' ? requestExample : JSON.stringify(requestExample))
      : null;
    const resJson = responseExample !== null && responseExample !== undefined
      ? (typeof responseExample === 'string' ? responseExample : JSON.stringify(responseExample))
      : null;

    const existing = this.stmts.findExisting.get(cid, normMethod, normPath);
    if (existing) {
      const nextHits = Math.max(Number(existing.hits) + 1, Number(hits) || 1);
      this.stmts.updateExisting.run(
        nextHits,
        String(sampleUrl || normPath),
        reqJson,
        resJson,
        Number(statusCode) || 200,
        existing.id
      );
      return existing.id;
    }

    const info = this.stmts.insert.run(
      cid,
      normMethod,
      normPath,
      String(sampleUrl || normPath),
      reqJson,
      resJson,
      Number(statusCode) || 200,
      String(contentType || 'application/json'),
      Number(hits) || 1
    );
    return Number(info.lastInsertRowid);
  }

  listByClone(cloneId) {
    return this.stmts.listByClone.all(Number(cloneId)).map((row) => ({
      ...row,
      requestExample: safeParse(row.request_example_json),
      responseExample: safeParse(row.response_example_json)
    }));
  }
}

function safeParse(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (_) {
    return str;
  }
}

module.exports = { EndpointRepository };
