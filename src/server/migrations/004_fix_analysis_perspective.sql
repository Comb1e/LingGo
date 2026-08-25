-- KataGo was configured to report Black's perspective, but older LingGo
-- versions inverted White-to-play positions as if values were side-to-move.
UPDATE position_analyses
SET
  black_win_rate = 1.0 - black_win_rate,
  white_win_rate = 1.0 - white_win_rate,
  black_score_lead = -black_score_lead
WHERE substr(position_hash, -2) = ':W';
