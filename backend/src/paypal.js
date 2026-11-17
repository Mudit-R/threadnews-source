import planConfig from '../../config/plans.json' with { type: 'json' };
import { appOrigin, currentSession, sameOriginMutation } from './auth.js';
import { sandboxImmediateBilling } from './billing-test.js';
import { membershipTerms, termsReady } from './terms.js';

const API_BY_ENV = Object.freeze({
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com'
});
const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
});
const plans = new Map(planConfig.plans.map(plan => [plan.key, plan]));
const DISABLED_MESSAGE = 'PayPal billing is not configured for this deployment.';
const EXTERNAL_FAILURE = 'PayPal could not complete this request. Try again shortly.';
const CHECKOUT_STALE_SECONDS = 10 * 60;
const PAYMENT_GRACE_SECONDS = 7 * 86400;
const bodyLimit = 8192;

class BillingError extends Error {
  constructor(code, status = 400, message = code) { super(message); this.code = code; this.status = status; }
}

function paypalReady(env) {
  return !!API_BY_ENV[env.PAYPAL_ENV]
    && !!env.PAYPAL_CLIENT_ID
    && !!env.PAYPAL_CLIENT_SECRET
    && !!env.PAYPAL_WEBHOOK_ID
    && !!env.DB
    && !!appOrigin(env);
}
function configured(env) { return env.BILLING_ENABLED === 'true' && paypalReady(env) && (env.PAYPAL_ENV==='sandbox'||termsReady(env)); }
function paypalCredentials(env) {
  return !!API_BY_ENV[env.PAYPAL_ENV] && !!env.PAYPAL_CLIENT_ID && !!env.PAYPAL_CLIENT_SECRET;
}

function setupMissing(env) {
  const missing = [];
  if (env.BILLING_ENABLED !== 'true') missing.push('Set BILLING_ENABLED=true only after the live PayPal app, recurring plans, webhook, and D1 migration are verified.');
  if (env.PAYPAL_ENV==='live'&&!termsReady(env)) missing.push('Publish approved seller details, refund policy and a versioned membership terms page before enabling live checkout.');
  if (!API_BY_ENV[env.PAYPAL_ENV]) missing.push('Set PAYPAL_ENV to live (or sandbox for testing).');
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) missing.push(`Add the PayPal ${env.PAYPAL_ENV === 'sandbox' ? 'sandbox' : 'live'} REST app client ID and secret.`);
  if (!env.PAYPAL_WEBHOOK_ID) missing.push(`Register the HTTPS webhook URL and set its ${env.PAYPAL_ENV === 'sandbox' ? 'sandbox' : 'live'} webhook ID.`);
  if (!env.DB) missing.push('Connect the ThreadNews D1 database and apply migration 0006_billing.sql.');
  if (!appOrigin(env)) missing.push('Set APP_ORIGIN to the HTTPS ThreadNews domain.');
  if (env.PAYPAL_SUBSCRIPTIONS_ACCESS !== 'true') missing.push('PayPal has not confirmed access to the Subscriptions API for this app.');
  for (const plan of planConfig.plans) if (!planId(env, plan)) missing.push(`Set ${plan.planIdVariable} to the matching active PayPal plan ID.`);
  return missing;
}

function planId(env, plan) { return plan.planIdVariable ? String(env[plan.planIdVariable] || '').trim() : ''; }
function priceLabel(plan) {
  const numeric = Number(plan.price);
  return Number.isFinite(numeric) ? `$${numeric.toFixed(2)}` : plan.price;
}
function capValue(env, plan) {
  if (!plan.seatCapVariable) return null;
  const cap = Number(env[plan.seatCapVariable]);
  return Number.isSafeInteger(cap) && cap > 0 ? cap : null;
}

