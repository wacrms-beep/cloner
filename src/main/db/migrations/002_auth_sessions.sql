-- Migration 002 : Sessions authentifiées (Module 1B)

CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL DEFAULT 'manual' CHECK (strategy IN ('signup_auto', 'cookies', 'manual')),
  vault_key TEXT NOT NULL UNIQUE,
  cookies_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_domain ON auth_sessions(domain);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_strategy ON auth_sessions(strategy);
