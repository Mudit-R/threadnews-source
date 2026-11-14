import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handlePaypal, hasPaidAccess, publicPlanCatalog, publicPlans, entitlementFromRow } from '../src/paypal.js';
import { sha256 } from '../src/feed.js';
import planConfig from '../../config/plans.json' with { type: 'json' };

const sale = JSON.parse(readFileSync(new URL('./fixtures/paypal-sale-completed.json', import.meta.url), 'utf8'));

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const DB = {
    prepare(query) {
      return {
        query,
        args: [],
        bind(...args) { return { ...this, args }; },
        async first() { return sqlite.prepare(this.query).get(...this.args) || null; },
        async all() { return { results: sqlite.prepare(this.query).all(...this.args).map(row => ({ ...row })) }; },
        async run() { return { success: true, meta: { changes: Number(sqlite.prepare(this.query).run(...this.args).changes) } }; }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  const now = Math.floor(Date.now() / 1000);
  for (const id of ['reader-subscription', 'reader-pass']) {
    sqlite.prepare('INSERT INTO users (id,provider,provider_subject,name,email,created_at) VALUES (?,?,?,?,?,?)').run(id, 'google', 'subject-' + id, 'Reader', `${id}@example.com`, now);
  }
  return { sqlite, DB, now };
}

function sandboxEnv(DB, extra = {}) {
  return {
    DB,
    APP_ORIGIN: 'https://threadnews.online',
    BILLING_ENABLED: 'true',
    PAYPAL_ENV: 'sandbox',
    PAYPAL_CLIENT_ID: 'sandbox-client-id',
    PAYPAL_CLIENT_SECRET: 'sandbox-client-secret-fixture',
    PAYPAL_WEBHOOK_ID: 'WH-SANDBOX-THREADNEWS',
    TERMS_PUBLISHED:'true', TERMS_VERSION:'fixture-2026-11-04', LEGAL_SELLER_NAME:'Fixture Seller',
    LEGAL_SELLER_TYPE:'individual', LEGAL_SELLER_ADDRESS:'Fixture correspondence address', LEGAL_SELLER_COUNTRY:'India',REFUND_WINDOW_DAYS:'14',
    ...extra
  };
}

const launchStart = Math.floor(Date.parse(planConfig.billing.billingStartsAt) / 1000);
function postLaunchEnv(DB, extra = {}) {
  return sandboxEnv(DB, {
    PAYPAL_SUBSCRIPTIONS_ACCESS: 'true',
    PAYPAL_PLAN_MONTHLY_ID: 'P-SANDBOX-MONTHLY',
    PAYPAL_PLAN_ANNUAL_ID: 'P-SANDBOX-ANNUAL',
    ...extra
  });
}

function insertSubscription(sqlite, { userId, checkoutKind = 'subscription', planKey = 'annual', subscriptionId = 'I-SANDBOX-1234567890', orderId = null, planId = 'P-SANDBOX-ANNUAL', status = 'APPROVAL_PENDING' }) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO billing_subscriptions
    (user_id,checkout_kind,plan_key,paypal_plan_id,subscription_id,order_id,request_id,approval_url,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'https://www.sandbox.paypal.com/approve',?,?,?)`).run(
      userId, checkoutKind, planKey, planId, subscriptionId, orderId, crypto.randomUUID(), status, now, now
    );
}

function mockPayPal(verificationStatus = 'SUCCESS') {
  const original = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'sandbox-test-token', expires_in: 300 }, { status: 200 });
    if (url.endsWith('/v1/notifications/verify-webhook-signature')) {
      posts.push(JSON.parse(init.body));
      return Response.json({ verification_status: verificationStatus }, { status: 200 });
    }
    throw new Error(`Unexpected network request in PayPal fixture test: ${url}`);
  };
  return { posts, restore() { globalThis.fetch = original; } };
}

function webhookRequest(event) {
  return new Request('https://threadnews.online/api/billing/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-TEST',
      'paypal-transmission-id': 'transmission-fixture-id',
      'paypal-transmission-sig': 'fixture-signature',
      'paypal-transmission-time': '2026-11-04T12:00:02Z'
    },
    body: JSON.stringify(event)
  });
}

test('public billing catalog contains the configured prices and distinguishes planned features', () => {
  const catalog = publicPlanCatalog();
  assert.deepEqual(catalog.plans.map(plan => [plan.key, plan.price, plan.interval]), [
    ['monthly', '2.00', 'month'], ['annual', '20.00', 'year']
  ]);
  assert.equal(catalog.billing.freeThroughDate, '2026-11-30');
  assert.equal(catalog.billing.billingStartsAt, '2026-11-30T18:30:00.000Z');
  assert(catalog.plans[0].plannedFeatures.includes('Email alerts'));
  assert(!JSON.stringify(catalog).includes('PAYPAL_PLAN_MONTHLY_ID'));
});

test('billing stays closed when configuration or D1 migration is missing', async () => {
  const f = fixture();
  const result = await publicPlans(sandboxEnv(f.DB, { BILLING_ENABLED: 'false' }));
  assert.equal(result.enabled, false);
  assert(result.plans.every(plan => !plan.available));
  assert(result.missingSetup.some(item => item.includes('BILLING_ENABLED')));
  assert.equal((await publicPlans({ BILLING_ENABLED: 'true', PAYPAL_ENV: 'live' })).environment, 'live');
});

test('all readers stay open through the free period; the paywall begins only after billing is ready', async () => {
  const f = fixture();
  assert.equal(await hasPaidAccess({}, null, launchStart - 1), true, 'guests receive full access during the free period');
  assert.equal(await hasPaidAccess(sandboxEnv(f.DB), 'reader-subscription', launchStart + 1), true, 'incomplete billing setup keeps access open after the date');
  const ready = postLaunchEnv(f.DB);
  assert.equal(await hasPaidAccess(ready, 'reader-subscription', launchStart + 1), false, 'an unpaid account is gated after the date once billing is ready');
  insertSubscription(f.sqlite, { userId: 'reader-subscription', status: 'ACTIVE' });
  f.sqlite.prepare('UPDATE billing_subscriptions SET last_payment_at=?,access_until=? WHERE user_id=?')
    .run(launchStart, launchStart + 31 * 86400, 'reader-subscription');
  assert.equal(await hasPaidAccess(ready, 'reader-subscription', launchStart + 1), true, 'a verified active payment retains access');
});

test('live subscription checkout schedules the first charge for the published billing start', async () => {
  const f = fixture();
  const sessionToken = 'paypal-checkout-session-token-1234567890';
  await f.DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)')
    .bind(await sha256(sessionToken), 'reader-subscription', launchStart + 3600).run();
  const env = postLaunchEnv(f.DB, { PAYPAL_ENV: 'live', PAYPAL_PLAN_MONTHLY_ID: 'P-LIVE-MONTHLY' });
  const originalFetch = globalThis.fetch;
  let subscriptionBody = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'live-test-token' });
    if (url.endsWith('/v1/billing/plans/P-LIVE-MONTHLY')) return Response.json({
      status: 'ACTIVE',
      billing_cycles: [{
        sequence: 1, tenure_type: 'REGULAR', total_cycles: 0,
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        pricing_scheme: { fixed_price: { value: '2.00', currency_code: 'USD' } }
      }],
      payment_preferences: { setup_fee: { value: '0.00', currency_code: 'USD' } }
    });
    if (url.endsWith('/v1/billing/subscriptions') && init.method === 'POST') {
      subscriptionBody = JSON.parse(init.body);
      return Response.json({ id: 'I-LIVE-1234567890', status: 'APPROVAL_PENDING', start_time: planConfig.billing.billingStartsAt, links: [{ rel: 'approve', href: 'https://www.paypal.com/webapps/billing/subscriptions?ba_token=live-test' }] });
    }
    throw new Error(`Unexpected network request in live subscription test: ${url}`);
  };
  try {
    const request = new Request('https://threadnews.online/api/billing/subscriptions', {
      method: 'POST',
      headers: { origin: 'https://threadnews.online', cookie: `__Host-threadline-session=${sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ planKey: 'monthly', acceptTerms:true, termsVersion:'fixture-2026-11-04' })
    });
    const response = await handlePaypal(request, env);
    assert.equal(response.status, 200);
    assert.equal(subscriptionBody?.start_time, planConfig.billing.billingStartsAt);
    assert.equal((await response.json()).approvalUrl, 'https://www.paypal.com/webapps/billing/subscriptions?ba_token=live-test');
    const stored = await f.DB.prepare('SELECT next_billing_time FROM billing_subscriptions WHERE user_id=?').bind('reader-subscription').first();
    assert.equal(stored.next_billing_time, planConfig.billing.billingStartsAt);
    const consent=await f.DB.prepare('SELECT terms_version,amount,currency,first_charge_at FROM membership_consents WHERE user_id=?').bind('reader-subscription').first();
    assert.equal(consent.terms_version,'fixture-2026-11-04');assert.equal(consent.amount,'2.00');assert.equal(consent.currency,'USD');assert.equal(consent.first_charge_at,planConfig.billing.billingStartsAt);
  } finally { globalThis.fetch = originalFetch; }
});

