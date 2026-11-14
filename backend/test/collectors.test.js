import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNews, selectNewsFeeds, collectorConfig, postIngest } from '../scripts/collect-news.mjs';
import { refreshEconomy, worldBankIndicator, assembleEconomy, countryMetadata } from '../scripts/refresh-economy.mjs';

const env = { APP_ORIGIN: 'https://threadline.example.com', INGEST_SECRET: 'collector-test-secret-of-at-least-32-characters' };
const now = new Date('2026-11-03T12:00:00Z');
const clock = () => new Date(now);
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Agency</title><item><title>A newly attributed announcement</title><link>https://agency.example.com/release</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><description><![CDATA[<ul><li>FULL ARTICLE BODY MUST NOT BE COPIED</li></ul>]]></description></item></channel></rss>`;
const acknowledged = () => Response.json({ ok: true });
function fixtureEconomy() {
  return { countries: Array.from({ length: 19 }, (_, i) => ({ iso3: 'AA' + String.fromCharCode(65 + i), name: 'Country ' + i, gdpGrowth: [{ year: 2024, value: 1 }], inflation: [{ year: 2024, value: 2 }], latestInflation: { period: '2026-07', value: 3, releaseDate: '2026-08-12', source: { publisher: 'National statistical office', url: 'https://agency.example.com/cpi' } } })), meta: { asOfDate: '2026-11-03', window: { startYear: 2015 }, notes: ['No2026 annual GDP or annual CPI rows were returned by the World Bank API.'] } };
}
function observations(seed, indicator) {
  return seed.countries.flatMap((country, i) => [
    { countryiso3code: country.iso3, indicator: { id: indicator }, date: '2025', value: i === 0 ? 0 : 2 + i / 10 },
    { countryiso3code: country.iso3, indicator: { id: indicator }, date: '2026', value: null }
  ]);
}
function annualFetcher(seed, live = seed, failureIndicator) {
  const posts = [], calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input); calls.push({ url: url.href, options });
    if (url.pathname === '/api/economy') return live === null ? new Response('', { status: 404 }) : Response.json(live);
    if (url.pathname === '/api/ingest') { posts.push(JSON.parse(options.body)); return acknowledged(); }
    assert.equal(url.origin, 'https://api.worldbank.org'); assert.equal(url.searchParams.get('date'), '2015:2026');
    const indicator = url.pathname.split('/').at(-1);
    if (indicator === failureIndicator) return new Response('', { status: 503 });
    return Response.json([{ page: 1, pages: 1, total: 38, lastupdated: '2026-10-08' }, observations(seed, indicator)]);
  };
  return { fetchImpl, posts, calls };
}

test('news sources default to the official registry and Google topics require explicit opt-in', () => {
  assert.deepEqual(selectNewsFeeds({}).feeds.map(f => f.id), ['nasa', 'un-news']);
  const skipped = selectNewsFeeds({ ENABLED_FEEDS: 'nasa,google-world,cna-world,unknown' });
  assert.deepEqual(skipped.feeds.map(f => f.id), ['nasa']); assert.equal(skipped.warnings.length, 3);
  const google = selectNewsFeeds({ ENABLED_FEEDS: 'google-world', GOOGLE_NEWS_RIGHTS_ACK: 'true', GOOGLE_NEWS_TOPICS: 'WORLD,BUSINESS,UNKNOWN,WORLD' });
  assert.deepEqual(google.feeds.map(f => f.id), ['google-world','google-business']);
  assert.equal(google.feeds[1].category,'Economy');
  assert(google.feeds.every(f => new URL(f.url).origin === 'https://news.google.com'));
  assert.equal(google.warnings.length, 1);
});

