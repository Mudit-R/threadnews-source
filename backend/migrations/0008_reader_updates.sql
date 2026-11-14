CREATE TABLE IF NOT EXISTS reader_updates (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unsubscribed' CHECK(status IN ('pending','confirmed','unsubscribed')),
  alerts_enabled INTEGER NOT NULL DEFAULT 0 CHECK(alerts_enabled IN (0,1)),
  weekly_enabled INTEGER NOT NULL DEFAULT 0 CHECK(weekly_enabled IN (0,1)),
  confirm_hash TEXT,
  confirm_expires_at INTEGER,
  confirm_sent_at INTEGER,
  confirmed_at INTEGER,
  last_alert_at INTEGER NOT NULL DEFAULT 0,
  alert_cursor_at TEXT NOT NULL DEFAULT '',
  alert_cursor_id TEXT NOT NULL DEFAULT '',
  last_weekly_at INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  feed_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reader_updates_confirmation ON reader_updates(confirm_hash) WHERE confirm_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS reader_updates_dispatch ON reader_updates(status,last_checked_at,user_id);
CREATE TABLE IF NOT EXISTS reader_email_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('confirm','alerts','weekly')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','sent','failed')),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  provider_id TEXT
);
CREATE INDEX IF NOT EXISTS reader_outbox_delivery ON reader_email_outbox(state,next_attempt_at,lease_until,created_at);
CREATE INDEX IF NOT EXISTS reader_outbox_user ON reader_email_outbox(user_id,kind,state);
CREATE TABLE IF NOT EXISTS reader_email_budget (
  day INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0
);
