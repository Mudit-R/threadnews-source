-- Billing records contain PayPal identifiers and access state only. PayPal
-- remains responsible for storing payment instruments; ThreadNews never stores
-- card or bank details.
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  checkout_kind TEXT NOT NULL CHECK (checkout_kind IN ('subscription', 'order')),
  plan_key TEXT NOT NULL,
  paypal_plan_id TEXT,
  subscription_id TEXT UNIQUE,
  order_id TEXT UNIQUE,
  request_id TEXT,
  approval_url TEXT,
  status TEXT NOT NULL,
  next_billing_time TEXT,
  last_payment_at INTEGER,
  last_payment_ref TEXT,
  access_until INTEGER,
  grace_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS billing_subscription_status ON billing_subscriptions(status, access_until);
CREATE TABLE IF NOT EXISTS paypal_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  processed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS founding_claims (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'claimed')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS founding_claims_capacity ON founding_claims(state, expires_at);