test('news collector parses real RSS, posts headline metadata, and persists honest per-feed outcomes', async () => {
  const posts = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(options.redirect, url.pathname === '/api/ingest' ? 'error' : 'manual');
    if (url.pathname === '/api/ingest') {
      assert.equal(options.headers.authorization, 'Bearer ' + env.INGEST_SECRET);
      const payload = JSON.parse(options.body); posts.push(payload);
      const rejectedByCategory = payload.articles.filter(item => item.category === 'Space & science').length;
      return Response.json({ ok: true, articles: { accepted: payload.articles.length - rejectedByCategory, rejectedByCategory } });
    }
    if (url.hostname === 'news.un.org') return new Response('Untrusted source error body', { status: 503 });
    assert.equal(url.hostname, 'www.nasa.gov'); return new Response(rss);
  };
  const result = await collectNews({ env, fetchImpl, clock });
  assert.equal(result.ok, true); assert.deepEqual(result.successes, [{ id: 'nasa', items: 1, accepted: 0, rejectedByCategory: 1 }]);
  assert.equal(result.errors[0].note, 'feed_http_503'); assert.equal(result.errors[0].healthRecorded, true);
  const success = posts.find(p => p.feedId === 'nasa');
  assert.equal(success.mode, 'automatic'); assert.equal(success.articles[0].source.basis, 'headline');
  assert.equal(success.feedState.lastSuccessAt, now.toISOString()); assert.equal(success.feedState.itemCount, 1);
  assert(!JSON.stringify(success).includes('FULL ARTICLE BODY'));
  const failed = posts.find(p => p.feedId === 'un-news');
  assert.deepEqual(failed.articles, []); assert.equal(failed.feedState.lastSuccessAt, undefined);
  assert(!JSON.stringify(result).includes(env.INGEST_SECRET)); assert(!JSON.stringify(result).includes('Untrusted source error body'));
});

test('all upstream failures preserve the database and never claim ingestion success', async () => {
  const posts = [];
  const fetchImpl = async (input, options = {}) => {
    if (new URL(input).pathname === '/api/ingest') { posts.push(JSON.parse(options.body)); return acknowledged(); }
    throw new Error('Unexpected upstream error that must not be logged');
  };
  const result = await collectNews({ env, fetchImpl, clock });
  assert.equal(result.ok, false); assert.equal(result.errors.length, 2);
  assert(posts.every(p => p.articles.length === 0 && !p.feedState.lastSuccessAt));
  assert(!JSON.stringify(result).includes('Unexpected upstream'));
});

test('ingestion failure does not advance feed success, secrets never follow redirects, and unsafe config fails early', async () => {
  const fetchImpl = async (input, options = {}) => new URL(input).pathname === '/api/ingest' ? new Response('Echoed untrusted data', { status: 503 }) : new Response(rss);
  const result = await collectNews({ env: { ...env, ENABLED_FEEDS: 'nasa' }, fetchImpl, clock });
  assert.equal(result.ok, false); assert.equal(result.errors[0].note, 'ingest_http_503'); assert.equal(result.errors[0].healthRecorded, false);
  assert.throws(() => collectorConfig({ ...env, APP_ORIGIN: 'https://user:pass@threadline.example.com' }));
  assert.throws(() => collectorConfig({ ...env, APP_ORIGIN: 'http://threadline.example.com' }));
  await assert.rejects(postIngest({}, { env, fetchImpl: async () => new Response('', { status: 302 }) }), /ingest_http_302/);
});

