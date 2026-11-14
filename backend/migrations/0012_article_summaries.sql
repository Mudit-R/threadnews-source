CREATE TABLE article_summaries (
  news_id TEXT PRIMARY KEY REFERENCES news(id) ON DELETE CASCADE,
  evidence_hash TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  answer_json TEXT
);
