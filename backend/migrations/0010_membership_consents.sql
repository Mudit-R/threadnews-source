CREATE TABLE membership_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  first_charge_at TEXT,
  accepted_at INTEGER NOT NULL
);
CREATE INDEX membership_consents_user ON membership_consents(user_id, accepted_at);
