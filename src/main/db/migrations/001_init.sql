-- Migration 001 : Schéma initial de Universal Clone

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legal_acceptance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accepted_at TEXT NOT NULL,
  app_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  plan TEXT NOT NULL,
  key_hash TEXT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT NULL
);

CREATE TABLE IF NOT EXISTS clones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','done','failed','cancelled','interrupted')),
  options_json TEXT NOT NULL DEFAULT '{}',
  output_dir TEXT,
  zip_path TEXT,
  pages_count INTEGER NOT NULL DEFAULT 0,
  assets_count INTEGER NOT NULL DEFAULT 0,
  assets_bytes INTEGER NOT NULL DEFAULT 0,
  endpoints_count INTEGER NOT NULL DEFAULT 0,
  tables_count INTEGER NOT NULL DEFAULT 0,
  current_phase TEXT NOT NULL DEFAULT 'prepare',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS clone_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clone_id INTEGER NOT NULL REFERENCES clones(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  local_path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 200,
  title TEXT NOT NULL DEFAULT '',
  depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clone_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clone_id INTEGER NOT NULL REFERENCES clones(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  sample_url TEXT NOT NULL,
  request_example_json TEXT,
  response_example_json TEXT,
  status_code INTEGER NOT NULL DEFAULT 200,
  content_type TEXT NOT NULL DEFAULT 'application/json',
  hits INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clone_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clone_id INTEGER NOT NULL REFERENCES clones(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  rows_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clone_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clone_id INTEGER NOT NULL REFERENCES clones(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clones_status ON clones(status);
CREATE INDEX IF NOT EXISTS idx_clone_logs_clone_ts ON clone_logs(clone_id, ts);
CREATE INDEX IF NOT EXISTS idx_clone_pages_clone ON clone_pages(clone_id);
