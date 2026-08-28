CREATE TABLE benchmark_problem_attempts (
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  problem_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  actual_action_json TEXT,
  expected_action_json TEXT NOT NULL,
  legal INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  first_response INTEGER NOT NULL,
  failure_reason TEXT,
  notebook_version_before INTEGER NOT NULL,
  notebook_version_after INTEGER,
  prompt_digest TEXT NOT NULL,
  response_digest TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);
CREATE INDEX benchmark_problem_attempts_by_run ON benchmark_problem_attempts(run_id, sequence);
