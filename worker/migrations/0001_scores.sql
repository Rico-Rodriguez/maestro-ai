CREATE TABLE IF NOT EXISTS scores (
  score_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  midi BLOB NOT NULL
);