async function foundingSeatCount(env, now = epochNow()) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM founding_claims
    WHERE state='claimed' OR (state='reserved' AND expires_at>?)`).bind(now).first();
  return Number(row?.count || 0);
}

function planAvailable(env, plan, ready = configured(env)) {
  if (!ready) return false;
  if (plan.checkout === 'order') return env[plan.enableVariable] === 'true';
  if (env.PAYPAL_SUBSCRIPTIONS_ACCESS !== 'true' || !planId(env, plan)) return false;
  if (plan.seatCapVariable && !capValue(env, plan)) return false;
  return true;
}

export async function publicPlans(env) {
  let schemaReady = false;
  if (env.DB) {
    try {
      await env.DB.prepare('SELECT user_id FROM billing_subscriptions LIMIT 0').all();
      await env.DB.prepare('SELECT event_id FROM paypal_webhook_events LIMIT 0').all();
      await env.DB.prepare('SELECT user_id FROM founding_claims LIMIT 0').all();
      await env.DB.prepare('SELECT user_id FROM membership_consents LIMIT 0').all();
      schemaReady = true;
    } catch {}
  }
  const ready = configured(env) && schemaReady;
  const catalog = [];
  for (const plan of planConfig.plans) {
    const seats = ready && plan.seatCapVariable && capValue(env, plan)
      ? Math.max(0, capValue(env, plan) - await foundingSeatCount(env))
      : null;
    catalog.push({
      key: plan.key,
      name: plan.name,
      price: plan.price,
      formattedPrice: priceLabel(plan),
      currency: plan.currency,
      interval: plan.interval,
      checkout: plan.checkout,
      available: planAvailable(env, plan, ready) && (seats == null || seats > 0),
      seatsRemaining: seats,
      features: plan.features,
      plannedFeatures: plan.plannedFeatures || []
    });
  }
  return {
    enabled: ready && catalog.some(plan => plan.available),
    environment: API_BY_ENV[env.PAYPAL_ENV] ? env.PAYPAL_ENV : 'disabled',
    billing: sandboxImmediateBilling(env) ? { ...planConfig.billing, billingStartsAt:'2000-01-01T00:00:00.000Z', billingStartLabel:'Immediately, using fictitious PayPal sandbox funds only' } : planConfig.billing,
    freeTier: env.PUBLIC_TIMELINES === 'true' ? { ...planConfig.freeTier, timelineMilestones: null, fullTimelines: true } : planConfig.freeTier,
    freePeriodActive: !sandboxImmediateBilling(env) && Date.now() < Date.parse(planConfig.billing.billingStartsAt),
    missingSetup: [...setupMissing(env), ...(!schemaReady && env.DB ? ['Apply the D1 billing migration before enabling checkout.'] : [])],
    subscriptionsAccessRequired: env.PAYPAL_SUBSCRIPTIONS_ACCESS !== 'true',
    terms: {published:membershipTerms(env).published,version:membershipTerms(env).version,url:'/terms'},
    plans: catalog
  };
}

export function entitlementFromRow(row, now = epochNow()) {
  const lastPaymentAt = Number(row?.last_payment_at || 0);
  if (!row || !lastPaymentAt || ['REFUNDED', 'REVERSED'].includes(row.status)) return false;
  if (row.status === 'ACTIVE') {
    if (row.checkout_kind === 'order') return Number(row.access_until || 0) > now;
    if (row.checkout_kind !== 'subscription') return false;
    const plan = plans.get(row.plan_key);
    const accessUntil = Number(row.access_until || 0) || (plan ? addPeriod(lastPaymentAt, plan) : 0);
    return Number.isFinite(accessUntil) && accessUntil > now;
  }
  if (row.status === 'PAYMENT_FAILED' || row.status === 'SUSPENDED') return Number(row.grace_until || 0) > now;
  if (['CANCELLED', 'EXPIRED'].includes(row.status)) {
    if (row.checkout_kind === 'order') return Number(row.access_until || 0) > now;
    if (row.checkout_kind !== 'subscription') return false;
    const plan = plans.get(row.plan_key);
    const accessUntil = Number(row.access_until || 0) || (plan ? addPeriod(lastPaymentAt, plan) : 0);
    return Number.isFinite(accessUntil) && accessUntil > now;
  }
  return false;
}

function epochNow() { return Math.floor(Date.now() / 1000); }

export async function hasPaidAccess(env, userId, now = epochNow(), { failOpen = true } = {}) {
  const startsAt = Math.floor(Date.parse(planConfig.billing.billingStartsAt) / 1000);
  // The site-wide free period applies to guests as well as signed-in readers.
  if (!sandboxImmediateBilling(env) && now < startsAt) return true;
  // Keep content open if the owner has not completed live checkout setup yet.
  // This avoids switching on a paywall that readers cannot actually purchase.
  const paidModeReady = configured(env)
    && env.PAYPAL_SUBSCRIPTIONS_ACCESS === 'true'
    && planConfig.plans.every(plan => !!planId(env, plan));
  if (!paidModeReady) return true;
  if (!env.DB || !userId) return false;
  try {
    const row = await env.DB.prepare('SELECT status,checkout_kind,plan_key,last_payment_at,access_until,grace_until FROM billing_subscriptions WHERE user_id=?').bind(userId).first();
    return entitlementFromRow(row, now);
  } catch (error) { if (!failOpen) throw error; return true; }
}

function statusPayload(row, entitled) {
  return {
    subscription: row ? {
      status: row.status,
      planKey: row.plan_key,
      checkoutKind: row.checkout_kind,
      nextBillingTime: row.next_billing_time || null,
      accessUntil: row.access_until ? new Date(Number(row.access_until) * 1000).toISOString() : null,
      updatedAt: row.updated_at ? new Date(Number(row.updated_at) * 1000).toISOString() : null
    } : null,
    entitled
  };
}

export function publicPlanCatalog() {
  return {
    currency: planConfig.currency,
    billing: planConfig.billing,
    freeTier: planConfig.freeTier,
    plans: planConfig.plans.map(plan => ({
      key: plan.key,
      name: plan.name,
      price: plan.price,
      currency: plan.currency,
      interval: plan.interval,
      checkout: plan.checkout,
      features: plan.features,
      plannedFeatures: plan.plannedFeatures || []
    }))
  };
}

async function authenticatedUser(request, env) {
  const session = await currentSession(request, env);
  if (!session.user) throw new BillingError('sign_in_required', 401, 'Sign in to manage a ThreadNews plan.');
  return session.user;
}

async function readJSON(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new BillingError('json_required', 415);
  if (Number(request.headers.get('content-length')) > bodyLimit) throw new BillingError('request_too_large', 413);
  const body = await request.text();
  if (body.length > bodyLimit) throw new BillingError('request_too_large', 413);
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch { throw new BillingError('invalid_json', 400); }
}

function mutationAllowed(request, env) {
  if (!sameOriginMutation(request, env)) throw new BillingError('cross_origin_request', 403);
}

async function accessToken(env) {
  const user = env.PAYPAL_CLIENT_ID, secret = env.PAYPAL_CLIENT_SECRET;
  if (!user || !secret || !API_BY_ENV[env.PAYPAL_ENV]) throw new BillingError('paypal_not_configured', 503, DISABLED_MESSAGE);
  const basic = btoa(`${user}:${secret}`);
  const response = await fetch(`${API_BY_ENV[env.PAYPAL_ENV]}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: 'grant_type=client_credentials',
    cf: { cacheTtl: 0 }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== 'string') throw new BillingError('paypal_auth_failed', 502, EXTERNAL_FAILURE);
  return data.access_token;
}

