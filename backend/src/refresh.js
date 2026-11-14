import { FEEDS, enabledFeeds } from './feeds.js';
import { MAX_FEED_BYTES, readLimited, sha256 } from './feed.js';
import { readSource, fetchSource } from './discovery.js';
import { cleanupContent, storeArticles } from './content.js';

const DAY = 86400000;
const TOPICS = Object.freeze({ WORLD: 'World', BUSINESS:'Economy', HEALTH: 'Health' });
export const DEFAULT_PERMITTED_FEEDS = Object.freeze(FEEDS.filter(f => f.enabledByDefault && !f.blocked).map(f => f.id));
export const DEFAULT_PERMITTED = DEFAULT_PERMITTED_FEEDS;
class RefreshError extends Error { constructor(code) { super(code); this.code = code; } }
const integer = (value, fallback, min, max) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const errorCode = (error, fallback) => error instanceof RefreshError ? error.code : fallback;
const instant = value => { const at = value instanceof Date ? new Date(value) : new Date(value ?? Date.now()); if (!Number.isFinite(at.getTime())) throw new RefreshError('invalid_refresh_clock'); return at; };
const getState = (env, key) => env.DB.prepare('SELECT value FROM app_state WHERE key=?').bind(key).first();
const setState = (env, key, value) => env.DB.prepare('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, String(value));

/** The registry owns hosts and reuse restrictions. Callers cannot supply URLs. */
export function runtimeNewsFeeds(env = {}) {
  const feeds = [], warnings = [], selected = enabledFeeds(env);
  for (const feed of selected) {
    if (feed.id !== 'google-world') { feeds.push(feed); continue; }
    if (env.GOOGLE_NEWS_ENABLED !== 'true' && env.GOOGLE_NEWS_RIGHTS_ACK !== 'true') {
      warnings.push('Google headline discovery is not enabled.');
      continue;
    }
    const topics = [...new Set(String(env.GOOGLE_NEWS_TOPICS || 'WORLD').split(',').map(x => x.trim().toUpperCase()).filter(Boolean))];
    if (topics.some(topic => !Object.hasOwn(TOPICS, topic))) warnings.push('Unknown Google topic identifiers were ignored.');
    for (const topic of topics.filter(topic => Object.hasOwn(TOPICS, topic))) {
      const base = new URL(feed.url), url = new URL('/rss/headlines/section/topic/' + topic, base);
      url.search = base.search;
      feeds.push({ ...feed, id: 'google-' + topic.toLowerCase(), url: url.href, category: TOPICS[topic] });
    }
  }
  if (typeof env.ENABLED_FEEDS === 'string') {
    const ids = env.ENABLED_FEEDS.split(',').map(x => x.trim()).filter(Boolean);
    if (ids.some(id => !FEEDS.some(f => f.id === id && !f.blocked))) warnings.push('Unknown or blocked publishers were ignored.');
  }
  return { feeds, warnings };
}
async function acquire(env, key, now, duration) {
  const token = String(now.getTime() + duration) + '|' + crypto.randomUUID();
  const row = await env.DB.prepare(`INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(app_state.value AS INTEGER)<=? RETURNING value`).bind(key, token, now.getTime()).first();
  return row?.value === token ? token : null;
}
async function requireLease(env, key, token) {
  if ((await getState(env, key))?.value !== token) throw new RefreshError('refresh_lease_lost');
}
async function release(env, key, token) {
  // A timed-out invocation must never clear a replacement owner's lease.
  await env.DB.prepare('DELETE FROM app_state WHERE key=? AND value=?').bind(key, token).run();
}
function header(value) { return value && value.length <= 512 && !/[\r\n\0]/.test(value) ? value : null; }
async function dailyCleanup(env, now) {
  const prior = parse((await getState(env, 'content_cleanup'))?.value);
  if (prior?.cleanedAt && Date.parse(prior.cleanedAt) >= now.getTime() - DAY) return { ok: true, skipped: 'not_due' };
  return cleanupContent(env, { now });
}
async function feedFailure(env, id, at, reason) {
  // Preserve previous success time, validators and successful item count.
  await env.DB.prepare(`INSERT INTO feed_state (id,last_attempt_at,error) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,error=excluded.error WHERE feed_state.last_attempt_at IS NULL OR feed_state.last_attempt_at<=excluded.last_attempt_at`).bind(id, at, reason).run();
}

/** One registered feed per invocation bounds XML parsing, writes and subrequests.
 * force skips the refresh interval, but never skips the shared D1 lease. */
export async function refreshNews(env, { force = false, fetchImpl = fetch, now } = {}) {
  if (!env.DB) return { ok: false, reason: 'database_not_configured', feedCount: 0, cycleLength: 0 };
  let at; try { at = instant(now); } catch { return { ok: false, reason: 'invalid_refresh_clock' }; }
  const { feeds, warnings } = runtimeNewsFeeds(env);
  if (!feeds.length) return { ok: false, reason: 'no_enabled_feeds', warnings, feedCount: 0, cycleLength: 0 };
  const interval = integer(env.FEED_REFRESH_SECONDS, 900, 60, 86400) * 1000;
  const lockKey = 'refresh_news_lock', attemptKey = 'refresh_news_attempt_ms';
  let token, feed, result, stage = 'refresh_store';
  try {
    const previous = await getState(env, attemptKey);
    if (!force && Number(previous?.value) > at.getTime() - interval) return { ok: true, skipped: 'not_due', feedCount: feeds.length, cycleLength: feeds.length };
    token = await acquire(env, lockKey, at, 90000);
    if (!token) return { ok: true, skipped: 'another_refresh_running', feedCount: feeds.length, cycleLength: feeds.length };
    // Recheck after acquiring: another invocation may have committed between the
    // initial interval read and this lease acquisition.
    const latest = await getState(env, attemptKey);
    if (!force && Number(latest?.value) > at.getTime() - interval) { result = { ok: true, skipped: 'not_due' }; }
    else {
      const cursor = await getState(env, 'refresh_news_cursor');
      const index = integer(cursor?.value, 0, 0, Number.MAX_SAFE_INTEGER) % feeds.length;
      feed = feeds[index];
      // Advance even after a source failure, so one failing publisher cannot
      // permanently starve the rest of the registry.
      await env.DB.batch([setState(env, attemptKey, at.getTime()), setState(env, 'refresh_news_cursor', (index + 1) % feeds.length)]);
      const before = await env.DB.prepare('SELECT etag,modified,last_success_at,item_count FROM feed_state WHERE id=?').bind(feed.id).first();
      await env.DB.prepare(`INSERT INTO feed_state (id,last_attempt_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`).bind(feed.id, at.toISOString()).run();
      const headers = { accept: feed.format==='gdelt'?'application/json':'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9', 'user-agent': 'ThreadNews/0.3 (attributed headline/link metadata)' };
      if (header(before?.etag)) headers['if-none-match'] = before.etag;
      if (header(before?.modified)) headers['if-modified-since'] = before.modified;
      stage = 'feed_fetch';
      const response = await fetchSource(feed, { fetchImpl, headers, signal: AbortSignal.timeout(20000) });
      await requireLease(env, lockKey, token);
      if (response.status === 304) {
        if (!before?.last_success_at || (!headers['if-none-match'] && !headers['if-modified-since'])) throw new RefreshError('unexpected_not_modified_response');
        await env.DB.prepare('UPDATE feed_state SET last_attempt_at=?,last_success_at=?,error=NULL WHERE id=?').bind(at.toISOString(), at.toISOString(), feed.id).run();
        result = { ok: true, feed: feed.id, notModified: true, items: 0, checkedAt: at.toISOString() };
      } else {
        if (!response.ok) throw new RefreshError('feed_http_' + response.status);
        stage = 'feed_parse';
        const maxBytes = integer(env.FEED_MAX_BYTES, MAX_FEED_BYTES, 16384, MAX_FEED_BYTES);
        const maxItems = integer(env.FEED_MAX_ITEMS, 50, 1, 50);
        const articles = await readSource(response, feed, at, maxBytes, maxItems);
        await requireLease(env, lockKey, token);
        stage = 'feed_store';
        const stored = await storeArticles(env, articles, feed.id, 'automatic', { now: at });
        await env.DB.prepare(`INSERT INTO feed_state (id,last_attempt_at,last_success_at,etag,modified,error,item_count) VALUES (?,?,?,?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,etag=excluded.etag,modified=excluded.modified,error=NULL,item_count=excluded.item_count`).bind(feed.id, at.toISOString(), at.toISOString(), header(response.headers.get('etag')), header(response.headers.get('last-modified')), articles.length).run();
        result = { ok: true, feed: feed.id, items: stored.accepted, rejectedByCategory: stored.rejectedByCategory, checkedAt: at.toISOString(), evidence: 'headline/link metadata; full articles were not copied or independently summarised' };
      }
    }
  } catch (error) {
    const reason = errorCode(error, stage + '_failed');
    if (feed && reason !== 'refresh_lease_lost') { try { await feedFailure(env, feed.id, at.toISOString(), reason); } catch {} }
    result = { ok: false, feed: feed?.id || null, reason };
  } finally {
    if (token) {
      try {
        await requireLease(env, lockKey, token);
        if (result && !result.skipped) { try { result.cleanup = await dailyCleanup(env, at); } catch { result.cleanup = { ok: false, reason: 'cleanup_failed' }; } }
      } catch { /* A lost lease does not authorize more writes. */ }
      try { await release(env, lockKey, token); } catch { /* Lease expires automatically. */ }
    }
  }
  return { ...result, feedCount: feeds.length, cycleLength: feeds.length, ...(warnings.length ? { warnings } : {}) };
}

const INDICATORS = Object.freeze({ gdpGrowth: { id: 'NY.GDP.MKTP.KD.ZG', title: 'GDP growth (annual %)' }, inflation: { id: 'FP.CPI.TOTL.ZG', title: 'Inflation, consumer prices (annual %)' } });
function annualURL(codes, indicator, year, page = 1) {
  const url = new URL('https://api.worldbank.org/v2/country/' + codes.join(';') + '/indicator/' + indicator);
  url.searchParams.set('date', '2015:' + year); url.searchParams.set('format', 'json'); url.searchParams.set('per_page', '1000');
  if (page > 1) url.searchParams.set('page', String(page));
  return url.href;
}
async function annualSeries(codes, indicator, fetchImpl, at) {
  const grouped = new Map(codes.map(code => [code, new Map()])), expected = new Set(codes), year = at.getUTCFullYear();
  let pages = 1, updated = null, declaredTotal = null, count = 0;
  for (let page = 1; page <= pages; page++) {
    const response = await fetchImpl(annualURL(codes, indicator, year, page), { redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new RefreshError('world_bank_http_' + response.status);
    const payload = parse(await readLimited(response, 2 * 1024 * 1024));
    if (!Array.isArray(payload) || !payload[0] || !Array.isArray(payload[1])) throw new RefreshError('invalid_world_bank_response');
    const meta = payload[0];
    if (!Number.isInteger(Number(meta.pages)) || Number(meta.pages) < 1 || Number(meta.pages) > 3 || Number(meta.page) !== page) throw new RefreshError('invalid_world_bank_pagination');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.lastupdated || '') || !Number.isFinite(Date.parse(meta.lastupdated)) || new Date(meta.lastupdated).toISOString().slice(0, 10) !== meta.lastupdated || meta.lastupdated > at.toISOString().slice(0, 10)) throw new RefreshError('invalid_world_bank_vintage');
    if (updated && updated !== meta.lastupdated) throw new RefreshError('world_bank_vintage_changed');
    if (!Number.isInteger(Number(meta.total)) || Number(meta.total) < 1 || Number(meta.total) > 3000 || (declaredTotal !== null && declaredTotal !== Number(meta.total))) throw new RefreshError('invalid_world_bank_total');
    updated = meta.lastupdated; pages = Number(meta.pages); declaredTotal = Number(meta.total);
    for (const row of payload[1]) {
      if (!expected.has(row.countryiso3code) || row.indicator?.id !== indicator || !/^\d{4}$/.test(row.date || '') || Number(row.date) < 2015 || Number(row.date) > year || (row.value !== null && (typeof row.value !== 'number' || !Number.isFinite(row.value)))) throw new RefreshError('invalid_world_bank_observation');
      const map = grouped.get(row.countryiso3code), observationYear = Number(row.date);
      if (map.has(observationYear)) throw new RefreshError('duplicate_world_bank_observation');
      map.set(observationYear, row.value); count++;
    }
  }
  if (count !== declaredTotal || [...grouped.values()].some(map => !map.size)) throw new RefreshError('incomplete_world_bank_coverage');
  return { grouped, updated, url: annualURL(codes, indicator, year) };
}
function assembleAnnual(previous, annual, at) {
  const year = at.getUTCFullYear(), years = Array.from({ length: year - 2015 + 1 }, (_, i) => 2015 + i), stamp = at.toISOString();
  const countries = previous.countries.map(country => {
    const result = { ...country };
    for (const [key, indicator] of Object.entries(INDICATORS)) {
      result[key] = years.map(year => ({ year, value: annual[key].grouped.get(country.iso3).get(year) ?? null }));
      result[key === 'gdpGrowth' ? 'latestAnnualGdpGrowth' : 'latestAnnualInflation'] = [...result[key]].reverse().find(row => row.value !== null) || null;
      result[key + 'Source'] = { ...(country[key + 'Source'] || {}), publisher: 'World Bank', dataset: 'World Development Indicators', indicator: indicator.id, title: indicator.title, url: annualURL([country.iso3], indicator.id, year), updated: annual[key].updated, unit: 'annual percent change' };
    }
    // Country-specific monthly fields and any stored monthly vintages remain
    // byte-for-byte equivalent in value; only the explanatory note changes.
    result.latestInflationNote = 'National monthly CPI is retained with its original reference period, release date and sources; this annual refresh did not re-verify national releases.';
    const gaps = Object.keys(INDICATORS).flatMap(key => { const missing = result[key].filter(row => row.value === null).map(row => row.year); return missing.length ? [(key === 'gdpGrowth' ? 'Annual GDP growth' : 'Annual CPI inflation') + ' unavailable for ' + missing.join(', ') + '.'] : []; });
    result.note = gaps.length ? gaps.join(' ') + ' Missing observations are not zero or forecasts.' : 'Reported annual statistics may be revised by their sources.';
    return result;
  });
  const oldMeta = previous.meta || {}, updated = Object.values(annual).map(value => value.updated).sort().at(-1), latestYear = Math.max(...countries.flatMap(c => [...c.gdpGrowth, ...c.inflation].filter(row => row.value !== null).map(row => row.year)));
  const sources = { ...(oldMeta.sources || {}), gdpGrowth: annual.gdpGrowth.url, inflation: annual.inflation.url };
  return { ...previous, countries, meta: { ...oldMeta, retrievedAt: stamp, generatedAt: stamp, asOfDate: stamp.slice(0, 10), asOf: stamp.slice(0, 10), years, countriesCount: countries.length,
    sourceUpdated: updated, sourceUpdatedAt: updated, sourceUpdatedByIndicator: { gdpGrowth: annual.gdpGrowth.updated, inflation: annual.inflation.updated }, sources, sourceLinks: { ...(oldMeta.sourceLinks || {}), ...sources },
    window: { ...(oldMeta.window || {}), startYear: 2015, requestedEndYear: year, latestReportedAnnualYear: Number.isFinite(latestYear) ? latestYear : null },
    monthlyCpiCountriesCount: countries.filter(c => Number.isFinite(c.latestInflation?.value)).length,
    annualRefresh: { status: 'updated', lastSuccessAt: stamp, source: 'World Bank World Development Indicators' },
    monthlyRefresh: { ...(oldMeta.monthlyRefresh || {}), status: oldMeta.monthlyRefresh?.status || 'requires-national-source-refresh', nationalSourcesChecked: oldMeta.monthlyRefresh?.nationalSourcesChecked ?? false, lastNationalSourceCheckAt: oldMeta.monthlyRefresh?.lastNationalSourceCheckAt || null, sourceSnapshotAsOf: oldMeta.monthlyRefresh?.sourceSnapshotAsOf || oldMeta.asOfDate || oldMeta.asOf || null, annualPipelineCheckedAt: stamp, note: 'Only annual series were refreshed. National monthly CPI and its source vintages were retained, not re-verified. OECD G20 HICP measures are not substituted for national CPI.' },
    notes: [...new Set([...(oldMeta.notes || []).filter(note => !/^No\s*\d{4}\s*annual GDP or annual CPI/i.test(note)), 'Annual series are refreshed from official World Bank records. National monthly CPI retains a separate source vintage and is not refreshed by this annual task.'])] } };
}

/** Workers-only annual refresh: country metadata comes from the imported D1
 * document. No Node APIs, static seed values or hardcoded country data are used. */
export async function refreshEconomy(env, { force = false, fetchImpl = fetch, now } = {}) {
  if (!env.DB) return { ok: false, reason: 'database_not_configured' };
  let at; try { at = instant(now); } catch { return { ok: false, reason: 'invalid_refresh_clock' }; }
  const interval = integer(env.ECONOMY_REFRESH_SECONDS, 7 * 86400, 3600, 30 * 86400) * 1000, key = 'refresh_economy_lock';
  let token, result;
  try {
    const success = await getState(env, 'refresh_economy_success_ms');
    if (!force && Number(success?.value) > at.getTime() - interval) return { ok: true, skipped: 'not_due' };
    const attempt = await getState(env, 'refresh_economy_attempt_ms');
    if (!force && Number(attempt?.value) > at.getTime() - 3600000) return { ok: true, skipped: 'retry_not_due' };
    token = await acquire(env, key, at, 5 * 60000);
    if (!token) return { ok: true, skipped: 'another_refresh_running' };
    const latestSuccess = await getState(env, 'refresh_economy_success_ms');
    if (!force && Number(latestSuccess?.value) > at.getTime() - interval) return { ok: true, skipped: 'not_due' };
    const latestAttempt = await getState(env, 'refresh_economy_attempt_ms');
    if (!force && Number(latestAttempt?.value) > at.getTime() - 3600000) return { ok: true, skipped: 'retry_not_due' };
    await setState(env, 'refresh_economy_attempt_ms', at.getTime()).run();
    const row = await env.DB.prepare("SELECT payload_json,content_hash FROM content_documents WHERE id='economy'").first();
    if (!row) throw new RefreshError('economy_not_imported');
    if (new TextEncoder().encode(row.payload_json).length > 1024 * 1024) throw new RefreshError('economy_document_too_large');
    const previous = parse(row.payload_json), countries = previous?.countries;
    if (!Array.isArray(countries) || countries.length !== 19 || countries.some(c => !/^[A-Z]{3}$/.test(c.iso3 || '')) || new Set(countries.map(c => c.iso3)).size !== 19) throw new RefreshError('invalid_economy_country_metadata');
    const codes = countries.map(c => c.iso3);
    const results = await Promise.all(Object.entries(INDICATORS).map(async ([key, indicator]) => [key, await annualSeries(codes, indicator.id, fetchImpl, at)]));
    const document = assembleAnnual(previous, Object.fromEntries(results), at);
    await requireLease(env, key, token);
    // Do not overwrite a newer monthly document imported while upstream data
    // was being fetched. A later invocation can safely retry the annual refresh.
    const payload = JSON.stringify(document);
    if (new TextEncoder().encode(payload).length > 1024 * 1024) throw new RefreshError('economy_document_too_large');
    const hash = await sha256(payload);
    // The existing document has already passed import validation; new values
    // above are bounded numeric observations from fixed official API endpoints.
    // A compare-and-swap prevents losing a concurrently imported monthly update.
    const written = await env.DB.prepare("UPDATE content_documents SET updated_at=?,payload_json=?,content_hash=? WHERE id='economy' AND content_hash=? RETURNING id").bind(at.toISOString(), payload, hash, row.content_hash).first();
    if (!written) throw new RefreshError('economy_document_changed_during_refresh');
    result = { ok: true, countries: countries.length, annualThroughYear: document.meta.window.latestReportedAnnualYear, sourceUpdated: document.meta.sourceUpdated, refreshedAt: at.toISOString(), monthlyStatus: 'requires-national-source-refresh' };
    await env.DB.batch([setState(env, 'refresh_economy_success_ms', at.getTime()), setState(env, 'economy_refresh_status', JSON.stringify({ ...result, lastAttemptAt: at.toISOString(), lastSuccessAt: at.toISOString() }))]);
  } catch (error) {
    result = { ok: false, reason: errorCode(error, 'economy_refresh_failed') };
    if (token && result.reason !== 'refresh_lease_lost') {
      try {
        const previous = parse((await getState(env, 'economy_refresh_status'))?.value) || {};
        await setState(env, 'economy_refresh_status', JSON.stringify({ ...previous, ...result, lastAttemptAt: at.toISOString() })).run();
      } catch {}
    }
  } finally {
    if (token) { try { await release(env, key, token); } catch {} }
  }
  return result;
}