test('entitlement policy requires paid status, respects pass expiry, grace and refunds', () => {
  const now = 1_800_000_000;
  assert.equal(entitlementFromRow(null, now), false);
  assert.equal(entitlementFromRow({ status: 'ACTIVE', checkout_kind: 'subscription', plan_key: 'annual', last_payment_at: now - 60, access_until: now + 10 }, now), true);
  assert.equal(entitlementFromRow({ status: 'ACTIVE', checkout_kind: 'subscription', plan_key: 'annual', last_payment_at: now - 366 * 86400, access_until: now - 1 }, now), false, 'expired active subscriptions lose access');
  assert.equal(entitlementFromRow({ status: 'ACTIVE', checkout_kind: 'subscription', plan_key: 'monthly', last_payment_at: now - 15 * 86400 }, now), true, 'missing paid-through dates use one monthly period');
  assert.equal(entitlementFromRow({ status: 'ACTIVE', checkout_kind: 'subscription', plan_key: 'monthly', last_payment_at: now - 32 * 86400 }, now), false, 'the fallback period cannot extend an old monthly payment');
  assert.equal(entitlementFromRow({ status: 'ACTIVE', checkout_kind: 'order', last_payment_at: now - 60, access_until: now + 10 }, now), true);
  assert.equal(entitlementFromRow({ status: 'ACTIVE', checkout_kind: 'order', plan_key: 'annual_pass', last_payment_at: now - 365 * 86400, access_until: now + 10 }, now), true, 'a current one-time annual pass keeps access');
  assert.equal(entitlementFromRow({ status: 'ACTIVE', checkout_kind: 'order', plan_key: 'annual_pass', last_payment_at: now - 366 * 86400, access_until: now - 1 }, now), false, 'an expired one-time annual pass loses access');
  assert.equal(entitlementFromRow({ status: 'PAYMENT_FAILED', last_payment_at: now - 60, grace_until: now + 10 }, now), true);
  assert.equal(entitlementFromRow({ status: 'CANCELLED', last_payment_at: now - 60, access_until: now - 1 }, now), false);
  assert.equal(entitlementFromRow({ status: 'REFUNDED', last_payment_at: now - 60, access_until: now + 500 }, now), false);
});