async function paypalRequest(env, path, { method = 'GET', body, requestId, token } = {}) {
  const bearer = token || await accessToken(env);
  const headers = { authorization: `Bearer ${bearer}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (requestId) headers['paypal-request-id'] = requestId;
  const response = await fetch(`${API_BY_ENV[env.PAYPAL_ENV]}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cf: { cacheTtl: 0 }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new BillingError('paypal_request_failed', response.status >= 500 ? 502 : 400, EXTERNAL_FAILURE);
  return data;
}

function envVarName(value) { return /^[A-Z][A-Z0-9_]{1,79}$/.test(value || ''); }

async function validatePayPalPlan(env, plan, token) {
  const id = planId(env, plan);
  if (!id || !envVarName(plan.planIdVariable)) throw new BillingError('plan_unavailable', 503, 'This plan is not configured yet.');
  const remote = await paypalRequest(env, `/v1/billing/plans/${encodeURIComponent(id)}`, { token });
  const cycles = remote.billing_cycles || [];
  const regularCycles = cycles.filter(cycle => cycle.tenure_type === 'REGULAR' && Number(cycle.sequence) === 1);
  const regular = regularCycles[0];
  const price = regular?.pricing_scheme?.fixed_price;
  const frequency = regular?.frequency;
  const correct = remote.status === 'ACTIVE'
    && cycles.length === 1
    && regularCycles.length === 1
    && price?.currency_code === plan.currency
    && Number(price?.value) === Number(plan.price)
    && frequency?.interval_unit === plan.intervalUnit
    && Number(frequency?.interval_count) === Number(plan.intervalCount)
    && Number(remote.payment_preferences?.setup_fee?.value || 0) === 0;
  if (!correct) throw new BillingError('paypal_plan_mismatch', 409, 'The configured PayPal plan does not match the public ThreadNews price or could charge before its advertised start date.');
  return id;
}

function approvalLink(resource, allowOrder = false, environment = 'sandbox') {
  const link = (resource.links || []).find(item => item.rel === 'approve' || item.rel === 'approval_url');
  if (!link?.href) return null;
  try {
    const url = new URL(link.href);
    const allowed = environment === 'live'
      ? ['paypal.com', 'www.paypal.com', 'checkout.paypal.com']
      : ['www.sandbox.paypal.com', 'sandbox.paypal.com', 'checkout.sandbox.paypal.com'];
    return url.protocol === 'https:' && allowed.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

function newRequestId(existing, planKey, checkoutKind) {
  if (existing?.status === 'ERROR' && existing.plan_key === planKey && existing.checkout_kind === checkoutKind && existing.request_id) return existing.request_id;
  return crypto.randomUUID();
}

async function reserveCheckout(env, userId, plan, checkoutKind) {
  const now = epochNow();
  const existing = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').bind(userId).first();
  if (entitlementFromRow(existing, now)) throw new BillingError('plan_already_active', 409, 'A paid ThreadNews plan is already active on this account.');
  if (existing && ['CREATING', 'APPROVAL_PENDING', 'AWAITING_PAYMENT', 'PAYMENT_FAILED', 'SUSPENDED'].includes(existing.status)) {
    if (existing.approval_url && Number(existing.updated_at) > now - 86400 && existing.plan_key === plan.key && existing.checkout_kind === checkoutKind) return { existing, reused: true };
    throw new BillingError('checkout_in_progress', 409, 'A checkout is already in progress. Complete or cancel it before choosing another plan.');
  }
  const requestId = newRequestId(existing, plan.key, checkoutKind);
  const result = await env.DB.prepare(`INSERT INTO billing_subscriptions
    (user_id,checkout_kind,plan_key,paypal_plan_id,subscription_id,order_id,request_id,approval_url,status,next_billing_time,last_payment_at,last_payment_ref,access_until,grace_until,created_at,updated_at)
    VALUES (?,?,?,?,NULL,NULL,?,NULL,'CREATING',NULL,NULL,NULL,NULL,NULL,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      checkout_kind=excluded.checkout_kind,plan_key=excluded.plan_key,paypal_plan_id=excluded.paypal_plan_id,
      subscription_id=NULL,order_id=NULL,request_id=excluded.request_id,approval_url=NULL,status='CREATING',
      next_billing_time=NULL,last_payment_at=NULL,last_payment_ref=NULL,access_until=NULL,grace_until=NULL,
      created_at=excluded.created_at,updated_at=excluded.updated_at
    WHERE billing_subscriptions.status IN ('CANCELLED','EXPIRED','REFUNDED','REVERSED','ERROR')
       OR (billing_subscriptions.status='CREATING' AND billing_subscriptions.updated_at<=?)`).bind(
        userId, checkoutKind, plan.key, checkoutKind === 'subscription' ? planId(env, plan) : null,
        requestId, now, now, now - CHECKOUT_STALE_SECONDS
      ).run();
  const row = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').bind(userId).first();
  if (!result.meta?.changes || !row || row.request_id !== requestId || row.status !== 'CREATING') {
    if (row?.approval_url && Number(row.updated_at) > now - 86400 && row.plan_key === plan.key && row.checkout_kind === checkoutKind) return { existing: row, reused: true };
    throw new BillingError('checkout_in_progress', 409, 'A checkout is already in progress. Complete it or try again in a few minutes.');
  }
  return { existing: row, reused: false };
}

async function claimFoundingSeat(env, userId, cap) {
  if (!cap) throw new BillingError('founding_plan_unavailable', 503, 'Founding access is not configured yet.');
  const now = epochNow();
  const existing = await env.DB.prepare('SELECT state,expires_at FROM founding_claims WHERE user_id=?').bind(userId).first();
  if (existing?.state === 'claimed' || (existing?.state === 'reserved' && Number(existing.expires_at) > now)) return true;
  const result = await env.DB.prepare(`INSERT INTO founding_claims (user_id,state,expires_at,created_at)
    SELECT ?,'reserved',?,? WHERE (SELECT COUNT(*) FROM founding_claims
      WHERE state='claimed' OR (state='reserved' AND expires_at>?)) < ?
    ON CONFLICT(user_id) DO UPDATE SET state='reserved',expires_at=excluded.expires_at,created_at=excluded.created_at
      WHERE founding_claims.state='reserved' AND founding_claims.expires_at<=?`).bind(
        userId, now + CHECKOUT_STALE_SECONDS, now, now, cap, now
      ).run();
  if (!result.meta?.changes) throw new BillingError('founding_plan_full', 409, 'All founding places are currently reserved or claimed.');
  return true;
}

async function releaseUnpaidFoundingSeat(env, userId) {
  await env.DB.prepare("DELETE FROM founding_claims WHERE user_id=? AND state='reserved'").bind(userId).run();
}

async function markCheckoutError(env, userId, requestId) {
  await env.DB.prepare("UPDATE billing_subscriptions SET status='ERROR',updated_at=? WHERE user_id=? AND request_id=? AND status='CREATING'").bind(epochNow(), userId, requestId).run();
}

async function createSubscription(request, env, user) {
  if (!configured(env)) throw new BillingError('billing_not_ready', 503, DISABLED_MESSAGE);
  if (env.PAYPAL_SUBSCRIPTIONS_ACCESS !== 'true') throw new BillingError('subscription_access_required', 503, 'PayPal has not confirmed Subscriptions API access for this app.');
  const { planKey, acceptTerms, termsVersion } = await readJSON(request);
  const plan = plans.get(planKey);
  if(env.PAYPAL_ENV==='live'&&(acceptTerms!==true||termsVersion!==membershipTerms(env).version))throw new BillingError('terms_consent_required',400,'Read and accept the current membership terms before approving a recurring plan.');
  if (!plan || plan.checkout !== 'subscription' || !planAvailable(env, plan)) throw new BillingError('plan_unavailable', 503, 'This subscription plan is not available in the current PayPal configuration.');
  const cap = plan.seatCapVariable ? capValue(env, plan) : null;
  const reservation = await reserveCheckout(env, user.id, plan, 'subscription');
  if (reservation.reused) return json({ approvalUrl: reservation.existing.approval_url, subscriptionId: reservation.existing.subscription_id, reused: true });
  const requestId = reservation.existing.request_id;
  try {
    if (plan.seatCapVariable) await claimFoundingSeat(env, user.id, cap);
    const token = await accessToken(env);
    const remotePlanId = await validatePayPalPlan(env, plan, token);
    const origin = appOrigin(env);
    const startsAt = Date.parse(planConfig.billing.billingStartsAt);
    const scheduledStart = !sandboxImmediateBilling(env) && Date.now() < startsAt ? new Date(startsAt).toISOString() : null;
    if(env.PAYPAL_ENV==='live')await env.DB.prepare('INSERT INTO membership_consents (id,user_id,terms_version,plan_key,amount,currency,first_charge_at,accepted_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(),user.id,termsVersion,plan.key,plan.price,plan.currency,scheduledStart,epochNow()).run();
    const subscriptionBody = {
      plan_id: remotePlanId,
      custom_id: user.id,
      ...(scheduledStart ? { start_time: scheduledStart } : {}),
      application_context: {
        brand_name: 'ThreadNews',
        locale: 'en-US',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${origin}/?checkout=subscription-approved#/pricing`,
        cancel_url: `${origin}/?checkout=cancelled#/pricing`
      }
    };
    const result = await paypalRequest(env, '/v1/billing/subscriptions', {
      method: 'POST', token, requestId, body: subscriptionBody
    });
    const approvalUrl = approvalLink(result, false, env.PAYPAL_ENV);
    if (!result.id || !approvalUrl) throw new BillingError('paypal_approval_link_missing', 502, EXTERNAL_FAILURE);
    const remoteStatus = ['ACTIVE', 'APPROVAL_PENDING'].includes(result.status) ? result.status : 'APPROVAL_PENDING';
    const nextBillingTime = result.billing_info?.next_billing_time || result.start_time || scheduledStart;
    await env.DB.prepare(`UPDATE billing_subscriptions SET subscription_id=?,approval_url=?,status=?,next_billing_time=?,updated_at=?
      WHERE user_id=? AND request_id=? AND status='CREATING'`).bind(result.id, approvalUrl, remoteStatus, nextBillingTime, epochNow(), user.id, requestId).run();
    return json({ approvalUrl, subscriptionId: result.id });
  } catch (error) {
    await markCheckoutError(env, user.id, requestId);
    if (plan.seatCapVariable) await env.DB.prepare("UPDATE founding_claims SET expires_at=? WHERE user_id=? AND state='reserved'").bind(epochNow() + CHECKOUT_STALE_SECONDS, user.id).run();
    throw error instanceof BillingError ? error : new BillingError('paypal_request_failed', 502, EXTERNAL_FAILURE);
  }
}

function orderReturnUrl(env) { return `${appOrigin(env)}/?checkout=order-approved#/pricing`; }

async function createOrder(request, env, user) {
  if (!configured(env)) throw new BillingError('billing_not_ready', 503, DISABLED_MESSAGE);
  const { planKey } = await readJSON(request);
  const plan = plans.get(planKey);
  if (!plan || plan.checkout !== 'order' || !planAvailable(env, plan)) throw new BillingError('plan_unavailable', 503, 'This one-time plan is not enabled for the current PayPal configuration.');
  const reservation = await reserveCheckout(env, user.id, plan, 'order');
  if (reservation.reused) return json({ approvalUrl: reservation.existing.approval_url, orderId: reservation.existing.order_id, reused: true });
  const requestId = reservation.existing.request_id;
  try {
    const result = await paypalRequest(env, '/v2/checkout/orders', {
      method: 'POST', requestId,
      body: {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: 'threadnews-annual-pass',
          custom_id: user.id,
          description: 'ThreadNews Supporter 12-month pass',
          amount: { currency_code: plan.currency, value: plan.price }
        }],
        application_context: {
          brand_name: 'ThreadNews',
          landing_page: 'LOGIN',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: orderReturnUrl(env),
          cancel_url: `${appOrigin(env)}/?checkout=cancelled#/pricing`
        }
      }
    });
    const approvalUrl = approvalLink(result, true, env.PAYPAL_ENV);
    if (!result.id || !approvalUrl) throw new BillingError('paypal_approval_link_missing', 502, EXTERNAL_FAILURE);
    await env.DB.prepare(`UPDATE billing_subscriptions SET order_id=?,approval_url=?,status='APPROVAL_PENDING',updated_at=?
      WHERE user_id=? AND request_id=? AND status='CREATING'`).bind(result.id, approvalUrl, epochNow(), user.id, requestId).run();
    return json({ approvalUrl, orderId: result.id });
  } catch (error) {
    await markCheckoutError(env, user.id, requestId);
    throw error instanceof BillingError ? error : new BillingError('paypal_order_failed', 502, EXTERNAL_FAILURE);
  }
}

function addPeriod(timestamp, plan) {
  if (!timestamp) return null;
  const date = new Date(Number(timestamp) * 1000);
  if (plan?.intervalUnit === 'MONTH') date.setUTCMonth(date.getUTCMonth() + 1);
  else date.setUTCFullYear(date.getUTCFullYear() + 1);
  return Math.floor(date.getTime() / 1000);
}

async function subscriptionForUser(env, userId, id) {
  const row = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').bind(userId).first();
  if (!row || !row.subscription_id || row.subscription_id !== id) throw new BillingError('subscription_not_found', 404, 'No matching ThreadNews subscription was found.');
  return row;
}

async function updateSubscriptionFromPayPal(env, user, id) {
  const local = await subscriptionForUser(env, user.id, id);
  const remote = await paypalRequest(env, `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
  if (remote.custom_id !== user.id || remote.plan_id !== local.paypal_plan_id) throw new BillingError('subscription_identity_mismatch', 403, 'PayPal could not verify this subscription belongs to your ThreadNews account.');
  const allowedStatus = ['APPROVAL_PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'];
  const remoteStatus = allowedStatus.includes(remote.status) ? remote.status : 'APPROVAL_PENDING';
  const nextBillingTime = remote.billing_info?.next_billing_time || local.next_billing_time || null;
  const billingTime = nextBillingTime ? Math.floor(Date.parse(nextBillingTime) / 1000) : null;
  const plan = plans.get(local.plan_key);
  const accessUntil = local.last_payment_at
    ? (billingTime || local.access_until || addPeriod(local.last_payment_at, plan))
    : local.access_until;
  const status = remoteStatus === 'APPROVED' ? 'AWAITING_PAYMENT' : remoteStatus;
  await env.DB.prepare(`UPDATE billing_subscriptions SET status=?,next_billing_time=?,access_until=?,approval_url=NULL,updated_at=?
    WHERE user_id=? AND subscription_id=?`).bind(status, nextBillingTime, accessUntil, epochNow(), user.id, id).run();
  const updated = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').bind(user.id).first();
  return { row: updated, remote };
}

async function confirmSubscription(request, env, user) {
  if (!paypalReady(env)) throw new BillingError('billing_not_ready', 503, 'PayPal credentials and webhook configuration are required to confirm this payment.');
  const { subscriptionId } = await readJSON(request);
  if (typeof subscriptionId !== 'string' || !/^I-[A-Z0-9-]{8,32}$/i.test(subscriptionId)) throw new BillingError('invalid_subscription_id');
  const { row } = await updateSubscriptionFromPayPal(env, user, subscriptionId);
  const entitled = entitlementFromRow(row);
  return json({ ...statusPayload(row, entitled), paymentPending: !entitled && ['ACTIVE', 'AWAITING_PAYMENT'].includes(row.status) });
}

async function cancelSubscription(request, env, user) {
  if (!paypalCredentials(env)) throw new BillingError('paypal_not_configured', 503, 'PayPal credentials are needed to cancel this plan.');
  const local = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').bind(user.id).first();
  if (!local) throw new BillingError('subscription_not_found', 404, 'No active PayPal plan was found.');
  if (['CANCELLED', 'EXPIRED', 'REFUNDED', 'REVERSED'].includes(local.status)) return json(statusPayload(local, entitlementFromRow(local)));
  if (local.checkout_kind === 'subscription' && local.subscription_id) {
    const remote = await paypalRequest(env, `/v1/billing/subscriptions/${encodeURIComponent(local.subscription_id)}`);
    if (remote.custom_id !== user.id) throw new BillingError('subscription_identity_mismatch', 403, 'PayPal could not verify this subscription belongs to your ThreadNews account.');
    if (!['CANCELLED', 'EXPIRED'].includes(remote.status)) {
      await paypalRequest(env, `/v1/billing/subscriptions/${encodeURIComponent(local.subscription_id)}/cancel`, {
        method: 'POST', body: { reason: 'ThreadNews subscriber requested cancellation.' }
      });
    }
  } else if (local.checkout_kind !== 'order' || !local.order_id || local.status !== 'APPROVAL_PENDING') {
    throw new BillingError('subscription_not_found', 404, 'No cancellable PayPal plan was found.');
  }
  const nextBillingEpoch = local.next_billing_time ? Math.floor(Date.parse(local.next_billing_time) / 1000) : null;
  const plan = plans.get(local.plan_key);
  const accessUntil = local.last_payment_at ? (nextBillingEpoch || local.access_until || addPeriod(local.last_payment_at, plan)) : null;
  await env.DB.prepare(`UPDATE billing_subscriptions SET status='CANCELLED',access_until=?,approval_url=NULL,
    order_id=CASE WHEN checkout_kind='order' THEN NULL ELSE order_id END,updated_at=? WHERE user_id=?`).bind(accessUntil, epochNow(), user.id).run();
  const row = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').bind(user.id).first();
  if (!local.last_payment_at) await releaseUnpaidFoundingSeat(env, user.id);
  return json(statusPayload(row, entitlementFromRow(row)));
}

async function confirmOrder(request, env, user) {
  if (!paypalReady(env)) throw new BillingError('billing_not_ready', 503, 'PayPal credentials and webhook configuration are required to confirm this payment.');
  const { orderId } = await readJSON(request);
  if (typeof orderId !== 'string' || !/^[A-Z0-9-]{8,40}$/i.test(orderId)) throw new BillingError('invalid_order_id');
  const local = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').bind(user.id).first();
  if (!local || local.checkout_kind !== 'order' || local.order_id !== orderId || local.plan_key !== 'annual_pass') throw new BillingError('order_not_found', 404, 'No matching ThreadNews pass was found.');
  if (local.status === 'ACTIVE' && entitlementFromRow(local)) return json(statusPayload(local, true));
  if (local.status !== 'APPROVAL_PENDING') throw new BillingError('order_not_approvable', 409, 'This PayPal pass is no longer awaiting approval.');
  const plan = plans.get('annual_pass');
  const before = await paypalRequest(env, `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  if (before.purchase_units?.[0]?.custom_id !== user.id) throw new BillingError('order_identity_mismatch', 403, 'PayPal could not verify this order belongs to your ThreadNews account.');
  if (before.status !== 'APPROVED' && before.status !== 'COMPLETED') throw new BillingError('order_not_approved', 409, 'Approve the PayPal checkout before confirming this pass.');
  const captured = before.status === 'COMPLETED' ? before : await paypalRequest(env, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST', requestId: local.request_id
  });
  const unit = captured.purchase_units?.[0] || before.purchase_units?.[0];
  const capture = unit?.payments?.captures?.find(item => item.status === 'COMPLETED');
  const value = capture?.amount?.value;
  const currency = capture?.amount?.currency_code;
  if (captured.status !== 'COMPLETED' || unit?.custom_id !== user.id || currency !== plan.currency || Number(value) !== Number(plan.price)) {
    throw new BillingError('payment_not_completed', 409, 'PayPal has not confirmed the full 12-month pass payment yet.');
  }
  const now = epochNow();
  const accessUntil = now + Number(plan.accessDays) * 86400;
  const ref = capture.id || null;
  await env.DB.prepare(`UPDATE billing_subscriptions SET status='ACTIVE',last_payment_at=?,last_payment_ref=?,access_until=?,
      grace_until=NULL,approval_url=NULL,updated_at=?,last_event_at=? WHERE user_id=? AND order_id=?`)
    .bind(now, ref, accessUntil, now, now, user.id, orderId).run();
  const row = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').bind(user.id).first();
  return json(statusPayload(row, entitlementFromRow(row)));
}

function paypalWebhookHeaders(request) {
  return {
    auth_algo: request.headers.get('paypal-auth-algo'),
    cert_url: request.headers.get('paypal-cert-url'),
    transmission_id: request.headers.get('paypal-transmission-id'),
    transmission_sig: request.headers.get('paypal-transmission-sig'),
    transmission_time: request.headers.get('paypal-transmission-time')
  };
}

async function readWebhook(request) {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new BillingError('json_required', 415);
  if (Number(request.headers.get('content-length')) > 1024 * 1024) throw new BillingError('webhook_too_large', 413);
  const raw = await request.text();
  if (raw.length > 1024 * 1024) throw new BillingError('webhook_too_large', 413);
  let event;
  try { event = JSON.parse(raw); } catch { throw new BillingError('invalid_webhook_json', 400); }
  if (!event || typeof event.id !== 'string' || typeof event.event_type !== 'string' || !event.resource || typeof event.resource !== 'object') throw new BillingError('invalid_webhook_event', 400);
  return { event, headers: paypalWebhookHeaders(request) };
}

async function verifyWebhook(env, event, headers) {
  if (!paypalReady(env)) throw new BillingError('billing_not_ready', 503, 'PayPal credentials and webhook configuration are required to verify this event.');
  if (Object.values(headers).some(value => !value)) throw new BillingError('webhook_headers_missing', 401, 'Webhook signature verification failed.');
  const certUrl = new URL(headers.cert_url);
  if (certUrl.protocol !== 'https:' || !(certUrl.hostname === 'paypal.com' || certUrl.hostname.endsWith('.paypal.com'))) throw new BillingError('webhook_certificate_url_invalid', 401, 'Webhook signature verification failed.');
  const token = await accessToken(env);
  const verification = await paypalRequest(env, '/v1/notifications/verify-webhook-signature', {
    method: 'POST', token,
    body: { ...headers, webhook_id: env.PAYPAL_WEBHOOK_ID, webhook_event: event }
  });
  if (verification.verification_status !== 'SUCCESS') throw new BillingError('webhook_signature_invalid', 401, 'Webhook signature verification failed.');
}

function subIdFromEvent(event) {
  const resource = event.resource || {};
  return resource.billing_agreement_id || resource.subscription_id || (event.event_type.startsWith('BILLING.SUBSCRIPTION.') ? resource.id : null);
}
function orderIdFromEvent(event) {
  const resource = event.resource || {};
  return resource.supplementary_data?.related_ids?.order_id || resource.order_id || null;
}
function eventTime(event) {
  const parsed = Date.parse(event.create_time || event.resource?.update_time || event.resource?.create_time || '');
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : epochNow();
}
function validateSubscriptionSale(event, row) {
  const plan = plans.get(row.plan_key);
  const money = event.resource?.amount;
  return !!plan && money?.currency === plan.currency && Number(money?.total) === Number(plan.price);
}
function validateCaptureEvent(event, row) {
  const plan = plans.get(row.plan_key);
  const money = event.resource?.amount;
  return !!plan && money?.currency_code === plan.currency && Number(money?.value) === Number(plan.price);
}

async function recordWebhook(env, event) {
  const type = event.event_type;
  const now = epochNow(), occurred = eventTime(event), resource = event.resource;
  const subscriptionId = subIdFromEvent(event);
  const orderId = orderIdFromEvent(event);
  const isSubEvent = type.startsWith('BILLING.SUBSCRIPTION.') || type === 'PAYMENT.SALE.COMPLETED' || type === 'PAYMENT.SALE.REFUNDED' || type === 'PAYMENT.SALE.REVERSED';
  const isOrderEvent = type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED';
  let row = null;
  if (isSubEvent && subscriptionId) row = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE subscription_id=?').bind(subscriptionId).first();
  if (isOrderEvent && orderId) row = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE order_id=?').bind(orderId).first();
  const existingEvent = await env.DB.prepare('SELECT event_id FROM paypal_webhook_events WHERE event_id=?').bind(event.id).first();
  if (existingEvent) return { duplicate: true };
  if ((isSubEvent || isOrderEvent) && !row) throw new BillingError('webhook_resource_not_found', 503, 'The checkout record is not ready; PayPal may retry this event.');
  if (row && Number(row.last_event_at || 0) >= occurred) {
    await env.DB.prepare('INSERT OR IGNORE INTO paypal_webhook_events (event_id,event_type,resource_id,processed_at) VALUES (?,?,?,?)')
      .bind(event.id, type, resource.id || subscriptionId || orderId || null, now).run();
    return { duplicate: false, stale: true };
  }

  const statements = [env.DB.prepare('INSERT OR IGNORE INTO paypal_webhook_events (event_id,event_type,resource_id,processed_at) VALUES (?,?,?,?)')
    .bind(event.id, type, resource.id || subscriptionId || orderId || null, now)];
  if (row && isSubEvent) {
    if (type === 'PAYMENT.SALE.COMPLETED' || type === 'BILLING.SUBSCRIPTION.PAYMENT.SUCCEEDED') {
      if (!validateSubscriptionSale(event, row)) {
        await env.DB.prepare('INSERT OR IGNORE INTO paypal_webhook_events (event_id,event_type,resource_id,processed_at) VALUES (?,?,?,?)')
          .bind(event.id, type, resource.id || subscriptionId || null, now).run();
        return { duplicate: false, ignored: true, reason: 'amount_mismatch' };
      }
      const plan = plans.get(row.plan_key);
      const next = row.next_billing_time ? Math.floor(Date.parse(row.next_billing_time) / 1000) : null;
      const accessUntil = next || addPeriod(occurred, plan);
      statements.push(env.DB.prepare(`UPDATE billing_subscriptions SET status='ACTIVE',last_payment_at=?,last_payment_ref=?,
        access_until=?,grace_until=NULL,updated_at=?,last_event_at=? WHERE user_id=? AND subscription_id=? AND last_event_at<?`)
        .bind(occurred, resource.id || null, accessUntil, now, occurred, row.user_id, subscriptionId, occurred));
      if (row.plan_key === 'founding') statements.push(env.DB.prepare("UPDATE founding_claims SET state='claimed',expires_at=0 WHERE user_id=?").bind(row.user_id));
    } else if (type === 'PAYMENT.SALE.REFUNDED' || type === 'PAYMENT.SALE.REVERSED') {
      const state = type.endsWith('REFUNDED') ? 'REFUNDED' : 'REVERSED';
      statements.push(env.DB.prepare('UPDATE billing_subscriptions SET status=?,access_until=?,grace_until=NULL,updated_at=?,last_event_at=? WHERE user_id=? AND subscription_id=? AND last_event_at<?')
        .bind(state, now, now, occurred, row.user_id, subscriptionId, occurred));
    } else if (type === 'BILLING.SUBSCRIPTION.CANCELLED' || type === 'BILLING.SUBSCRIPTION.EXPIRED') {
      const state = type.endsWith('CANCELLED') ? 'CANCELLED' : 'EXPIRED';
      const next = resource.billing_info?.next_billing_time || row.next_billing_time;
      const accessUntil = row.last_payment_at
        ? (next ? Math.floor(Date.parse(next) / 1000) : row.access_until || addPeriod(row.last_payment_at, plans.get(row.plan_key)))
        : null;
      statements.push(env.DB.prepare('UPDATE billing_subscriptions SET status=?,next_billing_time=?,access_until=?,approval_url=NULL,updated_at=?,last_event_at=? WHERE user_id=? AND subscription_id=? AND last_event_at<?')
        .bind(state, next || null, accessUntil, now, occurred, row.user_id, subscriptionId, occurred));
      if (!row.last_payment_at) statements.push(env.DB.prepare("DELETE FROM founding_claims WHERE user_id=? AND state='reserved'").bind(row.user_id));
    } else if (type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      statements.push(env.DB.prepare(`UPDATE billing_subscriptions SET status='PAYMENT_FAILED',grace_until=?,updated_at=?,last_event_at=? WHERE user_id=? AND subscription_id=? AND last_event_at<?`)
        .bind(row.last_payment_at ? now + PAYMENT_GRACE_SECONDS : null, now, occurred, row.user_id, subscriptionId, occurred));
    } else if (type === 'BILLING.SUBSCRIPTION.SUSPENDED') {
      statements.push(env.DB.prepare(`UPDATE billing_subscriptions SET status='SUSPENDED',grace_until=?,updated_at=?,last_event_at=? WHERE user_id=? AND subscription_id=? AND last_event_at<?`)
        .bind(row.last_payment_at ? now + PAYMENT_GRACE_SECONDS : null, now, occurred, row.user_id, subscriptionId, occurred));
    } else if (type === 'BILLING.SUBSCRIPTION.ACTIVATED' || type === 'BILLING.SUBSCRIPTION.UPDATED') {
      const next = resource.billing_info?.next_billing_time || row.next_billing_time;
      const status = row.last_payment_at ? 'ACTIVE' : 'AWAITING_PAYMENT';
      statements.push(env.DB.prepare('UPDATE billing_subscriptions SET status=?,next_billing_time=?,updated_at=?,last_event_at=? WHERE user_id=? AND subscription_id=? AND last_event_at<?')
        .bind(status, next || null, now, occurred, row.user_id, subscriptionId, occurred));
    } else if (type === 'BILLING.SUBSCRIPTION.CREATED') {
      statements.push(env.DB.prepare("UPDATE billing_subscriptions SET status='APPROVAL_PENDING',updated_at=?,last_event_at=? WHERE user_id=? AND subscription_id=? AND status='CREATING' AND last_event_at<?")
        .bind(now, occurred, row.user_id, subscriptionId, occurred));
    }
  } else if (row && isOrderEvent) {
    if (type === 'PAYMENT.CAPTURE.COMPLETED') {
      if (!validateCaptureEvent(event, row)) {
        await env.DB.prepare('INSERT OR IGNORE INTO paypal_webhook_events (event_id,event_type,resource_id,processed_at) VALUES (?,?,?,?)')
          .bind(event.id, type, resource.id || orderId || null, now).run();
        return { duplicate: false, ignored: true, reason: 'amount_mismatch' };
      }
      const plan = plans.get(row.plan_key);
      statements.push(env.DB.prepare(`UPDATE billing_subscriptions SET status='ACTIVE',last_payment_at=?,last_payment_ref=?,access_until=?,grace_until=NULL,approval_url=NULL,updated_at=?,last_event_at=?
        WHERE user_id=? AND order_id=? AND last_event_at<?`)
        .bind(occurred, resource.id || null, occurred + Number(plan.accessDays) * 86400, now, occurred, row.user_id, orderId, occurred));
    } else if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
      const state = type.endsWith('REFUNDED') ? 'REFUNDED' : 'REVERSED';
      statements.push(env.DB.prepare('UPDATE billing_subscriptions SET status=?,access_until=?,grace_until=NULL,updated_at=?,last_event_at=? WHERE user_id=? AND order_id=? AND last_event_at<?')
        .bind(state, now, now, occurred, row.user_id, orderId, occurred));
    }
  }
  await env.DB.batch(statements);
  return { duplicate: false };
}

async function receiveWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!paypalReady(env)) return json({ error: 'billing_not_ready', message: 'PayPal credentials and webhook configuration are required to verify this event.' }, 503);
  try {
    const { event, headers } = await readWebhook(request);
    await verifyWebhook(env, event, headers);
    const result = await recordWebhook(env, event);
    return json({ ok: true, duplicate: result.duplicate, ...(result.ignored ? { ignored: true } : {}) }, 200);
  } catch (error) {
    if (error instanceof BillingError) return json({ error: error.code, message: error.message }, error.status);
    console.error(JSON.stringify({ event: 'paypal_webhook_failed' }));
    return json({ error: 'webhook_processing_failed' }, 503);
  }
}

