/**
 * Dépôt pour les sessions d'authentification (auth_sessions), l'état Gmail (gmail_state)
 * et les comptes tests générés (test_accounts) — Modules 1B & 1C.
 * 100 % requêtes préparées.
 */
class AuthRepository {
  /**
   * @param {import('../Database').AppDatabase} db
   */
  constructor(db) {
    this.db = db;
    this.stmts = {
      // gmail_state
      getGmailState: db.prepare('SELECT id, email, status, connected_at, expires_hint FROM gmail_state WHERE id = 1'),
      upsertGmailState: db.prepare(`
        INSERT INTO gmail_state (id, email, status, connected_at, expires_hint)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          status = excluded.status,
          connected_at = excluded.connected_at,
          expires_hint = excluded.expires_hint
      `),

      // auth_sessions
      insertSession: db.prepare(`
        INSERT INTO auth_sessions (
          domain, label, strategy, vault_key, cookies_count, status, created_at, updated_at, last_used_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateSession: db.prepare(`
        UPDATE auth_sessions
        SET label = ?, cookies_count = ?, status = ?, updated_at = ?, expires_at = ?
        WHERE id = ?
      `),
      touchSessionUsed: db.prepare('UPDATE auth_sessions SET last_used_at = ?, updated_at = ? WHERE id = ?'),
      updateSessionStatus: db.prepare('UPDATE auth_sessions SET status = ?, updated_at = ? WHERE id = ?'),
      getSessionById: db.prepare('SELECT * FROM auth_sessions WHERE id = ?'),
      getSessionByVaultKey: db.prepare('SELECT * FROM auth_sessions WHERE vault_key = ?'),
      listSessions: db.prepare('SELECT * FROM auth_sessions ORDER BY updated_at DESC, id DESC'),
      listSessionsByDomain: db.prepare('SELECT * FROM auth_sessions WHERE domain = ? ORDER BY updated_at DESC, id DESC'),
      deleteSessionById: db.prepare('DELETE FROM auth_sessions WHERE id = ?'),

      // test_accounts
      insertAccount: db.prepare(`
        INSERT INTO test_accounts (
          domain, email_alias, username, password_enc, created_at, verified, session_id, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateAccountVerified: db.prepare(`
        UPDATE test_accounts
        SET verified = ?, session_id = COALESCE(?, session_id), notes = COALESCE(?, notes)
        WHERE id = ?
      `),
      getAccountById: db.prepare('SELECT * FROM test_accounts WHERE id = ?'),
      getAccountByDomain: db.prepare('SELECT * FROM test_accounts WHERE domain = ? ORDER BY id DESC LIMIT 1'),
      listAccounts: db.prepare('SELECT * FROM test_accounts ORDER BY id DESC'),
      countAccountsSince: db.prepare('SELECT COUNT(*) AS cnt FROM test_accounts WHERE created_at >= ?'),
      deleteAccountById: db.prepare('DELETE FROM test_accounts WHERE id = ?')
    };
  }

  // =========================================================================
  // GMAIL STATE
  // =========================================================================

  getGmailState() {
    return this.stmts.getGmailState.get() || {
      id: 1,
      email: '',
      status: 'disconnected',
      connected_at: null,
      expires_hint: null
    };
  }

  saveGmailState({ email = '', status = 'disconnected', connectedAt = null, expiresHint = null }) {
    this.stmts.upsertGmailState.run(
      String(email || ''),
      String(status || 'disconnected'),
      connectedAt ? String(connectedAt) : null,
      expiresHint ? String(expiresHint) : null
    );
    return this.getGmailState();
  }

  // =========================================================================
  // AUTH SESSIONS
  // =========================================================================

  createOrUpdateSession({
    domain,
    label = '',
    strategy = 'manual',
    vaultKey,
    cookiesCount = 0,
    status = 'active',
    expiresAt = null
  }) {
    const cleanDomain = String(domain || '').toLowerCase().trim();
    const cleanStrategy = ['signup_auto', 'cookies', 'manual'].includes(strategy) ? strategy : 'manual';
    const now = new Date().toISOString();

    const existing = this.stmts.getSessionByVaultKey.get(String(vaultKey));
    if (existing) {
      this.stmts.updateSession.run(
        String(label || existing.label || cleanDomain),
        Number(cookiesCount) || 0,
        String(status || 'active'),
        now,
        expiresAt ? String(expiresAt) : null,
        Number(existing.id)
      );
      return this.getSessionById(existing.id);
    }

    const info = this.stmts.insertSession.run(
      cleanDomain,
      String(label || cleanDomain),
      cleanStrategy,
      String(vaultKey),
      Number(cookiesCount) || 0,
      String(status || 'active'),
      now,
      now,
      now,
      expiresAt ? String(expiresAt) : null
    );
    return this.getSessionById(Number(info.lastInsertRowid));
  }

  getSessionById(id) {
    return this.stmts.getSessionById.get(Number(id)) || null;
  }

  getSessionByVaultKey(vaultKey) {
    return this.stmts.getSessionByVaultKey.get(String(vaultKey)) || null;
  }

  listSessions(domain = null) {
    if (domain) {
      return this.stmts.listSessionsByDomain.all(String(domain).toLowerCase().trim());
    }
    return this.stmts.listSessions.all();
  }

  /**
   * Retourne les sessions actives pour un domaine triées selon la priorité stricte §5 :
   * cookies > signup_auto (compte test) > manual
   */
  getActiveSessionsForDomain(domain) {
    const cleanDomain = String(domain || '').toLowerCase().trim();
    const all = this.stmts.listSessionsByDomain.all(cleanDomain).filter((s) => s.status === 'active');
    const priorityRank = { cookies: 1, signup_auto: 2, manual: 3 };
    return all.sort((a, b) => {
      const pa = priorityRank[a.strategy] || 99;
      const pb = priorityRank[b.strategy] || 99;
      if (pa !== pb) return pa - pb;
      return b.id - a.id;
    });
  }

  touchSessionUsed(id) {
    const now = new Date().toISOString();
    this.stmts.touchSessionUsed.run(now, now, Number(id));
  }

  updateSessionStatus(id, status) {
    const now = new Date().toISOString();
    this.stmts.updateSessionStatus.run(String(status), now, Number(id));
    return this.getSessionById(id);
  }

  deleteSession(id) {
    return this.stmts.deleteSessionById.run(Number(id)).changes > 0;
  }

  // =========================================================================
  // TEST ACCOUNTS
  // =========================================================================

  createTestAccount({
    domain,
    emailAlias,
    username,
    passwordEnc,
    verified = 0,
    sessionId = null,
    notes = ''
  }) {
    const now = new Date().toISOString();
    const info = this.stmts.insertAccount.run(
      String(domain).toLowerCase().trim(),
      String(emailAlias),
      String(username),
      String(passwordEnc),
      now,
      verified ? 1 : 0,
      sessionId ? Number(sessionId) : null,
      String(notes || '')
    );
    return this.getAccountById(Number(info.lastInsertRowid));
  }

  updateAccountVerified(id, { verified = 1, sessionId = null, notes = null } = {}) {
    this.stmts.updateAccountVerified.run(
      verified ? 1 : 0,
      sessionId !== null ? Number(sessionId) : null,
      notes !== null ? String(notes) : null,
      Number(id)
    );
    return this.getAccountById(id);
  }

  getAccountById(id) {
    return this.stmts.getAccountById.get(Number(id)) || null;
  }

  getAccountByDomain(domain) {
    return this.stmts.getAccountByDomain.get(String(domain || '').toLowerCase().trim()) || null;
  }

  listAccounts() {
    return this.stmts.listAccounts.all();
  }

  countAccountsCreatedSince(isoTimestamp) {
    const row = this.stmts.countAccountsSince.get(String(isoTimestamp));
    return row ? Number(row.cnt) : 0;
  }

  deleteAccount(id) {
    return this.stmts.deleteAccountById.run(Number(id)).changes > 0;
  }
}

module.exports = { AuthRepository };
