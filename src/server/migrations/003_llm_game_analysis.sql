ALTER TABLE game_analysis_state
ADD COLUMN share_with_llm INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO game_analysis_state
  (game_id, enabled, share_with_llm, status, updated_at)
SELECT
  id,
  1,
  0,
  'idle',
  CURRENT_TIMESTAMP
FROM games
WHERE json_extract(game_json, '$.benchmarkRunId') IS NULL;
