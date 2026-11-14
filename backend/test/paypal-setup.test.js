import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePayPalSetup, provisionPayPal, PAYPAL_EVENTS } from '../src/paypal-setup.js';
import { DEFAULT_ORIGIN, verifyLive } from '../scripts/verify-live.mjs';

const env = { PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'fixture-client', PAYPAL_CLIENT_SECRET: 'fixture-secret',
  APP_ORIGIN: 'https://threadnews.online', INGEST_SECRET: 'fixture-admin-key-at-least-24-characters', PAYPAL_SETUP_ENABLED: 'true' };
function provider() {
  const state = { product: null, plans: [], webhooks: [], writes: [] };
  return { state, async fetchImpl(input, options = {}) {
    const url = new URL(input), path = url.pathname, method = options.method || 'GET';
    assert.equal(url.origin, 'https://api-m.sandbox.paypal.com');
    assert.equal(options.redirect, 'manual');
    if (path === '/v1/oauth2/token') return Response.json({ access_token: 'fixture-token' });
    assert.equal(options.headers.authorization, 'Bearer fixture-token');
    const body = options.body ? JSON.parse(options.body) : null;
    if (method === 'POST') state.writes.push({ path, body });
    if (path === '/v1/catalogs/products' && method === 'POST') {
      assert.ok(!body.id.startsWith('PROD-'), 'merchant SKUs must not use the system-generated product ID prefix');
      state.product = body;
      return Response.json({ id: body.id });
    }
    if (path.startsWith('/v1/catalogs/products/')) return state.product ? Response.json(state.product) : Response.json({}, { status: 404 });
    if (path === '/v1/billing/plans' && method === 'GET') return Response.json({ plans: state.plans, total_pages: 1 });
    if (path === '/v1/billing/plans' && method === 'POST') {
      const plan = { ...body, id: 'P-FIXTURE' + (state.plans.length + 1) };
      state.plans.push(plan);
      return Response.json(plan);
    }
    if (path.startsWith('/v1/billing/plans/')) return Response.json(state.plans.find(plan => path.endsWith('/' + plan.id)));
    if (path === '/v1/notifications/webhooks' && method === 'GET') return Response.json({ webhooks: state.webhooks });
    if (path === '/v1/notifications/webhooks' && method === 'POST') {
      const hook = { ...body, id: 'WH-FIXTURE1' }; state.webhooks.push(hook); return Response.json(hook);
    }
    throw new Error('Unexpected fixture endpoint');
  } };
}

test('PayPal provisioning creates exact catalog and webhook without creating a subscription or enabling charges', async () => {
  const fixture = provider();
  const result = await provisionPayPal(env, fixture);
  assert.equal(result.billingEnabled, false);
  assert.equal(result.variables.PAYPAL_PLAN_MONTHLY_ID, 'P-FIXTURE1');
  assert.equal(result.variables.PAYPAL_PLAN_ANNUAL_ID, 'P-FIXTURE2');
  assert.deepEqual(fixture.state.plans.map(plan => plan.billing_cycles[0].pricing_scheme.fixed_price.value), ['2.00', '20.00']);
  assert.equal(fixture.state.webhooks[0].url, env.APP_ORIGIN + '/api/billing/webhook');
  assert.deepEqual(fixture.state.webhooks[0].event_types.map(event => event.name), PAYPAL_EVENTS);
  assert.ok(fixture.state.writes.every(write => !/subscriptions|orders/.test(write.path)));
  assert.ok(!JSON.stringify(result).includes(env.PAYPAL_CLIENT_SECRET));
});
test('repeating provider setup reuses exact existing resources', async () => {
  const fixture = provider();
  const first = await provisionPayPal(env, fixture), writes = fixture.state.writes.length;
  const second = await provisionPayPal(env, fixture);
  assert.deepEqual(second, first);
  assert.equal(fixture.state.writes.length, writes);
});
test('provider setup rejects an existing plan with a wrong price', async () => {
  const fixture = provider();
  await provisionPayPal(env, fixture);
  fixture.state.plans[0].billing_cycles[0].pricing_scheme.fixed_price.value = '9.00';
  await assert.rejects(provisionPayPal(env, fixture), /paypal_setup_plan_mismatch/);
});
test('provider setup stops on API access denial instead of claiming readiness', async () => {
  const fetchImpl = async input => new URL(input).pathname.endsWith('/token')
    ? Response.json({ access_token: 'fixture-token' }) : Response.json({ message: 'sensitive upstream body' }, { status: 403 });
  await assert.rejects(provisionPayPal(env, { fetchImpl }), error => error.message === 'paypal_setup_http_403' && !error.message.includes('sensitive'));
});
test('setup endpoint requires administrator authentication, enable flag, and explicit environment confirmation', async () => {
  const request = (body, secret) => new Request(env.APP_ORIGIN + '/api/admin/billing/setup', { method: 'POST',
    headers: secret ? { authorization: 'Bearer ' + secret } : {}, body: JSON.stringify(body) });
  assert.equal((await handlePayPalSetup(request({}, null), env)).status, 401);
  assert.equal((await handlePayPalSetup(request({}, env.INGEST_SECRET), { ...env, PAYPAL_SETUP_ENABLED: 'false' })).status, 403);
  const response = await handlePayPalSetup(request({ environment: 'live', confirm: 'CREATE_PLANS_AND_WEBHOOK' }, env.INGEST_SECRET), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'paypal_setup_confirmation_required');
});
test('live verifier defaults to the canonical domain and reports only the failed endpoint', async () => {
  assert.equal(DEFAULT_ORIGIN, 'https://threadnews.online');
  await assert.rejects(verifyLive({ env: {}, fetchImpl: async input => {
    if (new URL(input).pathname === '/') throw new TypeError('redirect error with private runtime details');
    return Response.json({});
  } }), error => error.code === 'live_service_unreachable' && error.endpoint === '/' && !error.message.includes('private'));
});
