-- Keep rejected article metadata for review without publishing the article.
-- The source URL is unique so repeated feed refreshes update one bounded row.
CREATE TABLE IF NOT EXISTS article_category_rejections (
  canonical_url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  submitted_category TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  reject_reason TEXT NOT NULL CHECK (reject_reason IN ('category_missing', 'category_not_allowed')),
  feed_id TEXT NOT NULL,
  data_mode TEXT NOT NULL CHECK (data_mode IN ('automatic', 'manual', 'seed', 'curated')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count > 0)
);
CREATE INDEX IF NOT EXISTS article_category_rejections_recent
  ON article_category_rejections(last_seen_at DESC, reject_reason);
