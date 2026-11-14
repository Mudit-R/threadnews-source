import planConfig from '../../config/plans.json' with { type: 'json' };
import { authorized } from './content.js';
import { appOrigin } from './auth.js';
import { readLimited } from './feed.js';

const API = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };
const PRODUCT_ID = 'THREADNEWS-SUPPORTER-V1';
const PRODUCT_NAME = 'ThreadNews Supporter access';
export const PAYPAL_EVENTS = [
  'PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED',
  'BILLING.SUBSCRIPTION.CREATED', 'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED'
];
class SetupError extends Error {
  constructor(code, status = 502, endpoint = null) { super(code); this.status = status; this.endpoint = endpoint; }
}
function matchesPlan(remote, plan) {
  const cycles = remote.billing_cycles || [], cycle = cycles[0];
  return remote.status === 'ACTIVE' && remote.product_id === PRODUCT_ID && cycles.length === 1
    && cycle.tenure_type === 'REGULAR' && Number(cycle.sequence) === 1 && Number(cycle.total_cycles) === 0
    && cycle.frequency?.interval_unit === plan.intervalUnit && Number(cycle.frequency?.interval_count) === plan.intervalCount
    && cycle.pricing_scheme?.fixed_price?.currency_code === plan.currency
    && Number(cycle.pricing_scheme?.fixed_price?.value) === Number(plan.price)
    && Number(remote.payment_preferences?.setup_fee?.value || 0) === 0;
}

/** Provision catalog resources only. This never creates a customer or subscription,
 * collects money, or enables the paywall. Credentials stay in the Worker runtime. */
