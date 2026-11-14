-- Automatic coverage is source metadata, separate from reviewed milestones.
-- It deliberately does not reference news: the current-news retention policy
-- must not erase the history of reporting around an ongoing event.
CREATE TABLE event_tracking (
  event_id TEXT PRIMARY KEY REFERENCES event_payloads(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  rules_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE event_coverage (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES event_payloads(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  news_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (event_id, source_url)
);
CREATE INDEX event_coverage_page ON event_coverage(event_id, published_at DESC, id DESC);

CREATE TABLE event_coverage_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coverage_id TEXT NOT NULL REFERENCES event_coverage(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX event_coverage_revision_page ON event_coverage_revisions(coverage_id, id DESC);