test('annual economy refresh uses all configured country IDs, preserves live CPI source snapshots and null gaps', async () => {
  const seed = fixtureEconomy(), live = structuredClone(seed);
  live.meta.monthlyRefresh = { status: 'partial', nationalSourcesChecked: true, lastNationalSourceCheckAt: '2026-11-02T12:00:00.000Z', sourceSnapshotAsOf: '2026-11-02', lastSourceCheckAt: '2026-11-02T12:00:00.000Z' };
  live.countries[0].latestInflation = { ...live.countries[0].latestInflation, period: '2026-09', value: 5.5, releaseDate: '2026-10-12' };
  live.countries[0].monthlyVintages = [{ period: '2026-08', value: 4.2 }];
  const network = annualFetcher(seed, live), result = await refreshEconomy({ env, fetchImpl: network.fetchImpl, now, seedDocument: seed });
  assert.equal(result.ok, true); assert.equal(result.countries, 19); assert.equal(result.annualThroughYear, 2025);
  const payload = network.posts[0].economy;
  assert.match(network.posts[0].expectedEconomyHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(payload.countries[0].latestInflation, live.countries[0].latestInflation);
  assert.deepEqual(payload.countries[0].monthlyVintages, live.countries[0].monthlyVintages);
  assert.equal(payload.countries[0].gdpGrowth.find(v => v.year === 2025).value, 0);
  assert.equal(payload.countries[0].gdpGrowth.find(v => v.year === 2026).value, null);
  assert.equal(payload.countries[0].latestAnnualGdpGrowth.value, 0);
  assert.equal(payload.meta.monthlyRefresh.nationalSourcesChecked, true);
  assert.equal(payload.meta.monthlyRefresh.lastNationalSourceCheckAt, '2026-11-02T12:00:00.000Z');
  assert.equal(payload.meta.monthlyRefresh.sourceSnapshotAsOf, '2026-11-02');
  assert.equal(payload.meta.monthlyRefresh.lastNationalSourceAttemptAt, now.toISOString());
  assert.equal(payload.meta.monthlyRefresh.status, 'failed');
  assert.equal(payload.meta.monthlyRefresh.sources.every(source => source.status === 'failed'), true);
  assert(!payload.meta.notes.some(note => note.startsWith('No2026')));
  const countryPath = network.calls.find(c => c.url.includes('worldbank.org')).url;
  assert(seed.countries.every(c => countryPath.includes(c.iso3)));
});

test('annual collector rebases once after a concurrent economy write and preserves the new CPI snapshot', async () => {
  const seed = fixtureEconomy(), firstLive = structuredClone(seed), latestLive = structuredClone(seed), posts = [];
  firstLive.countries[0].latestInflation.value = 5.5;
  latestLive.countries[0].latestInflation = { ...latestLive.countries[0].latestInflation, period: '2026-10', value: 6.8, releaseDate: '2026-11-02' };
  latestLive.countries[0].monthlyVintages = [{ period: '2026-09', value: 5.9, source: 'concurrent native CPI refresh' }];
  let economyReads = 0, ingestWrites = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/economy') {
      economyReads++;
      return Response.json(economyReads === 1 ? firstLive : latestLive, { headers: { etag: `"${economyReads === 1 ? 'a' : 'b'}${'0'.repeat(63)}"` } });
    }
    if (url.pathname === '/api/ingest') {
      const body = JSON.parse(options.body); posts.push(body); ingestWrites++;
      return ingestWrites === 1 ? new Response('', { status: 409 }) : acknowledged();
    }
    if (url.hostname === 'api.worldbank.org') {
      const indicator = url.pathname.split('/').at(-1);
      return Response.json([{ page: 1, pages: 1, total: 38, lastupdated: '2026-10-08' }, observations(seed, indicator)]);
    }
    return new Response('', { status: 503 });
  };
  const result = await refreshEconomy({ env, fetchImpl, now, seedDocument: seed });
  assert.equal(result.ok, true);
  assert.equal(economyReads, 2);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].expectedEconomyHash, 'a' + '0'.repeat(63));
  assert.equal(posts[1].expectedEconomyHash, 'b' + '0'.repeat(63));
  assert.equal(posts[1].economy.countries[0].latestInflation.value, 6.8);
  assert.deepEqual(posts[1].economy.countries[0].monthlyVintages, latestLive.countries[0].monthlyVintages);
});

test('an annual API failure or unavailable live document never posts an economy replacement', async () => {
  const seed = fixtureEconomy(), network = annualFetcher(seed, seed, 'FP.CPI.TOTL.ZG');
  await assert.rejects(refreshEconomy({ env, fetchImpl: network.fetchImpl, now, seedDocument: seed }), /upstream_http_503/);
  assert.equal(network.posts.length, 0);
  let calls = 0;
  await assert.rejects(refreshEconomy({ env, fetchImpl: async () => { calls++; return new Response('', { status: 503 }); }, now, seedDocument: seed }), /live_economy_read_http_503/);
  assert.equal(calls, 1);
});

test('all-fail economy bootstrap records attempts but does not manufacture a successful source snapshot', async () => {
  const seed = fixtureEconomy(), network = annualFetcher(seed, null);
  await refreshEconomy({ env, fetchImpl: network.fetchImpl, now, seedDocument: seed });
  assert.deepEqual(network.posts[0].economy.countries[0].latestInflation, seed.countries[0].latestInflation);
  assert.equal(network.posts[0].economy.meta.monthlyRefresh.lastNationalSourceCheckAt, null);
  assert.equal(network.posts[0].economy.meta.monthlyRefresh.nationalSourcesChecked, false);
  assert.equal(network.posts[0].economy.meta.monthlyRefresh.sourceSnapshotAsOf, null);
  assert.equal(network.posts[0].economy.meta.monthlyRefresh.lastNationalSourceAttemptAt, now.toISOString());
  assert.equal(network.posts[0].economy.meta.monthlyRefresh.status, 'failed');
  assert.throws(() => countryMetadata({ countries: [] }), /19-country/);
});

