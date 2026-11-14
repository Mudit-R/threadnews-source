-- Schema only. Run scripts/import-content.mjs explicitly to backfill curated metadata.
ALTER TABLE news ADD COLUMN publisher TEXT NOT NULL DEFAULT '';
ALTER TABLE news ADD COLUMN source_type TEXT NOT NULL DEFAULT '';
ALTER TABLE news ADD COLUMN official_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE news ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE news ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX news_page ON news(published_at DESC, id DESC);
CREATE INDEX news_publisher_page ON news(publisher, published_at DESC, id DESC);
CREATE INDEX news_evidence_page ON news(source_type, official_count, published_at DESC, id DESC);

CREATE TABLE article_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'metadata_update'
);
CREATE INDEX article_revisions_news ON article_revisions(news_id, id DESC);

CREATE TABLE article_source_lineage (
  news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (news_id, feed_id, source_url)
);

CREATE TABLE event_payloads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  region TEXT NOT NULL,
  coverage_end TEXT,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX event_payloads_updated ON event_payloads(updated_at DESC, id);

CREATE TABLE content_documents (
  id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
