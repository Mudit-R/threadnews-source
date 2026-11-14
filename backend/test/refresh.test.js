import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { refreshNews, refreshEconomy, runtimeNewsFeeds, DEFAULT_PERMITTED_FEEDS } from '../src/refresh.js';
import { importEconomy, storeArticles } from '../src/content.js';

const now = new Date('2026-11-03T12:00:00.000Z');
const later = seconds => new Date(now.getTime() + seconds * 1000);
function database() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      return { sql, args: [], bind(...args) { return { ...this, args }; },
        async first() { const row = sqlite.prepare(this.sql).get(...this.args); return row ? { ...row } : null; },
        async all() { return { results: sqlite.prepare(this.sql).all(...this.args).map(row => ({ ...row })) }; },
        async run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.args).changes) } }; }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return { sqlite, DB };
}
function rss(title = 'An attributed announcement', count = 1) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Agency</title>${Array.from({ length: count }, (_, i) => `<item><title>${title}${i || ''}</title><link>https://agency.example.com/release-${i}</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><description><![CDATA[<ul><li>FULL ARTICLE TEXT IS NOT METADATA</li></ul>]]></description></item>`).join('')}</channel></rss>`;
}
const officialEnv = DB => ({ DB, ENABLED_FEEDS: 'un-news' });
const rowCount = (db, table) => db.sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
function economyDocument() {
  return { countries: Array.from({ length: 19 }, (_, i) => ({ iso3: 'AA' + String.fromCharCode(65 + i), name: 'Country ' + i, gdpGrowth: [{ year: 2024, value: 1 }], inflation: [{ year: 2024, value: 2 }], latestInflation: { period: '2026-08', value: 3, releaseDate: '2026-09-12', source: { publisher: 'National statistical office', url: 'https://agency.example.com/cpi' } }, monthlyVintages: [{ period: '2026-07', value: 2.8 }] })), meta: { asOfDate: '2026-11-03', notes: ['No2026 annual GDP or annual CPI rows were returned by the World Bank API.'] } };
}
function annualResponse(document, input) {
  const url = new URL(input), indicator = url.pathname.split('/').at(-1);
  assert.equal(url.origin, 'https://api.worldbank.org'); assert.equal(url.searchParams.get('date'), '2015:2026');
  const rows = document.countries.flatMap((c, i) => [
    { countryiso3code: c.iso3, indicator: { id: indicator }, date: '2025', value: i === 0 ? 0 : 2 + i / 10 },
    { countryiso3code: c.iso3, indicator: { id: indicator }, date: '2026', value: null }
  ]);
  return Response.json([{ page: 1, pages: 1, total: rows.length, lastupdated: '2026-10-08' }, rows]);
}

test('runtime sources come from the registry; Google topics are bounded and explicitly enabled', () => {
  assert.deepEqual(DEFAULT_PERMITTED_FEEDS, ['nasa', 'un-news']);
  assert.deepEqual(runtimeNewsFeeds({}).feeds.map(f => f.id), ['nasa', 'un-news']);
  assert.equal(runtimeNewsFeeds({ ENABLED_FEEDS: 'google-world' }).feeds.length, 0);
  const selected = runtimeNewsFeeds({ ENABLED_FEEDS: 'google-world,cna-world,https://attacker.example.com/rss', GOOGLE_NEWS_RIGHTS_ACK: 'true', GOOGLE_NEWS_TOPICS: 'WORLD,BUSINESS,WORLD,UNKNOWN' });
  assert.deepEqual(selected.feeds.map(f => f.id), ['google-world','google-business']);
  assert.equal(selected.feeds[1].category,'Economy');
  assert(selected.feeds.every(f => new URL(f.url).origin === 'https://news.google.com'));
  assert.equal(selected.warnings.length, 2);
});

test('news refresh persists attributed metadata, revision updates, validators and a bounded cycle count', async () => {
  const db = database(), env = officialEnv(db.DB); let calls = 0;
  const fetchImpl = async (input, options) => {
    assert.equal(new URL(input).hostname, 'news.un.org'); assert.equal(options.redirect, 'manual');
    if (calls++) assert.equal(options.headers['if-none-match'], '"v1"');
    return new Response(rss(calls === 1 ? 'Initial headline' : 'Corrected headline'), { headers: { etag: '"v1"' } });
  };
  const first = await refreshNews(env, { force: true, fetchImpl, now });
  assert.equal(first.ok, true); assert.equal(first.items, 1); assert.equal(first.feedCount, 1); assert.equal(first.cycleLength, 1);
  assert.equal(rowCount(db, 'news'), 1); assert.equal(rowCount(db, 'article_source_lineage'), 1);
  const initial = db.sqlite.prepare('SELECT * FROM news').get();
  assert.equal(initial.publisher, 'UN News'); assert.equal(initial.source_type, 'Official source');
  assert(!JSON.stringify(initial).includes('FULL ARTICLE TEXT'));
  await refreshNews(env, { force: true, fetchImpl, now: later(60) });
  assert.equal(rowCount(db, 'news'), 1); assert.equal(rowCount(db, 'article_revisions'), 1);
  assert.equal(db.sqlite.prepare('SELECT title FROM news').get().title, 'Corrected headline');
  const state = db.sqlite.prepare("SELECT * FROM feed_state WHERE id='un-news'").get();
  assert.equal(state.item_count, 1); assert.equal(state.last_success_at, later(60).toISOString()); assert.equal(state.error, null);
  const skipped = await refreshNews(env, { fetchImpl, now: later(61) });
  assert.equal(skipped.skipped, 'not_due'); assert.equal(calls, 2);
});

test('automatic feeds with unsupported categories are retained as auditable rejections, not news', async () => {
  const db = database();
  const result = await refreshNews({ DB: db.DB, ENABLED_FEEDS: 'nasa' }, { force: true, fetchImpl: async () => new Response(rss()), now });
  assert.equal(result.ok, true);
  assert.equal(result.items, 0);
  assert.equal(result.rejectedByCategory, 1);
  assert.equal(rowCount(db, 'news'), 0);
  assert.deepEqual(db.sqlite.prepare('SELECT submitted_category,reject_reason FROM article_category_rejections').all().map(row => ({ ...row })), [
    { submitted_category: 'Space & science', reject_reason: 'category_not_allowed' }
  ]);
});

test('failed sources advance the persisted cursor so another publisher can succeed', async () => {
  const db = database();
  const fetchImpl = async input => new URL(input).hostname === 'www.nasa.gov' ? new Response('Raw upstream failure body', { status: 503 }) : new Response(rss());
  const first = await refreshNews({ DB: db.DB }, { force: true, fetchImpl, now });
  assert.equal(first.ok, false); assert.equal(first.reason, 'feed_http_503'); assert.equal(first.feedCount, 2);
  assert.equal(db.sqlite.prepare("SELECT error FROM feed_state WHERE id='nasa'").get().error, 'feed_http_503');
  const second = await refreshNews({ DB: db.DB }, { force: true, fetchImpl, now: later(1) });
  assert.equal(second.ok, true); assert.equal(second.feed, 'un-news'); assert.equal(rowCount(db, 'news'), 1);
  assert(!JSON.stringify(first).includes('Raw upstream'));
});

test('a shared D1 lease prevents concurrent forced refreshes', async () => {
  const db = database(), env = officialEnv(db.DB); let started, resume;
  const began = new Promise(resolve => { started = resolve; }), pending = new Promise(resolve => { resume = resolve; });
  const first = refreshNews(env, { force: true, now, fetchImpl: async () => { started(); await pending; return new Response(rss()); } });
  await began;
  const concurrent = await refreshNews(env, { force: true, now, fetchImpl: async () => { throw new Error('Must not fetch'); } });
  assert.equal(concurrent.skipped, 'another_refresh_running');
  resume(); assert.equal((await first).ok, true);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM app_state WHERE key='refresh_news_lock'").get().n, 0);
});

test('an old invocation cannot write after losing its lease or unlock the replacement owner', async () => {
  const db = database(), env = officialEnv(db.DB); let started, resume;
  const began = new Promise(resolve => { started = resolve; }), pending = new Promise(resolve => { resume = resolve; });
  const refresh = refreshNews(env, { force: true, now, fetchImpl: async () => { started(); await pending; return new Response(rss()); } });
  await began;
  const replacement = String(now.getTime() + 999999) + '|replacement';
  db.sqlite.prepare("UPDATE app_state SET value=? WHERE key='refresh_news_lock'").run(replacement);
  resume(); const result = await refresh;
  assert.equal(result.reason, 'refresh_lease_lost'); assert.equal(rowCount(db, 'news'), 0);
  assert.equal(db.sqlite.prepare("SELECT value FROM app_state WHERE key='refresh_news_lock'").get().value, replacement);
});

test('conditional responses preserve article timestamps and successful item count without creating revisions', async () => {
  const db = database(), env = officialEnv(db.DB);
  await refreshNews(env, { force: true, now, fetchImpl: async () => new Response(rss(), { headers: { etag: '"v1"' } }) });
  const original = db.sqlite.prepare('SELECT ingested_at FROM news').get().ingested_at;
  const result = await refreshNews(env, { force: true, now: later(10), fetchImpl: async (input, options) => { assert.equal(options.headers['if-none-match'], '"v1"'); return new Response(null, { status: 304 }); } });
  assert.equal(result.notModified, true); assert.equal(result.items, 0);
  assert.equal(db.sqlite.prepare('SELECT ingested_at FROM news').get().ingested_at, original);
  assert.equal(db.sqlite.prepare("SELECT item_count FROM feed_state WHERE id='un-news'").get().item_count, 1);
  assert.equal(rowCount(db, 'article_revisions'), 0);
});

test('byte/item limits are enforced and daily cleanup retains the archive while deleting expired records', async () => {
  const db = database(), env = { ...officialEnv(db.DB), FEED_MAX_ITEMS: '1' };
  const record = (id, days) => ({ id, title: 'An older report', category: 'World affairs', publishedAt: new Date(now.getTime() - days * 86400000).toISOString(), source: { publisher: 'Archive', url: 'https://agency.example.com/' + id } });
  await storeArticles(env, [record('expired', 181), record('archive', 6)], 'historical', 'manual', { now });
  const result = await refreshNews(env, { force: true, now, fetchImpl: async () => new Response(rss('Bounded', 3)) });
  assert.equal(result.items, 1); assert.equal(result.cleanup.deleted, 1); assert.equal(result.cleanup.archived, 1); assert.equal(rowCount(db, 'news'), 2);
  const failed = await refreshNews({ ...env, FEED_MAX_BYTES: '16384' }, { force: true, now: later(1), fetchImpl: async () => new Response(rss(), { headers: { 'content-length': '20000' } }) });
  assert.equal(failed.ok, false); assert.equal(failed.reason, 'feed_parse_failed'); assert.equal(rowCount(db, 'news'), 2);
  const state = db.sqlite.prepare("SELECT * FROM feed_state WHERE id='un-news'").get();
  assert.equal(state.last_success_at, now.toISOString()); assert.equal(state.item_count, 1);
});

test('annual Worker refresh reads dynamic country metadata, preserves monthly vintages and labels its scope', async () => {
  const db = database(), env = { DB: db.DB }, original = economyDocument();
  await importEconomy(env, original, { now });
  const result = await refreshEconomy(env, { force: true, now, fetchImpl: async input => annualResponse(original, input) });
  assert.equal(result.ok, true); assert.equal(result.countries, 19); assert.equal(result.annualThroughYear, 2025);
  const stored = JSON.parse(db.sqlite.prepare("SELECT payload_json FROM content_documents WHERE id='economy'").get().payload_json);
  assert.deepEqual(stored.countries[0].latestInflation, original.countries[0].latestInflation);
  assert.deepEqual(stored.countries[0].monthlyVintages, original.countries[0].monthlyVintages);
  assert.equal(stored.countries[0].gdpGrowth.find(row => row.year === 2025).value, 0);
  assert.equal(stored.countries[0].gdpGrowth.find(row => row.year === 2026).value, null);
  assert.equal(stored.meta.monthlyRefresh.nationalSourcesChecked, false);
  assert.equal(stored.meta.monthlyRefresh.status, 'requires-national-source-refresh');
  const skipped = await refreshEconomy(env, { now: later(100), fetchImpl: async () => { throw new Error('Must not fetch'); } });
  assert.equal(skipped.skipped, 'not_due');
});

test('an annual API failure leaves the existing economy document and monthly records intact', async () => {
  const db = database(), env = { DB: db.DB }, original = economyDocument();
  await importEconomy(env, original, { now });
  const before = db.sqlite.prepare('SELECT content_hash FROM content_documents').get().content_hash;
  const result = await refreshEconomy(env, { force: true, now, fetchImpl: async () => new Response('Raw upstream body', { status: 503 }) });
  assert.equal(result.reason, 'world_bank_http_503'); assert.equal(db.sqlite.prepare('SELECT content_hash FROM content_documents').get().content_hash, before);
  const status = JSON.parse(db.sqlite.prepare("SELECT value FROM app_state WHERE key='economy_refresh_status'").get().value);
  assert.equal(status.ok, false); assert(!JSON.stringify(status).includes('Raw upstream'));
  assert.equal((await refreshEconomy(env, { now: later(1) })).skipped, 'retry_not_due');
});

test('an annual refresh cannot overwrite a concurrent national monthly import', async () => {
  const db = database(), env = { DB: db.DB }, original = economyDocument(), updated = structuredClone(original); let requests = 0;
  updated.countries[0].latestInflation.value = 9;
  await importEconomy(env, original, { now });
  const result = await refreshEconomy(env, { force: true, now, fetchImpl: async input => {
    if (++requests === 2) await importEconomy(env, updated, { now: later(1) });
    return annualResponse(original, input);
  } });
  assert.equal(result.reason, 'economy_document_changed_during_refresh');
  const saved = JSON.parse(db.sqlite.prepare('SELECT payload_json FROM content_documents').get().payload_json);
  assert.equal(saved.countries[0].latestInflation.value, 9);
});

test('missing configuration or a missing economy import produces safe no-op results', async () => {
  assert.equal((await refreshNews({})).reason, 'database_not_configured');
  assert.equal((await refreshEconomy({})).reason, 'database_not_configured');
  const db = database();
  assert.equal((await refreshEconomy({ DB: db.DB }, { force: true, now })).reason, 'economy_not_imported');
  const noFeeds = await refreshNews({ DB: db.DB, ENABLED_FEEDS: 'https://attacker.example.com/rss' }, { force: true, now });
  assert.equal(noFeeds.reason, 'no_enabled_feeds'); assert.equal(noFeeds.feedCount, 0);
});
