CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,          -- run id from the signed token, so each run counts once
  name TEXT NOT NULL,
  score_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores (score_ms DESC);
CREATE INDEX IF NOT EXISTS idx_scores_ip ON scores (ip_hash, created_at);
