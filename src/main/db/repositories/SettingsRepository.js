/**
 * Dépôt pour les paramètres de l'application, l'acceptation des mentions légales
 * et l'état de la licence. 100 % requêtes préparées.
 */
class SettingsRepository {
  /**
   * @param {import('../Database').AppDatabase} db
   */
  constructor(db) {
    this.db = db;
    this.stmts = {
      getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
      allSettings: db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key ASC'),
      upsertSetting: db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `),
      getLegal: db.prepare('SELECT id, accepted_at, app_version FROM legal_acceptance ORDER BY id DESC LIMIT 1'),
      insertLegal: db.prepare('INSERT INTO legal_acceptance (accepted_at, app_version) VALUES (?, ?)'),
      getLicense: db.prepare('SELECT id, status, plan, key_hash, checked_at, expires_at FROM license_state WHERE id = 1'),
      upsertLicense: db.prepare(`
        INSERT INTO license_state (id, status, plan, key_hash, checked_at, expires_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          plan = excluded.plan,
          key_hash = excluded.key_hash,
          checked_at = excluded.checked_at,
          expires_at = excluded.expires_at
      `)
    };
  }

  get(key, defaultValue = null) {
    const row = this.stmts.getSetting.get(String(key));
    if (!row) return defaultValue;
    try {
      return JSON.parse(row.value);
    } catch (_) {
      return row.value;
    }
  }

  set(key, value) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const now = new Date().toISOString();
    this.stmts.upsertSetting.run(String(key), serialized, now);
    return value;
  }

  getAll() {
    const rows = this.stmts.allSettings.all();
    const result = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch (_) {
        result[row.key] = row.value;
      }
    }
    return result;
  }

  getLegalAcceptance() {
    return this.stmts.getLegal.get() || null;
  }

  acceptLegal(appVersion = '1.0.0') {
    const now = new Date().toISOString();
    this.stmts.insertLegal.run(now, String(appVersion));
    return this.getLegalAcceptance();
  }

  getLicenseState() {
    return this.stmts.getLicense.get() || null;
  }

  saveLicenseState({ status, plan, keyHash = null, checkedAt = new Date().toISOString(), expiresAt = null }) {
    this.stmts.upsertLicense.run(
      String(status),
      String(plan),
      keyHash ? String(keyHash) : null,
      String(checkedAt),
      expiresAt ? String(expiresAt) : null
    );
    return this.getLicenseState();
  }
}

module.exports = { SettingsRepository };