test('verified subscription sale grants access once; repeated and stale events cannot rewind the payment', async () => {
  const f = fixture();
  insertSubscription(f.sqlite, { userId: 'reader-subscription' });
  const paypal = mockPayPal();
  try {
    let response = await handlePaypal(webhookRequest(sale), sandboxEnv(f.DB));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicate, false);
    assert.equal(paypal.posts[0].webhook_id, 'WH-SANDBOX-THREADNEWS');
    assert.equal(paypal.posts[0].webhook_event.id, sale.id);
    let row = f.sqlite.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get('reader-subscription');
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.last_payment_ref, 'SALE-SANDBOX-000001');
    assert.equal(await hasPaidAccess(postLaunchEnv(f.DB), 'reader-subscription', launchStart + 1), true);

    response = await handlePaypal(webhookRequest(sale), sandboxEnv(f.DB));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicate, true);

    const stale = structuredClone(sale);
    stale.id = 'WH-SANDBOX-SALE-STALE';
    stale.create_time = '2026-11-04T11:00:00Z';
    response = await handlePaypal(webhookRequest(stale), sandboxEnv(f.DB));
    assert.equal(response.status, 200);
    row = f.sqlite.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').get('reader-subscription');
    assert.equal(row.last_payment_at, Math.floor(Date.parse(sale.create_time) / 1000));
    assert.equal(await hasPaidAccess(postLaunchEnv(f.DB), 'reader-subscription', launchStart + 1), true);
  } finally { paypal.restore(); }
});

test('failed webhook verification never updates D1 or grants access', async () => {
  const f = fixture();
  insertSubscription(f.sqlite, { userId: 'reader-subscription' });
  const paypal = mockPayPal('FAILURE');
  try {
    const response = await handlePaypal(webhookRequest(sale), sandboxEnv(f.DB));
    assert.equal(response.status, 401);
    assert.equal(f.sqlite.prepare('SELECT status FROM billing_subscriptions WHERE user_id=?').get('reader-subscription').status, 'APPROVAL_PENDING');
    assert.equal(await hasPaidAccess(postLaunchEnv(f.DB), 'reader-subscription', launchStart + 1), false);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM paypal_webhook_events').get().n, 0);
  } finally { paypal.restore(); }
});

test('signed payment mismatches are acknowledged without granting access, even while new checkout is disabled', async () => {
  const f = fixture();
  insertSubscription(f.sqlite, { userId: 'reader-subscription' });
  const paypal = mockPayPal();
  try {
    const mismatched = structuredClone(sale);
    mismatched.resource.amount.total = '1.00';
    const env = sandboxEnv(f.DB, { BILLING_ENABLED: 'false' });
    const response = await handlePaypal(webhookRequest(mismatched), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ignored, true);
    assert.equal(f.sqlite.prepare('SELECT status FROM billing_subscriptions WHERE user_id=?').get('reader-subscription').status, 'APPROVAL_PENDING');
    assert.equal(await hasPaidAccess(postLaunchEnv(f.DB), 'reader-subscription', launchStart + 1), false);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM paypal_webhook_events').get().n, 1);
  } finally { paypal.restore(); }
});
