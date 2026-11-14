CREATE TABLE source_summary_jobs (
  news_id TEXT PRIMARY KEY REFERENCES news(id) ON DELETE CASCADE,
  next_attempt_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE source_summary_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  day TEXT NOT NULL,
  used INTEGER NOT NULL CHECK (used > 0)
);
