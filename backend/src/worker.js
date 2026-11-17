import { handleAuth, currentSession, sameOriginMutation } from './auth.js';
import { enabledFeeds, FEEDS } from './feeds.js';
import { handleContent, cleanupContent, contentConfig, authorized } from './content.js';
import { refreshEconomy, refreshNews, runtimeNewsFeeds } from './refresh.js';
import { EDITORIAL_POLICY, normalizeCategory } from './policy.js';
import { refreshEconomicSource } from './economy-refresh.js';
import { handleSeo } from './seo.js';
import { cancelForAccountDeletion, handlePaypal, hasPaidAccess, reconcilePayPalSubscriptions } from './paypal.js';
import { handlePayPalSetup } from './paypal-setup.js';
import { handleBillingTest } from './billing-test.js';
import { handleReaderUpdates,dispatchReaderUpdates } from './reader-updates.js';
import { handleArticleSummary, handleAsk, handleDailyBrief, handleStoryChanges } from './ai.js';
import { refreshSourceSummaries } from './source-summary.js';
import { handleWatchlist } from './watchlist.js';

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', ...headers } });
const normalizedTopic = value => {
  const normalized = normalizeCategory(value);
  return normalized.rejectReason ? value : normalized.category;
};

export function newsQuery(params) {
  const where = [], args = [];
  const rawTopic = (params.get('topic') || params.get('category') || '').trim().slice(0, 80);
  const topic = rawTopic ? normalizedTopic(rawTopic) : '';
  const region = (params.get('region') || '').trim().slice(0, 80);
  const q = (params.get('q') || '').trim().slice(0, 120);
  if (topic && topic !== 'All events' && topic !== 'All news') { where.push('category=?'); args.push(topic); }
  if (region && region !== 'Everywhere') { where.push('region=?'); args.push(region); }
  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')");
    const like = '%' + q.replace(/[\\%_]/g, x => '\\' + x) + '%';
    args.push(like, like);
  }
  const parsed = Number(params.get('limit') || 50), limit = Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.floor(parsed))) : 50;
  return { where: where.length ? ' WHERE ' + where.join(' AND ') : '', args, limit };
}

async function seedNews(request, env, note = 'Automatic storage is not connected; showing the dated curated edition.', allowAutomatic = false) {
  if (!env.ASSETS) return json({ articles: [], meta: { mode: 'seed', total: 0, lastIngestedAt: null, coverageNote: note } }, 200, { 'cache-control': 'public, max-age=60' });
  try {
    const response = await env.ASSETS.fetch(new Request(new URL('/news-data.json', request.url)));
    if (!response.ok) throw new Error('No seed');
    const seed = await response.json(); let articles = Array.isArray(seed) ? seed : seed.articles || seed.items || [];
    const params = new URL(request.url).searchParams, { limit } = newsQuery(params), rawTopic = (params.get('topic') || params.get('category') || '').trim(), topic = rawTopic ? normalizedTopic(rawTopic) : '', region = params.get('region'), q = (params.get('q') || '').toLowerCase();
    articles = articles.filter(a => (!topic || topic === 'All news' || topic === 'All events' || normalizedTopic(a.category || '') === topic) && (!region || region === 'Everywhere' || a.region === region) && (!q || [a.title, a.keywords, a.summary].join(' ').toLowerCase().includes(q)));
    const total = articles.length; articles = articles.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0, limit);
    const automatic = allowAutomatic && seed.meta?.mode === 'automatic';
    return json({ articles, meta: { ...(seed.meta || {}), mode: automatic ? 'automatic' : 'seed', total, lastIngestedAt: automatic ? (seed.meta.lastIngestedAt || seed.meta.generatedAt || null) : null, coverageNote: automatic ? (seed.meta.coverageNote || 'Automatically generated headline/link metadata, served as static JSON.') : note } }, 200, { 'cache-control': 'public, max-age=60' });
  } catch { return json({ articles: [], meta: { mode: 'seed', total: 0, lastIngestedAt: null, coverageNote: note } }, 200, { 'cache-control': 'public, max-age=30' }); }
}

// Preserve the earlier named export for callers while delegating to the single
// bounded, lease-protected runtime refresher.
export const refreshFeeds = refreshNews;