export async function handlePaypal(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/api/billing/webhook') return receiveWebhook(request, env);
  if (!path.startsWith('/api/billing/')) return null;
  const method = request.method;
  try {
    if (path === '/api/billing/plans') {
      if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return json(await publicPlans(env));
    }
    if (path === '/api/billing/status') {
      if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const user = await authenticatedUser(request, env);
      const row = await env.DB.prepare('SELECT * FROM billing_subscriptions WHERE user_id=?').bind(user.id).first();
      return json(statusPayload(row, entitlementFromRow(row)));
    }
    if (!['POST'].includes(method)) return json({ error: 'method_not_allowed' }, 405);
    mutationAllowed(request, env);
    const user = await authenticatedUser(request, env);
    if (path === '/api/billing/subscriptions') return await createSubscription(request, env, user);
    if (path === '/api/billing/confirm') return await confirmSubscription(request, env, user);
    if (path === '/api/billing/cancel') {
      // This endpoint intentionally has no client-provided subscription ID.
      return await cancelSubscription(request, env, user);
    }
    if (path === '/api/billing/orders') return await createOrder(request, env, user);
    if (path === '/api/billing/confirm-order') return await confirmOrder(request, env, user);
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof BillingError) return json({ error: error.code, message: error.message }, error.status);
    console.error(JSON.stringify({ event: 'paypal_billing_request_failed', path: path.split('/').slice(0, 4).join('/') }));
    return json({ error: 'billing_service_unavailable', message: 'Billing is temporarily unavailable. Try again later.' }, 503);
  }
}

