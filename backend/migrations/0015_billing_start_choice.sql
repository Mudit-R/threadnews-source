ALTER TABLE billing_subscriptions ADD COLUMN billing_start_choice TEXT NOT NULL DEFAULT 'scheduled'
  CHECK (billing_start_choice IN ('scheduled', 'immediate'));

ALTER TABLE membership_consents ADD COLUMN billing_start_choice TEXT NOT NULL DEFAULT 'scheduled'
  CHECK (billing_start_choice IN ('scheduled', 'immediate'));
