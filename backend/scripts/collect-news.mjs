import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { FEEDS, enabledFeeds } from '../src/feeds.js';
import { readLimited } from '../src/feed.js';
import { readSource, fetchSource } from '../src/discovery.js';
import { CollectorError, fetchJSON } from '../src/upstream.js';

const GOOGLE_TOPICS = { WORLD: 'World', BUSINESS:'Economy', HEALTH: 'Health' };
export { CollectorError, fetchJSON };
export function collectorConfig(env) {
  if (typeof env.INGEST_SECRET !== 'string' || env.INGEST_SECRET.length < 24 || env.INGEST_SECRET.length > 4096) throw new CollectorError('Set INGEST_SECRET to a value of at least 24 characters.');
  let origin;
  try { origin = new URL(env.APP_ORIGIN); } catch { throw new CollectorError('Set APP_ORIGIN to the production HTTPS origin.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new CollectorError('APP_ORIGIN must be a plain HTTPS origin.');
  return { origin, secret: env.INGEST_SECRET };
}
export async function postIngest(body, { env = process.env, fetchImpl = fetch } = {}) {
  const { origin, secret } = collectorConfig(env), encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new CollectorError('ingest_payload_too_large');
  const response = await fetchImpl(new URL('/api/ingest', origin), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret }, body: encoded
  });
  if (!response.ok) throw new CollectorError('ingest_http_' + response.status);
  let result;
  try { result = JSON.parse(await readLimited(response, 64 * 1024)); } catch { throw new CollectorError('invalid_ingest_acknowledgement'); }
  if (result?.ok !== true) throw new CollectorError('invalid_ingest_acknowledgement');
  return result;
}
export function selectNewsFeeds(env = {}) {
  const warnings = [], selected = enabledFeeds(env), feeds = [];
  if (typeof env.ENABLED_FEEDS === 'string') {
    const configured = env.ENABLED_FEEDS.split(',').map(x => x.trim()).filter(Boolean);
    if (configured.some(id => !FEEDS.some(feed => feed.id === id))) warnings.push('Some unknown feed identifiers were ignored.');
    if (configured.some(id => FEEDS.some(feed => feed.id === id && feed.blocked))) warnings.push('A blocked publisher was skipped; registry restrictions still apply.');
  }
  for (const feed of selected) {
    if (feed.id !== 'google-world') { feeds.push(feed); continue; }
    if (env.GOOGLE_NEWS_ENABLED !== 'true' && env.GOOGLE_NEWS_RIGHTS_ACK !== 'true') {
      warnings.push('Google headline discovery is not enabled.');
      continue;
    }
    const requested = [...new Set(String(env.GOOGLE_NEWS_TOPICS || 'WORLD').split(',').map(x => x.trim().toUpperCase()).filter(Boolean))];
    if (requested.some(topic => !Object.hasOwn(GOOGLE_TOPICS, topic))) warnings.push('Some unknown Google News topics were ignored.');
    for (const topic of requested.filter(topic => Object.hasOwn(GOOGLE_TOPICS, topic))) {
      // Only explicit topic identifiers on the registry's fixed Google origin.
      const base = new URL(feed.url), url = new URL('/rss/headlines/section/topic/' + topic, base);
      url.search = base.search;
      feeds.push({ ...feed, id: 'google-' + topic.toLowerCase(), url: url.href, category: GOOGLE_TOPICS[topic] });
    }
  }
  return { feeds, warnings };
}
function failure(error, fallback) { return error instanceof CollectorError ? error.code : fallback; }

/** Collect headline/link metadata directly into D1 via the authenticated API.
 * No files, commits, builds or deployments are produced by this runner. */
export async function collectNews({ env = process.env, fetchImpl = fetch, clock = () => new Date() } = {}) {
  collectorConfig(env);
  const { feeds, warnings } = selectNewsFeeds(env), successes = [], errors = [];
  for (const feed of feeds) {
    const attempt = clock().toISOString(); let stage = 'feed_fetch', accepted = 0, rejectedByCategory = 0;
    try {
      const response = await fetchSource(feed, { fetchImpl, headers: { accept: feed.format==='gdelt'?'application/json':'application/rss+xml, application/atom+xml, application/xml', 'user-agent': 'ThreadNews/0.3 (headline/link metadata collector)' }, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new CollectorError('feed_http_' + response.status);
      stage = 'feed_parse';
      const articles = await readSource(response, feed, clock());
      stage = 'ingest';
      // parseFeed is already bounded to 50 items; retain an explicit API bound.
      for (let start = 0; start < Math.max(1, articles.length); start += 100) {
        const batch = articles.slice(start, start + 100), final = start + 100 >= articles.length;
        const result = await postIngest({ articles: batch, feedId: feed.id, mode: 'automatic', ...(final ? { feedState: { lastAttemptAt: attempt, lastSuccessAt: clock().toISOString(), itemCount: articles.length, error: null } } : {}) }, { env, fetchImpl });
        accepted += Number(result.articles?.accepted) || 0;
        rejectedByCategory += Number(result.articles?.rejectedByCategory) || 0;
      }
      successes.push({ id: feed.id, items: articles.length, accepted, rejectedByCategory });
    } catch (error) {
      const note = failure(error, stage + '_failed');
      const entry = { id: feed.id, stage, note, healthRecorded: false };
      try {
        await postIngest({ articles: [], feedId: feed.id, mode: 'automatic', feedState: { lastAttemptAt: attempt, error: note } }, { env, fetchImpl });
        entry.healthRecorded = true;
      } catch { /* An unavailable ingestion API cannot record its own failure. */ }
      errors.push(entry);
    }
  }
  return { ok: successes.length > 0, successes, errors, warnings, attemptedFeeds: feeds.length, completedAt: clock().toISOString(), note: 'Existing database records are retained when an upstream feed or ingestion request fails. Automatic entries are attributed headline/link metadata, not full article copies.' };
}
export async function main() {
  const result = await collectNews();
  // Only source identifiers, counts and controlled status notes are logged.
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(failure(error, 'news_collection_failed')); process.exitCode = 1; });
}