export async function provisionPayPal(env, { fetchImpl = fetch } = {}) {
  if (!API[env.PAYPAL_ENV] || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !appOrigin(env)) {
    throw new SetupError('paypal_setup_credentials_missing', 503);
  }
  async function call(path, { method = 'GET', body, requestId, token } = {}) {
    const headers = { accept: 'application/json' };
    headers.authorization = token ? `Bearer ${token}` : `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`;
    if (body !== undefined) headers['content-type'] = token ? 'application/json' : 'application/x-www-form-urlencoded';
    if (token) headers.prefer = 'return=representation';
    if (requestId) headers['paypal-request-id'] = requestId;
    let response;
    try {
      response = await fetchImpl(API[env.PAYPAL_ENV] + path, {
        method, headers, ...(body !== undefined ? { body: token ? JSON.stringify(body) : body } : {}),
        redirect: 'manual', signal: AbortSignal.timeout(15000)
      });
    } catch { throw new SetupError('paypal_setup_unreachable', 502, path.split('?')[0]); }
    const text = await readLimited(response, 512 * 1024);
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new SetupError('paypal_setup_invalid_response'); }
    if (!response.ok) {
      const error = new SetupError(`paypal_setup_http_${response.status}`, 502, path.split('?')[0]);
      // Only provider error codes and field names can leave the Worker. Never
      // return descriptions, submitted values, credentials or token responses.
      error.issues = (Array.isArray(data.details) ? data.details : []).slice(0, 8).map(item => ({
        issue: /^[A-Z][A-Z0-9_]{0,79}$/.test(item.issue || '') ? item.issue : 'UNSPECIFIED',
        field: /^[a-zA-Z0-9_./\[\]-]{1,160}$/.test(item.field || '') ? item.field : null
      }));
      throw error;
    }
    return data;
  }
  const auth = await call('/v1/oauth2/token', { method: 'POST', body: 'grant_type=client_credentials' });
  if (typeof auth.access_token !== 'string') throw new SetupError('paypal_setup_auth_failed');
  const api = (path, options = {}) => call(path, { ...options, token: auth.access_token });
  let product;
  try { product = await api(`/v1/catalogs/products/${PRODUCT_ID}`); }
  catch (error) { if (error.message !== 'paypal_setup_http_404') throw error; }
  if (!product) {
    await api('/v1/catalogs/products', {
      method: 'POST', requestId: 'threadnews-supporter-product-v2',
      body: { id: PRODUCT_ID, name: PRODUCT_NAME, description: 'Digital access to ThreadNews supporter features.', type: 'SERVICE' }
    });
    product = await api(`/v1/catalogs/products/${PRODUCT_ID}`);
  }
  if (product.id !== PRODUCT_ID || product.name !== PRODUCT_NAME || product.type !== 'SERVICE') {
    throw new SetupError('paypal_setup_product_mismatch', 409);
  }
  const existing = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/v1/billing/plans?product_id=${PRODUCT_ID}&page_size=20&total_required=true&page=${page}`);
    if (!Array.isArray(batch.plans)) throw new SetupError('paypal_setup_invalid_plan_list');
    existing.push(...batch.plans);
    const hasNext = batch.links?.some(link => link.rel === 'next') || Number(batch.total_pages) > page;
    if (!hasNext) break;
    if (page >= 20) throw new SetupError('paypal_setup_plan_list_limit', 409);
  }
  const variables = { PAYPAL_ENV: env.PAYPAL_ENV };
  for (const plan of planConfig.plans.filter(plan => plan.checkout === 'subscription' && !plan.seatCapVariable)) {
    const name = `ThreadNews ${plan.key} ${plan.currency} ${plan.price} v1`;
    const candidates = existing.filter(item => item.name === name && item.status !== 'INACTIVE');
    if (candidates.length > 1) throw new SetupError('paypal_setup_duplicate_plans', 409);
    let remote = candidates.length ? await api(`/v1/billing/plans/${encodeURIComponent(candidates[0].id)}`) : null;
    if (!remote) remote = await api('/v1/billing/plans', {
      method: 'POST', requestId: `threadnews-${plan.key}-${plan.currency}-${plan.price}-v1`,
      body: {
        product_id: PRODUCT_ID, name, status: 'ACTIVE', description: `ThreadNews ${plan.name} subscription.`,
        billing_cycles: [{ frequency: { interval_unit: plan.intervalUnit, interval_count: plan.intervalCount },
          tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
          pricing_scheme: { fixed_price: { value: plan.price, currency_code: plan.currency } } }],
        payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 2 }
      }
    });
    if (typeof remote.id !== 'string' || !/^P-[A-Z0-9]+$/.test(remote.id)) throw new SetupError('paypal_setup_invalid_plan_id');
    if (remote.status === 'CREATED') await api(`/v1/billing/plans/${remote.id}/activate`, { method: 'POST' });
    remote = await api(`/v1/billing/plans/${remote.id}`);
    if (!matchesPlan(remote, plan)) throw new SetupError('paypal_setup_plan_mismatch', 409);
    variables[plan.planIdVariable] = remote.id;
  }
  const webhookUrl = `${appOrigin(env)}/api/billing/webhook`;
  const hooks = await api('/v1/notifications/webhooks');
  if (!Array.isArray(hooks.webhooks)) throw new SetupError('paypal_setup_invalid_webhook_list');
  const matching = hooks.webhooks.filter(hook => hook.url === webhookUrl);
  if (matching.length > 1) throw new SetupError('paypal_setup_duplicate_webhooks', 409);
  let webhook = matching[0];
  if (!webhook) webhook = await api('/v1/notifications/webhooks', {
    method: 'POST', requestId: 'threadnews-subscription-webhook-v1',
    body: { url: webhookUrl, event_types: PAYPAL_EVENTS.map(name => ({ name })) }
  });
  if (typeof webhook.id !== 'string' || !/^[A-Z0-9-]+$/.test(webhook.id)) throw new SetupError('paypal_setup_invalid_webhook_id');
  if (!PAYPAL_EVENTS.every(name => webhook.event_types?.some(event => event.name === name || event.name === '*'))) {
    throw new SetupError('paypal_setup_webhook_events_mismatch', 409);
  }
  variables.PAYPAL_WEBHOOK_ID = webhook.id;
  variables.PAYPAL_SUBSCRIPTIONS_ACCESS = 'true';
  return { ok: true, environment: env.PAYPAL_ENV, productId: PRODUCT_ID, variables, billingEnabled: false };
}

export async function handlePayPalSetup(request, env) {
  if (new URL(request.url).pathname !== '/api/admin/billing/setup') return null;
  const json = (body, status) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try { await authorized(request, env); }
  catch (error) { return json({ error: 'unauthorized' }, error.status || 401); }
  if (env.PAYPAL_SETUP_ENABLED !== 'true') return json({ error: 'paypal_setup_disabled' }, 403);
  try {
    let input;
    try { input = JSON.parse(await readLimited(request, 1024)); }
    catch { return json({ error: 'invalid_setup_request' }, 400); }
    if (input.environment !== env.PAYPAL_ENV || input.confirm !== 'CREATE_PLANS_AND_WEBHOOK') {
      return json({ error: 'paypal_setup_confirmation_required' }, 400);
    }
    return json(await provisionPayPal(env), 200);
  } catch (error) {
    return json({ error: error instanceof SetupError ? error.message : 'paypal_setup_failed',
      ...(error instanceof SetupError && error.endpoint ? { endpoint: error.endpoint } : {}),
      ...(error instanceof SetupError && error.issues?.length ? { issues: error.issues } : {}) }, error instanceof SetupError ? error.status : 502);
  }
}
