import { appOrigin, currentSession, sameOriginMutation } from './auth.js';
import { authorized } from './content.js';
import { sha256 } from './feed.js';

export const PAYPAL_TEST_ORIGIN = 'https://threadnews-paypal-test.example.com';
export function sandboxTestMode(env) {
  return env.TEST_ENVIRONMENT === 'paypal-e2e' && env.PAYPAL_ENV === 'sandbox'
    && appOrigin(env) === PAYPAL_TEST_ORIGIN
    && env.TEST_DATABASE_ID === '00000000-0000-4000-8000-000000000001' && !!env.DB;
}
export function sandboxImmediateBilling(env) { return sandboxTestMode(env) && env.PAYPAL_TEST_START_IMMEDIATELY === 'true'; }
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control':'no-store', ...headers } });

/** Isolated test identities require all environment checks. Production cannot use
 * this route even if a caller adds the same URL or body parameters. */
export async function handleBillingTest(request, env) {
  const path = new URL(request.url).pathname;
  if (!['/sandbox', '/api/sandbox/session', '/api/admin/billing/test-report'].includes(path)) return null;
  if (!sandboxTestMode(env)) return json({ error:'not_found' }, 404);
  if (path === '/sandbox') {
    if (request.method !== 'GET') return json({ error:'method_not_allowed' },405);
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ThreadNews PayPal sandbox</title><link rel="stylesheet" href="/news.css"><script defer src="/paypal-test.js"></script></head><body><main style="max-width:760px;margin:4rem auto;padding:2rem;font-family:system-ui"><h1>PayPal sandbox test</h1><p>This site uses a separate test database and sandbox credentials. All payments here use fictitious sandbox funds. Your live ThreadNews membership is unaffected.</p><p>Create a disposable test session, then use a PayPal <strong>sandbox Personal buyer</strong> account at checkout. Never enter live PayPal credentials on a sandbox payment page.</p><button id="sandbox-start" type="button">Create test session</button> <a href="/pricing">Open test membership</a><p id="sandbox-state" role="status"></p><ol><li>Subscribe monthly and approve using the sandbox buyer.</li><li>Return to membership. Check that PayPal confirmation and the verified payment grant supporter access.</li><li>Cancel from membership and check the agreement in sandbox PayPal.</li><li>Repeat for the annual plan with a separate test session.</li><li>For refund testing, issue a refund in the sandbox seller dashboard. Confirm that the webhook removes the refunded entitlement.</li></ol><p>Sandbox subscriptions can charge fictitious funds immediately. The live site keeps its published free period through 30 November 2026.</p><p><a href="https://threadnews.online">Return to the live site</a></p></main></body></html>`, {headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-robots-tag':'noindex, nofollow'}});
  }
  if (path === '/api/sandbox/session') {
    if (request.method !== 'POST') return json({error:'method_not_allowed'},405);
    if (!sameOriginMutation(request,env)) return json({error:'origin_not_allowed'},403);
    const existing = await currentSession(request,env);
    if (existing.user) return json({ok:true,reused:true});
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE provider='sandbox-test'").first();
    if (Number(count?.count || 0) >= 50) return json({error:'test_identity_limit'},429);
    const id=crypto.randomUUID(), token=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const now=Math.floor(Date.now()/1000);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,provider,provider_subject,name,created_at) VALUES (?,?,?,?,?)').bind(id,'sandbox-test',id,'Sandbox test reader',now),
      env.DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await sha256(token),id,now+3600)
    ]);
    return json({ok:true},200,{'set-cookie':`__Host-threadline-session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`});
  }
  if (request.method !== 'GET') return json({error:'method_not_allowed'},405);
  try {await authorized(request,env);} catch{return json({error:'unauthorized'},401);}
  const [subscriptions,events]=await Promise.all([
    env.DB.prepare('SELECT plan_key,status,checkout_kind,last_payment_at,access_until,next_billing_time,updated_at FROM billing_subscriptions ORDER BY updated_at DESC LIMIT 50').all(),
    env.DB.prepare('SELECT event_type,processed_at FROM paypal_webhook_events ORDER BY processed_at DESC LIMIT 100').all()
  ]);
  return json({ok:true,environment:'sandbox',subscriptions:subscriptions.results||[],verifiedWebhookEvents:events.results||[]});
}
