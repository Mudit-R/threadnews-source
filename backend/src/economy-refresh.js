import { fetchAustraliaQuarterlyCpi, fetchArgentinaMonthlyCpi, fetchBrazilMonthlyCpi, fetchCanadaMonthlyCpi, fetchEurostatHicp, fetchUsMonthlyCpi, fetchUkMonthlyCpi, fetchWorldBankGemMonthlyCpi } from '../scripts/monthly-inflation.js';
import { compactHistory, latestByPeriod } from './economy-history.js';
import { sha256 } from './feed.js';

const HOUR = 3600000;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_DOCUMENT_NODES = 30000;
const DIRECT_NATIONAL_IDS = new Set(['usa', 'canada', 'brazil', 'uk', 'argentina', 'australia-quarterly']);
const GEM_GROUPS = Object.freeze([
  Object.freeze(['CHN', 'IND', 'IDN', 'JPN']),
  Object.freeze(['MEX', 'KOR', 'RUS']),
  Object.freeze(['SAU', 'ZAF', 'TUR'])
]);

function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function parse(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
function safeCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[a-z0-9_-]{1,80}$/.test(code) ? code : 'source_unavailable';
}
function instant(value) {
  const at = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (!Number.isFinite(at.getTime())) throw new Error('invalid_refresh_clock');
  return at;
}
function state(env, key) { return env.DB.prepare('SELECT value FROM app_state WHERE key=?').bind(key).first(); }
function setState(env, key, value) {
  return env.DB.prepare('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, String(value)).run();
}
async function acquire(env, key, at, duration) {
  const token = String(at.getTime() + duration) + '|' + crypto.randomUUID();
  const row = await env.DB.prepare(`INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(app_state.value AS INTEGER)<=? RETURNING value`).bind(key, token, at.getTime()).first();
  return row?.value === token ? token : null;
}
async function release(env, key, token) {
  await env.DB.prepare('DELETE FROM app_state WHERE key=? AND value=?').bind(key, token).run();
}
async function hasLease(env, key, token) {
  return (await state(env, key))?.value === token;
}

async function sourceResult(countries, fetcher, { fetchImpl, now, frequency = 'monthly', national = false } = {}) {
  const result = await fetcher({ fetchImpl, now });
  const sourceHistories = Array.isArray(result)
    ? Object.fromEntries(countries.map(code => [code, result]))
    : result?.byCountry || { [countries[0]]: result?.history || [] };
  const byCountry = {}, quarterlyByCountry = {}, coveredCountries = [];
  for (const code of countries) {
    const history = sourceHistories[code];
    if (!Array.isArray(history) || history.length === 0) continue;
    (frequency === 'quarterly' ? quarterlyByCountry : byCountry)[code] = history;
    coveredCountries.push(code);
  }
  if (coveredCountries.length !== countries.length) throw Object.assign(new Error('incomplete_source_coverage'), { code: 'incomplete_source_coverage' });
  return { byCountry, quarterlyByCountry, coveredCountries, observations: coveredCountries.reduce((sum, code) => sum + (byCountry[code] || quarterlyByCountry[code]).length, 0), frequency, national, sourceUpdated: result?.sourceUpdated || null };
}

/** Ten source groups rotate every two hours. Registry URLs are fixed in the
 * collectors; request data cannot supply a URL or a country list. */
export const ECONOMY_SOURCE_ADAPTERS = Object.freeze([
  Object.freeze({ id: 'usa', countries: Object.freeze(['USA']), frequency: 'monthly', national: true, fetch: options => sourceResult(['USA'], fetchUsMonthlyCpi, options) }),
  Object.freeze({ id: 'canada', countries: Object.freeze(['CAN']), frequency: 'monthly', national: true, fetch: async options => {
    try { return await sourceResult(['CAN'], fetchCanadaMonthlyCpi, options); }
    catch (directError) {
      try {
        const fallback = await fetchWorldBankGemMonthlyCpi({ ...options, countries: ['CAN'] });
        const data = await sourceResult(['CAN'], async () => fallback, options);
        return { ...data, national: false, fallback: true };
      } catch { throw directError; }
    }
  } }),
  Object.freeze({ id: 'brazil', countries: Object.freeze(['BRA']), frequency: 'monthly', national: true, fetch: options => sourceResult(['BRA'], fetchBrazilMonthlyCpi, options) }),
  Object.freeze({ id: 'uk', countries: Object.freeze(['GBR']), frequency: 'monthly', national: true, fetch: options => sourceResult(['GBR'], fetchUkMonthlyCpi, options) }),
  Object.freeze({ id: 'argentina', countries: Object.freeze(['ARG']), frequency: 'monthly', national: true, fetch: options => sourceResult(['ARG'], fetchArgentinaMonthlyCpi, options) }),
  Object.freeze({ id: 'australia-quarterly', countries: Object.freeze(['AUS']), frequency: 'quarterly', national: true, fetch: options => sourceResult(['AUS'], fetchAustraliaQuarterlyCpi, { ...options, frequency: 'quarterly' }) }),
  ...GEM_GROUPS.map((countries, index) => Object.freeze({
    id: 'world-bank-gem-' + (index + 1), countries, frequency: 'monthly', national: false,
    fetch: options => sourceResult(countries, input => fetchWorldBankGemMonthlyCpi({ ...input, countries }), options)
  })),
  Object.freeze({ id: 'eurostat-hicp', countries: Object.freeze(['DEU', 'FRA', 'ITA']), frequency: 'monthly', national: false, fetch: async options => {
    const [de, fr, it] = await Promise.all(['DE', 'FR', 'IT'].map(geo => fetchEurostatHicp(geo, options)));
    return { byCountry: { DEU: de, FRA: fr, ITA: it }, quarterlyByCountry: {}, coveredCountries: ['DEU', 'FRA', 'ITA'], observations: de.length + fr.length + it.length, frequency: 'monthly', national: false };
  } })
]);

function checkDocument(value) {
  const encoded = JSON.stringify(value);
  const bytes = new TextEncoder().encode(encoded).length;
  if (bytes > MAX_DOCUMENT_BYTES) throw new Error('economy_document_too_large');
  let nodes = 0;
  const walk = (item, depth = 0) => {
    if (++nodes > MAX_DOCUMENT_NODES || depth > 18) throw new Error('economy_document_structure_limit');
    if (Array.isArray(item)) {
      if (item.length > 2000) throw new Error('economy_document_array_limit');
      for (const child of item) walk(child, depth + 1);
    } else if (object(item)) {
      if (Object.keys(item).length > 120) throw new Error('economy_document_object_limit');
      for (const child of Object.values(item)) walk(child, depth + 1);
    } else if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('economy_document_invalid_number');
    else if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new Error('economy_document_invalid_value');
  };
  walk(value);
  return { encoded, nodes, bytes };
}

async function progressSnapshot(env, adapter, at, outcome, error = null) {
  const prior = parse((await state(env, 'economy_source_refresh_status'))?.value, {});
  const statuses = object(prior?.sources) ? { ...prior.sources } : {};
  const old = statuses[adapter.id] || {};
  statuses[adapter.id] = outcome ? {
    id: adapter.id, countries: [...adapter.countries], frequency: adapter.frequency,
    status: outcome.coveredCountries.length === adapter.countries.length ? (outcome.fallback ? 'updated_fallback' : 'updated') : 'partial',
    coveredCountries: outcome.coveredCountries, observations: outcome.observations,
    latestPeriod: Object.values(outcome.byCountry).concat(Object.values(outcome.quarterlyByCountry)).flat().map(point => point.period).sort().at(-1) || null,
    lastAttemptAt: at.toISOString(), lastSuccessAt: at.toISOString(),
    ...(outcome.fallback ? { fallback: 'World Bank GEM after Statistics Canada unavailable' } : {})
  } : {
    id: adapter.id, countries: [...adapter.countries], frequency: adapter.frequency,
    status: 'failed', reason: safeCode(error), lastAttemptAt: at.toISOString(), lastSuccessAt: old.lastSuccessAt || null,
    ...(old.coveredCountries ? { coveredCountries: old.coveredCountries } : {})
  };
  const value = { sources: statuses, cursor: (Number((await state(env, 'economy_source_refresh_cursor'))?.value) || 0) % ECONOMY_SOURCE_ADAPTERS.length, lastAttemptAt: at.toISOString(), lastSource: adapter.id, lastResult: outcome ? statuses[adapter.id].status : 'failed' };
  return value;
}

async function persistProgress(env, adapter, at, outcome, error = null) {
  const value = await progressSnapshot(env, adapter, at, outcome, error);
  await setState(env, 'economy_source_refresh_status', JSON.stringify(value));
  return value;
}

function updateCountry(country, monthlyRows, quarterlyRows) {
  const monthly = compactHistory(country.monthlyCpiHistory || [], monthlyRows || [], country.monthlyCpiHistorySource || null, country.monthlyCpiHistorySources || [], 'monthly');
  const quarterly = compactHistory(country.quarterlyCpiHistory || [], quarterlyRows || [], country.quarterlyCpiHistorySource || null, country.quarterlyCpiHistorySources || [], 'quarterly');
  const next = { ...country, monthlyCpiHistory: monthly.history, monthlyCpiHistorySource: monthly.source, quarterlyCpiHistory: quarterly.history, quarterlyCpiHistorySource: quarterly.source };
  if (monthly.sources) next.monthlyCpiHistorySources = monthly.sources; else delete next.monthlyCpiHistorySources;
  if (quarterly.sources) next.quarterlyCpiHistorySources = quarterly.sources; else delete next.quarterlyCpiHistorySources;
  const monthLatest = monthly.history.at(-1), quarterLatest = quarterly.history.at(-1);
  const sourceFor = (point, series) => point?.sourceId != null ? series.sources?.[point.sourceId] : series.source;
  const mSource = sourceFor(monthLatest, monthly), qSource = sourceFor(quarterLatest, quarterly);
  next.latestInflation = latestByPeriod(country.latestInflation, monthLatest && { ...monthLatest, source: mSource, measure: mSource?.measure, provisional: false }, quarterLatest && { ...quarterLatest, source: qSource, measure: qSource?.measure });
  next.latestInflationNote = monthly.history.length || quarterly.history.length
    ? `${monthly.history.length ? `${monthly.history.length} monthly` : ''}${monthly.history.length && quarterly.history.length ? ' and ' : ''}${quarterly.history.length ? `${quarterly.history.length} quarterly` : ''} year-on-year observations are shown with each source and definition. They remain separate from annual CPI.`
    : country.latestInflationNote || 'No CPI history was returned by the selected source; no observations were removed.';
  return next;
}

function refreshMetadata(previous, progress, adapter, outcome, at) {
  const old = previous.meta?.monthlyRefresh || {};
  const sourceStatuses = ECONOMY_SOURCE_ADAPTERS.map(item => progress.sources?.[item.id]).filter(Boolean);
  const successful = sourceStatuses.filter(item => item.status === 'updated' || item.status === 'updated_fallback' || item.status === 'partial').length;
  const failed = sourceStatuses.some(item => item.status === 'failed');
  const directSuccess = Boolean(adapter.national && !outcome.fallback);
  const attemptIsDirect = DIRECT_NATIONAL_IDS.has(adapter.id);
  const checkedAt = outcome ? at.toISOString() : old.lastSourceCheckAt || null;
  return {
    ...old,
    status: failed ? (successful ? 'partial' : 'failed') : sourceStatuses.length === ECONOMY_SOURCE_ADAPTERS.length ? 'updated' : 'partial',
    nationalSourcesChecked: directSuccess || old.nationalSourcesChecked === true,
    lastNationalSourceCheckAt: directSuccess ? at.toISOString() : old.lastNationalSourceCheckAt || null,
    lastNationalSourceAttemptAt: attemptIsDirect ? at.toISOString() : old.lastNationalSourceAttemptAt || null,
    lastSourceAttemptAt: at.toISOString(),
    lastSourceCheckAt: checkedAt,
    sourceSnapshotAsOf: outcome ? at.toISOString().slice(0, 10) : old.sourceSnapshotAsOf || null,
    sources: sourceStatuses,
    note: 'Monthly CPI histories refresh in a rotating schedule. Direct national series are preferred where available; World Bank GEM index-derived values and Eurostat HICP are identified separately. Australia is quarterly. Failed refreshes preserve the last successful observations.'
  };
}

/** Refresh one official CPI source group per invocation. A D1 lease prevents
 * duplicate scheduled calls, a persisted cursor rotates the registry, and a
 * content hash plus updated_at compare-and-swap protects newer imports. */
export async function refreshEconomicSource(env, { force = false, fetchImpl = fetch, now, adapters = ECONOMY_SOURCE_ADAPTERS } = {}) {
  if (!env?.DB) return { ok: false, reason: 'database_not_configured' };
  let at;
  try { at = instant(now); } catch { return { ok: false, reason: 'invalid_refresh_clock' }; }
  if (!Array.isArray(adapters) || !adapters.length || adapters.length > 20) return { ok: false, reason: 'invalid_source_registry' };
  const interval = Number.isInteger(Number(env.ECONOMY_SOURCE_REFRESH_SECONDS)) && Number(env.ECONOMY_SOURCE_REFRESH_SECONDS) >= 3600 && Number(env.ECONOMY_SOURCE_REFRESH_SECONDS) <= 86400 ? Number(env.ECONOMY_SOURCE_REFRESH_SECONDS) * 1000 : 2 * HOUR;
  const lockKey = 'economy_source_refresh_lock';
  let token = null, result = { ok: false, reason: 'source_refresh_failed' }, adapter;
  try {
    const lastAttempt = await state(env, 'economy_source_refresh_attempt_ms');
    if (!force && Number(lastAttempt?.value) > at.getTime() - interval) return { ok: true, skipped: 'not_due' };
    token = await acquire(env, lockKey, at, 10 * 60000);
    if (!token) return { ok: true, skipped: 'another_refresh_running' };
    const latestAttempt = await state(env, 'economy_source_refresh_attempt_ms');
    if (!force && Number(latestAttempt?.value) > at.getTime() - interval) return { ok: true, skipped: 'not_due' };
    const cursor = Number((await state(env, 'economy_source_refresh_cursor'))?.value) || 0;
    const index = ((cursor % adapters.length) + adapters.length) % adapters.length;
    adapter = adapters[index];
    await env.DB.batch([
      env.DB.prepare('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('economy_source_refresh_attempt_ms', String(at.getTime())),
      env.DB.prepare('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('economy_source_refresh_cursor', String((index + 1) % adapters.length))
    ]);
    // Capture the content version before any upstream wait. The final write
    // compares against this snapshot so an annual/manual import during fetch
    // cannot be overwritten with a stale merge.
    const row = await env.DB.prepare("SELECT payload_json,content_hash,updated_at FROM content_documents WHERE id='economy'").first();
    if (!row) throw new Error('economy_not_imported');
    if (new TextEncoder().encode(row.payload_json).length > MAX_DOCUMENT_BYTES) throw new Error('economy_document_too_large');
    const previous = parse(row.payload_json);
    const countries = previous?.countries;
    if (!Array.isArray(countries) || countries.length !== 19 || countries.some(country => !/^[A-Z]{3}$/.test(country.iso3 || '')) || new Set(countries.map(country => country.iso3)).size !== 19) throw new Error('invalid_economy_country_metadata');
    let outcome;
    try { outcome = await adapter.fetch({ fetchImpl, now: at }); }
    catch (error) {
      await persistProgress(env, adapter, at, null, error);
      result = { ok: false, source: adapter.id, cursor: (index + 1) % adapters.length, totalSources: adapters.length, reason: safeCode(error) };
      return result;
    }
    if (!Array.isArray(outcome?.coveredCountries) || adapter.countries.some(code => !outcome.coveredCountries.includes(code))) throw new Error('incomplete_source_coverage');
    const monthlyUpdates = outcome.byCountry || {}, quarterlyUpdates = outcome.quarterlyByCountry || {};
    const next = {
      ...previous,
      countries: countries.map(country => monthlyUpdates[country.iso3] || quarterlyUpdates[country.iso3]
        ? updateCountry(country, monthlyUpdates[country.iso3], quarterlyUpdates[country.iso3])
        : country),
      meta: { ...(previous.meta || {}), retrievedAt: at.toISOString(), generatedAt: at.toISOString(), asOfDate: at.toISOString().slice(0, 10), asOf: at.toISOString().slice(0, 10) }
    };
    const progress = await progressSnapshot(env, adapter, at, outcome);
    next.meta.monthlyCpiHistoryCountriesCount = next.countries.filter(country => country.monthlyCpiHistory?.length).length;
    next.meta.quarterlyCpiHistoryCountriesCount = next.countries.filter(country => country.quarterlyCpiHistory?.length).length;
    next.meta.monthlyRefresh = refreshMetadata(previous, progress, adapter, outcome, at);
    const { encoded } = checkDocument(next);
    if (!await hasLease(env, lockKey, token)) throw new Error('economy_source_refresh_lease_lost');
    const hash = await sha256(encoded);
    const write = await env.DB.prepare("UPDATE content_documents SET updated_at=?,payload_json=?,content_hash=? WHERE id='economy' AND content_hash=? AND updated_at=? RETURNING id")
      .bind(at.toISOString(), encoded, hash, row.content_hash, row.updated_at).first();
    if (!write) {
      await persistProgress(env, adapter, at, null, Object.assign(new Error('economy_document_changed_during_refresh'), { code: 'economy_document_changed_during_refresh' }));
      result = { ok: false, source: adapter.id, cursor: (index + 1) % adapters.length, totalSources: adapters.length, reason: 'economy_document_changed_during_refresh' };
      return result;
    }
    await persistProgress(env, adapter, at, outcome);
    await setState(env, 'economy_source_refresh_success_ms', String(at.getTime()));
    result = { ok: true, source: adapter.id, cursor: (index + 1) % adapters.length, totalSources: adapters.length, countries: outcome.coveredCountries, observations: outcome.observations, monthlyHistoryCountries: next.meta.monthlyCpiHistoryCountriesCount, quarterlyHistoryCountries: next.meta.quarterlyCpiHistoryCountriesCount, updatedAt: at.toISOString() };
    return result;
  } catch (error) {
    result = { ok: false, source: adapter?.id || null, reason: safeCode(error) };
    return result;
  } finally {
    if (token) { try { await release(env, lockKey, token); } catch {} }
  }
}
