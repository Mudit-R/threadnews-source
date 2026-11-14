-- Reading saves are account-owned identifiers, not copies of publisher content.
-- No FK to news: expiring a headline must not silently remove a reader's save.
CREATE TABLE reading_saves (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL CHECK (record_type IN ('article', 'event')),
  record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 120),
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, record_type, record_id)
);
CREATE TABLE reading_collection_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL
);
