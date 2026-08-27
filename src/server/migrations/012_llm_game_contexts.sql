CREATE TABLE llm_game_contexts (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  color TEXT NOT NULL CHECK (color IN ('B', 'W')),
  status TEXT NOT NULL CHECK (
    status IN (
      'uninitialized',
      'active',
      'repairing',
      'reflecting',
      'needs_rebase',
      'complete'
    )
  ),
  profile_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  last_observed_move INTEGER NOT NULL DEFAULT 0,
  transcript_json TEXT NOT NULL DEFAULT '[]',
  pending_turn_json TEXT,
  provider_continuation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (game_id, color)
);

CREATE INDEX llm_game_contexts_status_idx
ON llm_game_contexts (status, updated_at);
