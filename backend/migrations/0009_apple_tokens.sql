-- Apple refresh tokens are encrypted with a Worker-only AES-GCM key.
-- No provider password, access token, or plaintext refresh token is stored.
CREATE TABLE apple_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_token TEXT NOT NULL CHECK (length(encrypted_token) BETWEEN 40 AND 16384),
  updated_at INTEGER NOT NULL
);
CREATE TABLE apple_notification_events (
  event_hash TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
CREATE INDEX apple_notification_age ON apple_notification_events(processed_at);