/** Cancel an existing recurring agreement before account deletion. A cancelled
 * subscription is not deleted locally until the user deletion transaction. */
export async function cancelForAccountDeletion(request, env, userId) {
  if (!env.DB) return { ok: true, cancelled: false };
  const row = await env.DB.prepare('SELECT checkout_kind,subscription_id,status FROM billing_subscriptions WHERE user_id=?').bind(userId).first();
  if (!row || row.checkout_kind !== 'subscription' || !row.subscription_id || ['CANCELLED', 'EXPIRED', 'REFUNDED', 'REVERSED'].includes(row.status)) return { ok: true, cancelled: false };
  if (!paypalCredentials(env)) return { ok: false, response: json({ error: 'billing_cancel_required', message: 'Cancel the active PayPal subscription before deleting this account. PayPal credentials are not configured for this deployment.' }, 503) };
  try {
    const remote = await paypalRequest(env, `/v1/billing/subscriptions/${encodeURIComponent(row.subscription_id)}`);
    if (remote.custom_id !== userId) throw new Error('Subscription owner mismatch');
    if (!['CANCELLED', 'EXPIRED'].includes(remote.status)) {
      await paypalRequest(env, `/v1/billing/subscriptions/${encodeURIComponent(row.subscription_id)}/cancel`, {
        method: 'POST', body: { reason: 'ThreadNews account deletion requested.' }
      });
    }
    await env.DB.prepare("UPDATE billing_subscriptions SET status='CANCELLED',updated_at=? WHERE user_id=?").bind(epochNow(), userId).run();
    return { ok: true, cancelled: true };
  } catch {
    return { ok: false, response: json({ error: 'billing_cancel_failed', message: 'PayPal could not confirm cancellation. This account was not deleted; retry after confirming cancellation in PayPal.' }, 502) };
  }
}