async function dailyCleanup(env) {
  if (!env.DB) return;
  const row = await env.DB.prepare("SELECT value FROM app_state WHERE key='content_cleanup'").first();
  let previous; try { previous = JSON.parse(row?.value || 'null'); } catch {}
  if (!previous?.cleanedAt || Date.parse(previous.cleanedAt) < Date.now() - 86400000) await cleanupContent(env);
}
async function recordScheduled(kind,env,work){
  const result=await work;
  const value={...result,invokedAt:new Date().toISOString()};
  await env.DB.prepare('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(kind,JSON.stringify(value)).run();
  console.log(JSON.stringify({event:kind,...value}));
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/api/ai/ask') return await handleAsk(request, env, ctx);
      if (path === '/api/ai/daily') return await handleDailyBrief(request, env);
      if (path === '/api/ai/changes') return await handleStoryChanges(request, env, ctx);
      if (path === '/api/ai/article') return await handleArticleSummary(request, env);
      if (path === '/api/watchlist' || path === '/api/watchlist/ack') return await handleWatchlist(request, env);
      const billingTest = await handleBillingTest(request, env);
      if (billingTest) return billingTest;
      const readerUpdates = await handleReaderUpdates(request,env);
      if(readerUpdates) return readerUpdates;
      const seo = await handleSeo(request, env, ctx);
      if (seo) return seo;
      const setup = await handlePayPalSetup(request, env);
      if (setup) return setup;
      const paypal = await handlePaypal(request, env);
      if (paypal) return paypal;
      if (path === '/app-config.js') return new Response('globalThis.THREADLINE_CONFIG=' + JSON.stringify(env.NEWS_STORAGE === 'static' ? { apiBase: null, mode: 'snapshot' } : { apiBase: '', mode: 'production' }) + ';\n', { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
      if (path === '/api/health') {
        const runtime = runtimeNewsFeeds(env);
        return json({
          ok: env.NEWS_STORAGE === 'static' || !!env.DB,
          databaseConfigured: !!env.DB,
          newsStorage: env.NEWS_STORAGE === 'static' ? 'static' : 'd1',
          ...contentConfig(env),
          automaticRefresh: {
            requestTriggered: env.NEWS_STORAGE !== 'static' && env.FEED_AUTO_REFRESH === 'true',
            schedule: 'News sources rotate every 10 minutes; CPI source groups rotate every two hours; annual economy series refresh monthly. See /api/pipeline/status for recorded results.',
            enabledFeeds: runtime.feeds.map(f => f.id),
            warnings: runtime.warnings
          },
          authSetupRequired: !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET
        }, env.NEWS_STORAGE === 'static' || env.DB ? 200 : 503, { 'cache-control': 'no-store' });
      }
      if (path === '/api/editorial-policy' && request.method === 'GET') return json(EDITORIAL_POLICY,200,{'cache-control':'public, max-age=3600'});
      if (path === '/api/admin/refresh-source-summaries') {
        if (request.method !== 'POST') return json({error:'method_not_allowed'},405,{allow:'POST'});
        try { await authorized(request,env); } catch(error) { return json({error:error.status===401?'Unauthorized':'Ingestion is not configured'},error.status||503,{'cache-control':'no-store'}); }
        return json(await refreshSourceSummaries(env),200,{'cache-control':'no-store'});
      }
      if (['/api/admin/refresh','/api/admin/refresh-economy','/api/admin/refresh-economy-source'].includes(path)) {
        if (request.method !== 'POST') return json({error:'method_not_allowed'},405,{allow:'POST'});
        try { await authorized(request,env); } catch(error) { return json({error:error.status===401?'Unauthorized':'Ingestion is not configured'},error.status||503,{'cache-control':'no-store'}); }
        const result=path.endsWith('refresh-economy-source')?await refreshEconomicSource(env,{force:true}):path.endsWith('refresh-economy')?await refreshEconomy(env,{force:true}):await refreshNews(env,{force:true});
        return json(result,result.ok?200:502,{'cache-control':'no-store'});
      }
      if (path === '/api/news' && env.NEWS_STORAGE === 'static') return request.method === 'GET' ? seedNews(request, env, 'Showing a dated snapshot; it is not the production database feed.', true) : json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
      if (path === '/api/sources' && request.method === 'GET') return json({ sources: FEEDS.map(f => ({ id: f.id, publisher: f.publisher, sourceType: f.sourceType, enabled: runtimeNewsFeeds(env).feeds.some(x => x.id === f.id || (f.id === 'google-world' && x.id.startsWith('google-'))), topics: f.id === 'google-world' ? runtimeNewsFeeds(env).feeds.filter(x=>x.id.startsWith('google-')).map(x=>x.id) : undefined, terms: f.terms, note: f.note || null })) }, 200, { 'cache-control': 'public, max-age=300' });
      if (path === '/api/account' && request.method === 'DELETE' && sameOriginMutation(request, env)) {
        const deletion = await request.clone().json().catch(() => ({}));
        if (deletion?.confirm === 'DELETE') {
          const { user } = await currentSession(request, env);
          if (user) {
            const cancellation = await cancelForAccountDeletion(request, env, user.id);
            if (!cancellation.ok) return cancellation.response;
          }
        }
      }
      if (path.startsWith('/api/auth/') || path === '/api/preferences' || path === '/api/privacy' || path.startsWith('/api/account')) return await handleAuth(request, env);
      const query = new URL(request.url).searchParams;
      const requestsArchive = query.get('archive') === '1';
      const eventDetail = /^\/api\/events\/[^/]+$/.test(path);
      const eventCoverage = /^\/api\/events\/[^/]+\/coverage(?:\/coverage-[a-f0-9]{40}\/revisions)?$/.test(path);
      const eventCoverageList = /^\/api\/events\/[^/]+\/coverage$/.test(path);
      const eventCoverageRevisions = eventCoverage && path.endsWith('/revisions');
      const entitlementSensitive = requestsArchive || eventDetail || eventCoverage;
      let paidAccess = false;
      if (request.method === 'GET' && entitlementSensitive) {
        const { user } = await currentSession(request, env);
        paidAccess = await hasPaidAccess(env, user?.id);
      }
      if (request.method === 'GET' && eventCoverageRevisions && !paidAccess) {
        return json({ error: 'archive_access_required', message: 'Sign in with a supporter account to view prior source-coverage revisions.' }, 403, { 'cache-control': 'private, no-store' });
      }
      if (request.method === 'GET' && eventCoverageList && !paidAccess) {
        const since = query.get('since');
        const validDate = since && /^\d{4}-\d{2}-\d{2}$/.test(since)
          && Number.isFinite(Date.parse(since))
          && new Date(since).toISOString().slice(0, 10) === since;
        // An invalid date is left for the route validator to reject. Valid
        // requests before the ordinary news window require verified access.
        if (validDate) {
          const days = contentConfig(env).feedDays;
          const exactCutoff = new Date(Date.now() - days * 86400000);
          const publicSince = new Date(exactCutoff);
          if (exactCutoff.toISOString().slice(11) !== '00:00:00.000Z') publicSince.setUTCDate(publicSince.getUTCDate() + 1);
          if (since < publicSince.toISOString().slice(0, 10)) {
            return json({ error: 'archive_access_required', message: 'Sign in with a supporter account to view older source coverage.' }, 403, { 'cache-control': 'private, no-store' });
          }
        } else if (!since) {
          const days = contentConfig(env).feedDays;
          const exactCutoff = new Date(Date.now() - days * 86400000);
          if (exactCutoff.toISOString().slice(11) !== '00:00:00.000Z') exactCutoff.setUTCDate(exactCutoff.getUTCDate() + 1);
          query.set('since', exactCutoff.toISOString().slice(0, 10));
          const boundedUrl = new URL(request.url);
          boundedUrl.searchParams.set('since', query.get('since'));
          request = new Request(boundedUrl, { method: 'GET', headers: request.headers });
        }
      }
      // Never put subscriber timelines, archives or historical source records
      // in the shared Cache API under a URL that a guest can request.
      const publicRead=request.method==='GET'&&(/^\/api\/(?:news|events)(?:\/|$)/.test(path)||['/api/facets','/api/economy'].includes(path))&&!requestsArchive&&!eventDetail&&!eventCoverage;
      const cache=publicRead?globalThis.caches?.default:null,cacheKey=publicRead?new Request(request.url,{method:'GET'}):null;
      if(cache){const hit=await cache.match(cacheKey);if(hit)return hit;}
      const content = await handleContent(request, env, ctx, { canAccessArchive: paidAccess, canAccessFullTimelines: eventDetail && (env.PUBLIC_TIMELINES === 'true' || paidAccess) });
      if (content) {
        if (env.NEWS_STORAGE !== 'static' && env.FEED_AUTO_REFRESH === 'true' && path === '/api/news' && ctx?.waitUntil) ctx.waitUntil(refreshNews(env));
        if (path === '/api/ingest' && content.ok && ctx?.waitUntil) ctx.waitUntil(dailyCleanup(env));
        if(cache&&content.ok){const cached=new Response(content.body,content);cached.headers.set('cache-control','public, max-age=30, s-maxage=60');if(ctx?.waitUntil)ctx.waitUntil(cache.put(cacheKey,cached.clone()));return cached;}
        return content;
      }
      if (path.startsWith('/api/')) return json({ error: 'not_found' }, 404);
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('ThreadNews frontend assets are not bound.', { status: 503 });
    } catch {
      // Never return OAuth credentials, upstream response bodies or private query data.
      console.error(JSON.stringify({event:'request_failed',path:path.startsWith('/api/')?path.split('/').slice(0,3).join('/'):'asset'}));
      return json({ error: 'service_unavailable', message: 'Please try again later.' }, 503, { 'cache-control': 'no-store' });
    }
  },
  async scheduled(controller, env, ctx) {
    if (env.NEWS_STORAGE === 'static' || !env.DB) return;
    if (controller.cron === '*/10 * * * *') ctx.waitUntil((async()=>{
      await recordScheduled('scheduled_news',env,refreshNews(env));
      await Promise.all([
        recordScheduled('scheduled_source_summaries', env, refreshSourceSummaries(env)),
        recordScheduled('scheduled_reader_updates',env,dispatchReaderUpdates(env))
      ]);
    })());
    if (controller.cron === '0 */2 * * *') ctx.waitUntil(recordScheduled('scheduled_economy_source',env,refreshEconomicSource(env,{now:new Date(controller.scheduledTime)})));
    if (controller.cron === '43 5 1 * *') ctx.waitUntil(recordScheduled('scheduled_annual_economy',env,refreshEconomy(env)));
    if (controller.cron === '17 3 * * *') ctx.waitUntil(recordScheduled('scheduled_paypal_reconciliation',env,reconcilePayPalSubscriptions(env)));
  }
};
