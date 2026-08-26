DROP INDEX IF EXISTS one_live_benchmark;

CREATE UNIQUE INDEX one_live_benchmark_per_profile
ON benchmark_runs (profile_id)
WHERE status IN ('queued', 'running', 'paused');