/** Reconcile a bounded set of subscription statuses during the daily cron.
 * Webhooks remain the primary signal; this repairs missed or delayed notices. */
export async function reconcilePayPalSubscriptions(env) {
  if (!paypalReady(env)) return { ok: true, skipped: true, checked: 0 };
  const cutoff = epochNow() - 86400;
  const rows = (await env.DB.prepare(`SELECT user_id,subscription_id,paypal_plan_id,status,last_payment_at,next_billing_time,access_until,plan_key
    FROM billing_subscriptions WHERE checkout_kind='subscription' AND subscription_id IS NOT NULL
      AND status IN ('APPROVAL_PENDING','AWAITING_PAYMENT','ACTIVE','PAYMENT_FAILED','SUSPENDED') AND updated_at<?
    ORDER BY updated_at LIMIT 25`).bind(cutoff).all()).results || [];
  let checked = 0, failures = 0;
  for (const row of rows) {
    try {
      const remote = await paypalRequest(env, `/v1/billing/subscriptions/${encodeURIComponent(row.subscription_id)}`);
      if (remote.custom_id !== row.user_id || remote.plan_id !== row.paypal_plan_id) {
        await env.DB.prepare('UPDATE billing_subscriptions SET updated_at=? WHERE user_id=? AND subscription_id=?')
          .bind(epochNow(), row.user_id, row.subscription_id).run();
        failures++;
        continue;
      }
      const statuses = ['ACTIVE', 'SUSPENDED', 'CANCELLED', 'EXPIRED', 'APPROVAL_PENDING'];
      const status = statuses.includes(remote.status) ? remote.status : row.status;
      const next = remote.billing_info?.next_billing_time || row.next_billing_time;
      const accessUntil = row.last_payment_at
        ? (next ? Math.floor(Date.parse(next) / 1000) : row.access_until || addPeriod(row.last_payment_at, plans.get(row.plan_key)))
        : row.access_until;
      const normalized = status === 'APPROVAL_PENDING' && row.last_payment_at ? 'ACTIVE' : status;
      await env.DB.prepare('UPDATE billing_subscriptions SET status=?,next_billing_time=?,access_until=?,updated_at=? WHERE user_id=? AND subscription_id=?')
        .bind(normalized, next || null, accessUntil, epochNow(), row.user_id, row.subscription_id).run();
      checked++;
    } catch {
      // Move failures out of the oldest-first batch so one broken upstream
      // agreement cannot monopolize every daily reconciliation run.
      await env.DB.prepare('UPDATE billing_subscriptions SET updated_at=? WHERE user_id=? AND subscription_id=?')
        .bind(epochNow(), row.user_id, row.subscription_id).run().catch(() => {});
      failures++;
    }
  }
  return { ok: failures === 0, checked, failures };
}
