CREATE TABLE technique_notebooks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (profile_id, name_key)
);

CREATE TABLE benchmark_notebook_snapshots (
  run_id TEXT PRIMARY KEY REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  notebook_id TEXT,
  notebook_name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
