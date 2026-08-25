CREATE TABLE IF NOT EXISTS katago_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  executable_path TEXT NOT NULL,
  model_path TEXT NOT NULL,
  config_path TEXT NOT NULL,
  analysis_visits INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO katago_settings
  (singleton, executable_path, model_path, config_path, analysis_visits, updated_at)
VALUES (
  1,
  '/home/comb1e/tools/KataGo/cpp/katago',
  '/root/.local/share/pipx/venvs/katrain/lib/python3.12/site-packages/katrain/models/b10c384h6nbttflrs.bin.gz',
  '/root/.local/share/pipx/venvs/katrain/lib/python3.12/site-packages/katrain/KataGo/analysis_config.cfg',
  500,
  CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_analysis_state (
  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS position_analyses (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  turn INTEGER NOT NULL,
  black_win_rate REAL NOT NULL,
  white_win_rate REAL NOT NULL,
  black_score_lead REAL NOT NULL,
  visits INTEGER NOT NULL,
  position_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (game_id, turn)
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  run_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_live_benchmark
ON benchmark_runs ((1))
WHERE status IN ('queued', 'running', 'paused');

CREATE TABLE IF NOT EXISTS benchmark_games (
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  game_index INTEGER NOT NULL,
  PRIMARY KEY (run_id, game_id),
  UNIQUE (run_id, game_index)
);
