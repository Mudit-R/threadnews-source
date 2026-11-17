CREATE TABLE watchlist_checkpoints (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  checked_through TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX news_watchlist_event_time ON news(event_id, ingested_at DESC, id DESC) WHERE event_id IS NOT NULL;

CREATE TRIGGER remove_unfollowed_checkpoint AFTER DELETE ON reading_saves
WHEN OLD.record_type = 'event'
BEGIN
  DELETE FROM watchlist_checkpoints WHERE user_id = OLD.user_id AND event_id = OLD.record_id;
END;
