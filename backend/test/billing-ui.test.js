import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/billing.js', import.meta.url), 'utf8');
const defaultPlans = [
  { key: 'monthly', name: 'Monthly supporter', price: '2.00', currency: 'USD', interval: 'month', checkout: 'subscription', available: true, features: ['Configured timeline archive'], plannedFeatures: ['Configured future alerts'] },
  { key: 'annual', name: 'Annual supporter', price: '20.00', currency: 'USD', interval: 'year', checkout: 'subscription', available: true, features: ['Configured timeline archive'], plannedFeatures: [] }
];

function ui({
  user = null,
  search = '',
  approvalUrl = 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=test',
  orderApprovalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=sandbox-order',
  environment = 'sandbox',
  enabled = true,
  plans = defaultPlans,
  status = { entitled: false, subscription: null },
  subscriptionConfirmation = { entitled: true, subscription: { status: 'ACTIVE', planKey: 'annual', checkoutKind: 'subscription' } },
  orderConfirmation = { entitled: true, subscription: { status: 'ACTIVE', planKey: 'annual_pass', checkoutKind: 'order', accessUntil: '2027-11-04T00:00:00.000Z' } }
} = {}) {
  const main = { innerHTML: '' }, requests = [], notices = [], redirects = [];
  let session = { user }, currentHref = 'https://threadnews.online/pricing' + search;
  const location = {
    get href() { return currentHref; },
    set href(value) { currentHref = value; },
    get pathname() { return new URL(currentHref).pathname; },
    get hash() { return new URL(currentHref).hash; },
    get search() { return new URL(currentHref).search; },
    assign(url) { redirects.push(url); }
  };
  const context = vm.createContext({
    console, URL, URLSearchParams, Intl, Date, AbortSignal, Response,
    location,
    history: { state: null, replaceState(_state, _title, url) { currentHref = new URL(url, currentHref).href; } },
    document: { getElementById(id) { return id === 'main' ? main : null; } },
    window: { confirm: () => true },
    async fetch(url, options = {}) {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, options, body });
      if (url.endsWith('/api/billing/plans')) return Response.json({
        enabled, environment, billing: { freeThroughDate: '2026-11-30', billingStartsAt: '2026-11-30T18:30:00.000Z', billingStartLabel: 'December 1, 2026 at 12:00 AM India Standard Time (IST)' }, freeTier: { timelineMilestones: 10, economyLatestValues: true, weeklyBrief: false, plannedFeatures: ['Weekly brief'] }, plans
      });
      if (url.endsWith('/api/billing/status')) return Response.json(status);
      if (url.endsWith('/api/billing/confirm')) return Response.json(subscriptionConfirmation);
      if (url.endsWith('/api/billing/confirm-order')) return Response.json(orderConfirmation);
      if (url.endsWith('/api/billing/subscriptions')) return Response.json({ approvalUrl, subscriptionId: 'sandbox-sub' });
      if (url.endsWith('/api/billing/orders')) return Response.json({ approvalUrl: orderApprovalUrl, orderId: 'sandbox-order' });
      if (url.endsWith('/api/billing/cancel')) return Response.json({ entitled: false, subscription: { status: 'CANCELLED', checkoutKind: 'subscription' } });
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
  });
  vm.runInContext(source, context);
  const view = context.createBillingView({ connected: true, apiBase: '', getSession: () => session, esc: String, toast: message => notices.push(message) });
  return { view, main, requests, notices, redirects, location, setSession(value) { session = { user: value }; } };
}

test('membership plans render server-configured benefits and guest UI requires sign-in', async () => {
  const f = ui();
  await f.view.refresh();
  assert.match(f.main.innerHTML, /\$2\.00/);
  assert.match(f.main.innerHTML, /\$20\.00/);
  assert.match(f.main.innerHTML, /PayPal sandbox · testing only/);
  assert.match(f.main.innerHTML, /Free for everyone through Nov 30, 2026/);
  assert.match(f.main.innerHTML, /December 1, 2026 at 12:00 AM India Standard Time/);
  assert.match(f.main.innerHTML, /Sign in to continue/);
  assert.match(f.main.innerHTML, /Configured timeline archive/);
  assert.match(f.main.innerHTML, /PLANNED · NOT ACTIVE/);
  assert.match(f.main.innerHTML, /Configured future alerts/);
  assert.doesNotMatch(f.main.innerHTML, /Full event timelines beyond the free 10-milestone limit/);
  assert.doesNotMatch(f.main.innerHTML, /data-action="billing-checkout"/);
});

