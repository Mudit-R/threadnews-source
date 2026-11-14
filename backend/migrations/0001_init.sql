CREATE TABLE IF NOT EXISTS news (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  original_headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL,
  region TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  source_json TEXT NOT NULL,
  official_sources_json TEXT NOT NULL DEFAULT '[]',
  event_id TEXT,
  feed_id TEXT NOT NULL,
  data_mode TEXT NOT NULL DEFAULT 'automatic'
);
CREATE INDEX IF NOT EXISTS news_published ON news(published_at DESC);
CREATE INDEX IF NOT EXISTS news_category_published ON news(category, published_at DESC);
CREATE INDEX IF NOT EXISTS news_region_published ON news(region, published_at DESC);
CREATE TABLE IF NOT EXISTS feed_state (
  id TEXT PRIMARY KEY,
  last_attempt_at TEXT,
  last_success_at TEXT,
  etag TEXT,
  modified TEXT,
  error TEXT,
  item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  email TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_attempts(expires_at);
CREATE TABLE IF NOT EXISTS preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  topics_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
