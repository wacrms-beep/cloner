-- Migration 003 : Acquisition automatique, Gmail OAuth et comptes tests (Module 1C)

CREATE TABLE IF NOT EXISTS gmail_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'expired')),
  connected_at TEXT,
  expires_hint TEXT
);

CREATE TABLE IF NOT EXISTS test_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  email_alias TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  session_id INTEGER REFERENCES auth_sessions(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_test_accounts_domain ON test_accounts(domain);
CREATE INDEX IF NOT EXISTS idx_test_accounts_created_at ON test_accounts(created_at);

ALTER TABLE clones ADD COLUMN acquire_strategy TEXT NOT NULL DEFAULT 'none' CHECK (acquire_strategy IN ('signup_auto', 'cookies', 'manual', 'none'));