test('economy assembly keeps national monthly and Australia quarterly CPI histories separate', () => {
  const seed = fixtureEconomy(); seed.countries[0].iso3 = 'ARG'; seed.countries[1].iso3 = 'AUS';
  const oldArgentinaSource = { publisher: 'Earlier INDEC dataset', dataset: 'Prior base', title: 'Earlier national series', measure: 'Earlier CPI measure', url: 'https://agency.example.com/old-cpi' };
  seed.countries[0].monthlyCpiHistory = [{ period: '2026-06', value: 39, frequency: 'monthly', measure: oldArgentinaSource.measure, source: oldArgentinaSource }];
  seed.countries[0].monthlyCpiHistorySource = oldArgentinaSource;
  const grouped = new Map(seed.countries.map(c => [c.iso3, new Map([[2024, 1], [2025, 2]])]));
  const annual = { grouped, updated: '2026-10-08', url: 'https://api.worldbank.org/v2' };
  const monthly = {
    byCountry: { ARG: [{ period: '2026-08', value: 40, frequency: 'monthly', measure: 'Argentina national CPI, year-on-year', source: { publisher: 'INDEC', url: 'https://apis.datos.gob.ar/series/api/series/' } }] },
    quarterlyByCountry: { AUS: [{ period: '2026-Q3', value: 3.2, frequency: 'quarterly', measure: 'ABS seasonally adjusted CPI, year-on-year', source: { publisher: 'ABS', url: 'https://data.api.abs.gov.au/rest/data/ABS,CPI_Q/' } }] },
    statuses: [{ id: 'argentina', status: 'updated' }, { id: 'australia-quarterly', status: 'updated' }]
  };
  const result = assembleEconomy(seed, seed, { gdpGrowth: annual, inflation: annual }, now, monthly);
  const arg = result.countries.find(c => c.iso3 === 'ARG'), aus = result.countries.find(c => c.iso3 === 'AUS');
  assert.equal(arg.monthlyCpiHistory[0].period, '2026-06');
  assert.equal(arg.monthlyCpiHistory[0].frequency, 'monthly');
  assert.equal(Object.hasOwn(arg.monthlyCpiHistory[0], 'source'), false);
  assert.equal(arg.monthlyCpiHistory[0].sourceId, 0);
  assert.deepEqual(arg.monthlyCpiHistorySources.map(source => source.publisher), ['Earlier INDEC dataset', 'INDEC']);
  assert.equal(arg.latestInflation.source.publisher, 'INDEC');
  assert.equal(arg.quarterlyCpiHistory.length, 0);
  assert.equal(aus.monthlyCpiHistory.length, 0);
  assert.equal(aus.quarterlyCpiHistory[0].frequency, 'quarterly');
  assert.equal(aus.latestInflation.period, '2026-Q3');
  assert.equal(result.meta.monthlyCpiHistoryCountriesCount, 1);
  assert.equal(result.meta.quarterlyCpiHistoryCountriesCount, 1);
  assert.equal(result.meta.monthlyRefresh.nationalSourcesChecked, true);
});

test('World Bank pagination validates source vintage, duplicates and expected country coverage', async () => {
  const indicator = 'NY.GDP.MKTP.KD.ZG';
  const row = year => ({ countryiso3code: 'AAA', indicator: { id: indicator }, date: String(year), value: 1 });
  const fetchImpl = async input => { const page = Number(new URL(input).searchParams.get('page') || 1); return Response.json([{ page, pages: 2, lastupdated: '2026-10-08' }, [row(page === 1 ? 2024 : 2025)]]); };
  const result = await worldBankIndicator(['AAA'], indicator, { fetchImpl, now });
  assert.deepEqual([...result.grouped.get('AAA').keys()], [2024, 2025]);
  await assert.rejects(worldBankIndicator(['AAA'], indicator, { now, fetchImpl: async () => Response.json([{ page: 1, pages: 1, lastupdated: '2099-01-01' }, [row(2025)]]) }), /vintage/);
  await assert.rejects(worldBankIndicator(['AAA'], indicator, { now, fetchImpl: async () => Response.json([{ page: 1, pages: 1, lastupdated: '2026-10-08' }, [row(2025), row(2025)]]) }), /duplicate/);
});
