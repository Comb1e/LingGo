CREATE TABLE benchmark_notebook_versions (
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_phase TEXT NOT NULL,
  content TEXT NOT NULL,
  digest TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, version)
);

CREATE TABLE benchmark_move_reviews (
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  game_index INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  review_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, game_id, turn)
);

CREATE INDEX benchmark_move_reviews_by_run
ON benchmark_move_reviews (run_id, game_index, turn);
