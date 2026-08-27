CREATE TABLE benchmark_notebook_seeds (
  run_id TEXT PRIMARY KEY REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  notebook_id TEXT,
  content TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
