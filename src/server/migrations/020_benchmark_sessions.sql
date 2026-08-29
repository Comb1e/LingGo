ALTER TABLE benchmark_runs ADD COLUMN session_id TEXT;
ALTER TABLE benchmark_runs ADD COLUMN stage_key TEXT;

CREATE TABLE benchmark_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  stage_ids_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX one_active_benchmark_session_per_profile
ON benchmark_sessions (profile_id)
WHERE status IN ('setup', 'running', 'awaiting_continue', 'restarting_stage', 'error');

CREATE TABLE benchmark_session_stages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  run_id TEXT REFERENCES benchmark_runs(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  writable_notebook_role TEXT NOT NULL,
  start_notebook_content TEXT,
  metrics_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, stage_key)
);

CREATE UNIQUE INDEX one_active_child_stage_per_session
ON benchmark_runs (session_id)
WHERE session_id IS NOT NULL AND status IN ('queued', 'running', 'paused');

CREATE TABLE benchmark_session_notebook_snapshots (
  session_id TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  notebook_name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  stage_key TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, role)
);

CREATE TABLE benchmark_session_notebook_versions (
  session_id TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_phase TEXT NOT NULL,
  content TEXT NOT NULL,
  digest TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, role, stage_key, attempt, version)
);

CREATE INDEX benchmark_session_versions_by_stage
ON benchmark_session_notebook_versions (session_id, stage_key, role, attempt, version);