test('guest plans do not ask readers to sign in while PayPal checkout is unavailable', async () => {
  const f = ui({ enabled: false, plans: defaultPlans.map(plan => ({ ...plan, available: false })) });
  await f.view.refresh();
  assert.match(f.main.innerHTML, /Free for everyone through Nov 30, 2026/);
  assert.match(f.main.innerHTML, /Membership not open yet/);
  assert.doesNotMatch(f.main.innerHTML, /data-action="billing-signin"/);
});

test('PayPal subscription return confirms server-side and displays only returned entitlement', async () => {
  const f = ui({ user: { id: 'reader-1' }, search: '?subscription_id=sandbox-sub' });
  await f.view.refresh();
  assert(f.requests.some(r => r.url.endsWith('/api/billing/confirm') && r.body?.subscriptionId === 'sandbox-sub'));
  assert.match(f.main.innerHTML, /Supporter access is active/);
  assert(f.notices.some(message => message.includes('confirmed your payment')));
  assert.equal(f.location.pathname, '/pricing');
  assert.equal(f.location.search, '');
});

test('annual subscription uses PayPal subscriptions and discloses the scheduled first charge', async () => {
  const checkout = ui({ user: { id: 'reader-1' }, plans: [defaultPlans[1]] });
  await checkout.view.refresh();
  assert.match(checkout.main.innerHTML, /First payment is scheduled for December 1, 2026/);
  checkout.view.handleAction({ preventDefault() {} }, { dataset: { action: 'billing-checkout', plan: 'annual' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(checkout.requests.some(r => r.url.endsWith('/api/billing/subscriptions') && r.body?.planKey === 'annual'));
  assert.deepEqual(checkout.redirects, ['https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=test']);
  assert.equal(checkout.requests.some(r => r.url.endsWith('/api/billing/orders')), false);

  const returned = ui({ user: { id: 'reader-1' }, plans: [defaultPlans[1]], search: '?subscription_id=sandbox-sub' });
  await returned.view.refresh();
  assert(returned.requests.some(r => r.url.endsWith('/api/billing/confirm') && r.body?.subscriptionId === 'sandbox-sub'));
  assert.match(returned.main.innerHTML, /Supporter access is active/);
  assert.match(returned.main.innerHTML, /data-action="billing-cancel"/);
  assert.equal(returned.location.pathname, '/pricing');
  assert.equal(returned.location.search, '');
});

test('checkout rejects a live PayPal approval URL while the page is in sandbox mode', async () => {
  const f = ui({ user: { id: 'reader-1' }, approvalUrl: 'https://www.paypal.com/checkout?token=should-not-open' });
  await f.view.refresh();
  f.view.handleAction({ preventDefault() {} }, { dataset: { action: 'billing-checkout', plan: 'annual' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.redirects, []);
  assert.match(f.main.innerHTML, /unexpected checkout link/);
});

test('live checkout accepts only live PayPal approval URLs', async () => {
  const live = ui({ user: { id: 'reader-1' }, environment: 'live', approvalUrl: 'https://www.paypal.com/checkoutnow?token=live-order' });
  await live.view.refresh();
  live.view.handleAction({ preventDefault() {} }, { dataset: { action: 'billing-checkout', plan: 'monthly' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(live.redirects, ['https://www.paypal.com/checkoutnow?token=live-order']);

  const mismatch = ui({ user: { id: 'reader-1' }, environment: 'live', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=should-not-open' });
  await mismatch.view.refresh();
  mismatch.view.handleAction({ preventDefault() {} }, { dataset: { action: 'billing-checkout', plan: 'monthly' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(mismatch.redirects, []);
  assert.match(mismatch.main.innerHTML, /unexpected checkout link/);
});

test('only active recurring subscriptions show the cancellation control', async () => {
  const recurring = ui({ user: { id: 'reader-1' }, status: { entitled: true, subscription: { status: 'ACTIVE', planKey: 'annual', checkoutKind: 'subscription' } } });
  await recurring.view.refresh();
  assert.match(recurring.main.innerHTML, /Supporter access is active/);
  assert.match(recurring.main.innerHTML, /data-action="billing-cancel"/);

  const pass = ui({ user: { id: 'reader-1' }, status: { entitled: true, subscription: { status: 'ACTIVE', planKey: 'annual_pass', checkoutKind: 'order', accessUntil: '2027-11-04T00:00:00.000Z' } } });
  await pass.view.refresh();
  assert.match(pass.main.innerHTML, /Supporter pass access is active through/);
  assert.doesNotMatch(pass.main.innerHTML, /data-action="billing-cancel"/);
});
