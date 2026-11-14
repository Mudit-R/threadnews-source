import fs from 'node:fs/promises';
import planConfig from '../../config/plans.json' with { type: 'json' };

const API = 'https://api-m.sandbox.paypal.com';
const cacheUrl = new URL('../.paypal-sandbox-plan-ids.json', import.meta.url);
const doCreate = process.argv.includes('--create');

if (process.env.PAYPAL_ENV !== 'sandbox') {
  console.error('Refusing to continue. Set PAYPAL_ENV=sandbox; this setup script never targets live PayPal.');
  process.exit(1);
}
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your shell. The secret is read from the environment and is never written to disk.');
  process.exit(1);
}
if (!doCreate) {
  console.log('No PayPal resources were changed. Add --create only after confirming this sandbox REST app is the one for ThreadNews.');
  console.log('PayPal Subscriptions is available only to eligible/onboarded accounts. The script will stop if PayPal denies product or plan access.');
  process.exit(0);
}

const basic = btoa(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`);
const tokenResponse = await fetch(`${API}/v1/oauth2/token`, {
  method: 'POST',
  headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: 'grant_type=client_credentials'
});
const tokenData = await tokenResponse.json().catch(() => ({}));
if (!tokenResponse.ok || !tokenData.access_token) {
  console.error(`PayPal sandbox authentication failed (${tokenResponse.status}). Check the sandbox app credentials and API permissions.`);
  process.exit(2);
}

async function api(path, { method = 'GET', body, requestId } = {}) {
  const headers = { authorization: `Bearer ${tokenData.access_token}`, accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (requestId) headers['paypal-request-id'] = requestId;
  const response = await fetch(`${API}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) {
    const error = new Error(`PayPal sandbox request failed (${response.status}) at ${method} ${path}`);
    error.status = response.status;
    throw error;
  }
  return value;
}

let cache = { environment: 'sandbox', productId: null, plans: {} };
try {
  const stored = JSON.parse(await fs.readFile(cacheUrl, 'utf8'));
  if (stored.environment === 'sandbox') cache = { ...cache, ...stored, plans: stored.plans || {} };
} catch {}

const expectedProduct = {
  id: 'THREADNEWS-SUPPORTER-V1',
  name: 'ThreadNews Supporter access',
  description: 'Digital access to ThreadNews supporter features.',
  type: 'SERVICE'
};
let product;
try {
  product = await api(`/v1/catalogs/products/${encodeURIComponent(cache.productId || expectedProduct.id)}`);
} catch (error) {
  if (error.status !== 404) throw error;
}
if (!product?.id) {
  product = await api('/v1/catalogs/products', {
    method: 'POST',
    requestId: 'threadnews-product-supporter-v1',
    body: expectedProduct
  });
}
if (product.name !== expectedProduct.name || product.type !== expectedProduct.type) {
  throw new Error('The cached product ID belongs to a different PayPal product. Stop and inspect the sandbox catalog.');
}
cache.productId = product.id;

const recurringPlans = planConfig.plans.filter(plan => plan.checkout === 'subscription' && (!plan.seatCapVariable || Number(process.env[plan.seatCapVariable]) > 0));
for (const plan of recurringPlans) {
  let remote = null;
  const cachedId = cache.plans[plan.key];
  if (cachedId) {
    try { remote = await api(`/v1/billing/plans/${encodeURIComponent(cachedId)}`); }
    catch { remote = null; }
  }
  if (!remote) {
    const idempotencyKey = `threadnews-plan-${plan.key}-v1`;
    remote = await api('/v1/billing/plans', {
      method: 'POST',
      requestId: idempotencyKey,
      body: {
        product_id: product.id,
        name: `ThreadNews ${plan.name}`,
        description: `ThreadNews ${plan.name} subscription.`,
        billing_cycles: [{
          frequency: { interval_unit: plan.intervalUnit, interval_count: plan.intervalCount },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: plan.price, currency_code: plan.currency } }
        }],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee_failure_action: 'CANCEL',
          payment_failure_threshold: 2
        }
      }
    });
    cache.plans[plan.key] = remote.id;
    await fs.writeFile(cacheUrl, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
  }
  if (!remote?.id || remote.product_id !== product.id) throw new Error(`PayPal did not return a valid ${plan.key} plan.`);
  if (remote.status === 'CREATED') await api(`/v1/billing/plans/${encodeURIComponent(remote.id)}/activate`, { method: 'POST' });
  remote = await api(`/v1/billing/plans/${encodeURIComponent(remote.id)}`);
  const cycle = (remote.billing_cycles || []).find(item => item.tenure_type === 'REGULAR' && Number(item.sequence) === 1);
  const price = cycle?.pricing_scheme?.fixed_price;
  if (remote.status !== 'ACTIVE' || price?.currency_code !== plan.currency || Number(price?.value) !== Number(plan.price)
      || cycle?.frequency?.interval_unit !== plan.intervalUnit || Number(cycle?.frequency?.interval_count) !== Number(plan.intervalCount)) {
    throw new Error(`The ${plan.key} plan does not match config/plans.json. The checkout route will refuse to use it.`);
  }
  cache.plans[plan.key] = remote.id;
  await fs.writeFile(cacheUrl, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
}

console.log('PayPal sandbox products/plans are ready. These are sandbox IDs; no checkout or charge was made.');
console.log('Copy these values into the threadnews Worker variables only after verifying the PayPal app and plan IDs:');
console.log('PAYPAL_ENV=sandbox');
console.log('PAYPAL_SUBSCRIPTIONS_ACCESS=true');
console.log(`PAYPAL_PLAN_MONTHLY_ID=${cache.plans.monthly || '(not created)'}`);
console.log(`PAYPAL_PLAN_ANNUAL_ID=${cache.plans.annual || '(not created)'}`);
if (cache.plans.founding) console.log(`PAYPAL_PLAN_FOUNDING_ID=${cache.plans.founding}`);
console.log('The local plan ID cache is backend/.paypal-sandbox-plan-ids.json and is gitignored.');
console.log('Register the webhook in the PayPal Developer Dashboard, then save its ID as PAYPAL_WEBHOOK_ID.');
