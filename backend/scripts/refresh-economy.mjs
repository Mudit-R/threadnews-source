import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readLimited, sha256 } from '../src/feed.js';
import { compactHistory, latestByPeriod, periodRank } from '../src/economy-history.js';
import { CollectorError, collectorConfig, fetchJSON, postIngest } from './collect-news.mjs';
import { refreshMonthlyCpi } from './monthly-inflation.js';

const START_YEAR = 2015;
const INDICATORS = { gdpGrowth: { id: 'NY.GDP.MKTP.KD.ZG', title: 'GDP growth (annual %)' }, inflation: { id: 'FP.CPI.TOTL.ZG', title: 'Inflation, consumer prices (annual %)' } };
export function countryMetadata(document) {
  if (!document || !Array.isArray(document.countries) || document.countries.length !== 19) throw new CollectorError('Expected the 19-country economy source document.');
  const countries = document.countries;
  if (countries.some(c => !/^[A-Z]{3}$/.test(c.iso3 || '')) || new Set(countries.map(c => c.iso3)).size !== countries.length) throw new CollectorError('Invalid country identifiers in economy source metadata.');
  return countries;
}
export function worldBankURL(codes, indicator, endYear, page = 1) {
  const url = new URL('https://api.worldbank.org/v2/country/' + codes.join(';') + '/indicator/' + indicator);
  url.searchParams.set('date', START_YEAR + ':' + endYear); url.searchParams.set('format', 'json'); url.searchParams.set('per_page', '1000');
  if (page > 1) url.searchParams.set('page', String(page));
  return url.href;
}
export async function worldBankIndicator(codes, indicator, { fetchImpl = fetch, now = new Date() } = {}) {
  const endYear = now.getUTCFullYear(), records = [], expected = new Set(codes); let updated = null;
  const url = worldBankURL(codes, indicator, endYear);
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const payload = await fetchJSON(worldBankURL(codes, indicator, endYear, page), { fetchImpl, headers: { accept: 'application/json', 'user-agent': 'Threadline/0.3 (official annual statistics collector)' } });
    if (!Array.isArray(payload) || !payload[0] || !Array.isArray(payload[1])) throw new CollectorError('invalid_world_bank_response');
    const meta = payload[0];
    if (!Number.isInteger(Number(meta.pages)) || Number(meta.pages) < 1 || Number(meta.pages) > 10 || Number(meta.page) !== page) throw new CollectorError('invalid_world_bank_pagination');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.lastupdated || '') || meta.lastupdated > now.toISOString().slice(0, 10)) throw new CollectorError('invalid_world_bank_vintage');
    if (updated && updated !== meta.lastupdated) throw new CollectorError('world_bank_vintage_changed_during_fetch');
    updated = meta.lastupdated; pages = Number(meta.pages);
    for (const row of payload[1]) {
      if (!expected.has(row.countryiso3code) || row.indicator?.id !== indicator || !/^\d{4}$/.test(row.date || '') || Number(row.date) < START_YEAR || Number(row.date) > endYear || (row.value !== null && (typeof row.value !== 'number' || !Number.isFinite(row.value)))) throw new CollectorError('invalid_world_bank_observation');
      records.push(row);
    }
  }
  const grouped = new Map(codes.map(code => [code, new Map()]));
  for (const row of records) {
    const map = grouped.get(row.countryiso3code), year = Number(row.date);
    if (map.has(year)) throw new CollectorError('duplicate_world_bank_observation');
    map.set(year, row.value);
  }
  if ([...grouped.values()].some(map => !map.size)) throw new CollectorError('incomplete_world_bank_country_coverage');
  return { grouped, updated, url };
}
function latest(series) { return [...series].reverse().find(row => typeof row.value === 'number') || null; }
function nationalMonthly(seed, live) {
  const a = seed?.latestInflation, b = live?.latestInflation;
  if (!a) return b || null;
  if (!b) return a;
  return periodRank(a.period) > periodRank(b.period) ? a : b;
}
export function assembleEconomy(seed, live, annual, now = new Date(), monthly = { byCountry: {}, statuses: [] }) {
  const base = countryMetadata(seed), current = live || seed;
  countryMetadata(current);
  const currentByCode = new Map(current.countries.map(c => [c.iso3, c]));
  if (base.some(c => !currentByCode.has(c.iso3))) throw new CollectorError('Live economy country coverage differs from the source metadata.');
  const endYear = now.getUTCFullYear(), years = Array.from({ length: endYear - START_YEAR + 1 }, (_, i) => START_YEAR + i);
  const countries = base.map(country => {
    const previous = currentByCode.get(country.iso3), result = { ...country, ...previous };
    for (const [key, indicator] of Object.entries(INDICATORS)) {
      result[key] = years.map(year => ({ year, value: annual[key].grouped.get(country.iso3).get(year) ?? null }));
      result[key === 'gdpGrowth' ? 'latestAnnualGdpGrowth' : 'latestAnnualInflation'] = latest(result[key]);
      result[key + 'Source'] = { ...(previous[key + 'Source'] || country[key + 'Source']), publisher: 'World Bank', dataset: 'World Development Indicators', indicator: indicator.id, title: indicator.title, url: worldBankURL([country.iso3], indicator.id, endYear), updated: annual[key].updated, unit: 'annual percent change' };
    }
    const priorHistory = previous.monthlyCpiHistory || country.monthlyCpiHistory || [];
    const refreshedHistory = monthly.byCountry?.[country.iso3] || [];
    const monthlySeries = compactHistory(priorHistory, refreshedHistory, previous.monthlyCpiHistorySource || country.monthlyCpiHistorySource || null, previous.monthlyCpiHistorySources || country.monthlyCpiHistorySources || [], 'monthly');
    result.monthlyCpiHistory = monthlySeries.history;
    result.monthlyCpiHistorySource = monthlySeries.source;
    if (monthlySeries.sources) result.monthlyCpiHistorySources = monthlySeries.sources;
    else delete result.monthlyCpiHistorySources;
    const priorQuarterly = previous.quarterlyCpiHistory || country.quarterlyCpiHistory || [];
    const refreshedQuarterly = monthly.quarterlyByCountry?.[country.iso3] || [];
    const quarterlySeries = compactHistory(priorQuarterly, refreshedQuarterly, previous.quarterlyCpiHistorySource || country.quarterlyCpiHistorySource || null, previous.quarterlyCpiHistorySources || country.quarterlyCpiHistorySources || [], 'quarterly');
    result.quarterlyCpiHistory = quarterlySeries.history;
    result.quarterlyCpiHistorySource = quarterlySeries.source;
    if (quarterlySeries.sources) result.quarterlyCpiHistorySources = quarterlySeries.sources;
    else delete result.quarterlyCpiHistorySources;
    const previousPrint = nationalMonthly(country, previous);
    const historyLatest = result.monthlyCpiHistory.at(-1) || null;
    const quarterlyLatest = result.quarterlyCpiHistory.at(-1) || null;
    const monthlyLatestSource = historyLatest?.sourceId != null ? result.monthlyCpiHistorySources?.[historyLatest.sourceId] : result.monthlyCpiHistorySource;
    const quarterlyLatestSource = quarterlyLatest?.sourceId != null ? result.quarterlyCpiHistorySources?.[quarterlyLatest.sourceId] : result.quarterlyCpiHistorySource;
    result.latestInflation = latestByPeriod(previousPrint, historyLatest && { ...historyLatest, source: monthlyLatestSource, measure: monthlyLatestSource?.measure, provisional: false }, quarterlyLatest && { ...quarterlyLatest, source: quarterlyLatestSource, measure: quarterlyLatestSource?.measure });
    result.latestInflationNote = result.monthlyCpiHistory.length || result.quarterlyCpiHistory.length
      ? `${result.monthlyCpiHistory.length ? `${result.monthlyCpiHistory.length} monthly` : ''}${result.monthlyCpiHistory.length && result.quarterlyCpiHistory.length ? ' and ' : ''}${result.quarterlyCpiHistory.length ? `${result.quarterlyCpiHistory.length} quarterly` : ''} year-on-year observations are shown with each source and definition. They remain separate from annual CPI.`
      : result.latestInflation
        ? 'A national monthly CPI print is shown with its source and reference period. This source has no verified monthly history adapter yet.'
        : 'No national monthly CPI observation has been imported; annual CPI remains a different measure.';
    const gaps = Object.entries(INDICATORS).flatMap(([key]) => {
      const missing = result[key].filter(row => row.value === null).map(row => row.year);
      return missing.length ? [(key === 'gdpGrowth' ? 'Annual GDP growth' : 'Annual CPI inflation') + ' is unavailable for ' + missing.join(', ') + '.'] : [];
    });
    result.note = gaps.length ? gaps.join(' ') + ' Missing observations are not zero or forecasts.' : 'Annual observations are reported historical series and may be revised by their statistical sources.';
    return result;
  });
  const updated = [annual.gdpGrowth.updated, annual.inflation.updated].sort().at(-1), stamp = now.toISOString();
  const latestYear = Math.max(...countries.flatMap(c => [...c.gdpGrowth, ...c.inflation].filter(v => v.value !== null).map(v => v.year)));
  const oldMeta = { ...(seed.meta || {}), ...(current.meta || {}) };
  const sources = { ...(oldMeta.sources || {}), gdpGrowth: annual.gdpGrowth.url, inflation: annual.inflation.url };
  const notes = (oldMeta.notes || []).filter(note => !/^No\s*\d{4}\s*annual GDP or annual CPI/i.test(note));
  const annualNote = 'Annual GDP growth and CPI are refreshed from World Bank records; missing years remain null. Monthly CPI histories retain their frequency and source definition: direct national series where an unauthenticated public API is available, World Bank Global Economic Monitor index-derived CPI for ten countries, and clearly labelled Eurostat HICP for Germany, France and Italy. Australia has a separate official quarterly seasonally adjusted history.';
  const monthlyStatuses = Array.isArray(monthly.statuses) ? monthly.statuses : [];
  const monthlySuccesses = monthlyStatuses.filter(item => item.status === 'updated' || item.status === 'partial').length;
  const nationalSuccesses = monthlyStatuses.filter(item => ['usa', 'canada', 'brazil', 'uk', 'argentina', 'australia-quarterly'].includes(item.id) && (item.status === 'updated' || item.status === 'partial')).length;
  const monthlyRefreshStatus = monthlyStatuses.length === 0 ? (oldMeta.monthlyRefresh?.status || 'not-checked')
    : monthlySuccesses === monthlyStatuses.length ? 'updated'
      : monthlySuccesses > 0 ? 'partial' : 'failed';
  const monthlyAttemptAt = monthlyStatuses.some(item => ['usa', 'canada', 'brazil', 'uk', 'argentina', 'australia-quarterly'].includes(item.id)) ? stamp : oldMeta.monthlyRefresh?.lastNationalSourceAttemptAt || null;
  const monthlyCheckedAt = nationalSuccesses > 0 ? stamp : oldMeta.monthlyRefresh?.lastNationalSourceCheckAt || null;
  const anySourceCheckedAt = monthlySuccesses > 0 ? stamp : oldMeta.monthlyRefresh?.lastSourceCheckAt || null;
  const sourceSnapshotAsOf = monthlySuccesses > 0 ? stamp.slice(0, 10) : oldMeta.monthlyRefresh?.sourceSnapshotAsOf || null;
  return { ...seed, ...current, countries, meta: { ...oldMeta, retrievedAt: stamp, generatedAt: stamp, asOfDate: stamp.slice(0, 10), asOf: stamp.slice(0, 10), years,
    sourceUpdated: updated, sourceUpdatedAt: updated, sourceUpdatedByIndicator: { gdpGrowth: annual.gdpGrowth.updated, inflation: annual.inflation.updated },
    sources, sourceLinks: { ...(oldMeta.sourceLinks || {}), ...sources }, countriesCount: countries.length, monthlyCpiCountriesCount: countries.filter(c => Number.isFinite(c.latestInflation?.value)).length,
    window: { ...(oldMeta.window || {}), startYear: START_YEAR, requestedEndYear: endYear, latestReportedAnnualYear: Number.isFinite(latestYear) ? latestYear : null },
    annualRefresh: { status: 'updated', lastSuccessAt: stamp, source: 'World Bank World Development Indicators' },
    monthlyCpiHistoryCountriesCount: countries.filter(c => c.monthlyCpiHistory?.length).length,
    quarterlyCpiHistoryCountriesCount: countries.filter(c => c.quarterlyCpiHistory?.length).length,
    monthlyRefresh: { ...(oldMeta.monthlyRefresh || {}), status: monthlyRefreshStatus, nationalSourcesChecked: nationalSuccesses > 0 || oldMeta.monthlyRefresh?.nationalSourcesChecked === true, lastNationalSourceCheckAt: monthlyCheckedAt, lastNationalSourceAttemptAt: monthlyAttemptAt, lastSourceAttemptAt: monthlyStatuses.length ? stamp : oldMeta.monthlyRefresh?.lastSourceAttemptAt || null, lastSourceCheckAt: anySourceCheckedAt, sourceSnapshotAsOf, annualPipelineCheckedAt: stamp, sources: monthlyStatuses, note: 'Monthly histories are available from direct national series for the United States, Canada, Brazil, the United Kingdom and Argentina; World Bank GEM index-derived CPI for ten countries and as a clearly labelled fallback if Statistics Canada is unavailable; and separately labelled Eurostat HICP for Germany, France and Italy. Australia uses a separate quarterly seasonally adjusted ABS CPI history. Missing country series remain gaps; no values are interpolated.' },
    notes: [...new Set([...notes, annualNote, 'The macro momentum indicator compares annual GDP growth and annual CPI inflation changes over the latest common two-year period available across all 19 countries. It is a descriptive comparison, not a forecast or a complete assessment of living standards.'])] } };
}
async function readLiveEconomy(origin, fetchImpl) {
  const response = await fetchImpl(new URL('/api/economy', origin), { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
  if (response.status === 404) {
    try { await response.body?.cancel(); } catch {}
    return { live: null, expectedEconomyHash: null };
  }
  if (!response.ok) throw new CollectorError('live_economy_read_http_' + response.status);
  let live;
  try { live = JSON.parse(await readLimited(response, 2 * 1024 * 1024)); }
  catch { throw new CollectorError('invalid_live_economy_document'); }
  countryMetadata(live);
  const etag = response.headers.get('etag') || '';
  const matched = /^(?:W\/)?"([a-fA-F0-9]{64})"$/.exec(etag);
  const expectedEconomyHash = matched ? matched[1].toLowerCase() : await sha256(JSON.stringify(live));
  return { live, expectedEconomyHash };
}

export async function refreshEconomy({ env = process.env, fetchImpl = fetch, now = new Date(), seedDocument } = {}) {
  const { origin } = collectorConfig(env);
  let seed = seedDocument;
  if (!seed) {
    try { seed = JSON.parse((await readFile(new URL('../../web/economy-data.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, '')); }
    catch { throw new CollectorError('Cannot read web/economy-data.json country/source metadata.'); }
  }
  const metadata = countryMetadata(seed), codes = metadata.map(c => c.iso3);
  // Read the live document first: never roll national monthly vintages back to a
  // repository snapshot when an API outage prevents reading the current store.
  let { live, expectedEconomyHash } = await readLiveEconomy(origin, fetchImpl);
  // Both indicators must succeed before posting. A partial fetch never clears
  // the other series or replaces a previously valid database document.
  const results = await Promise.all(Object.entries(INDICATORS).map(async ([key, indicator]) => [key, await worldBankIndicator(codes, indicator.id, { fetchImpl, now })]));
  const monthly = await refreshMonthlyCpi({ fetchImpl, now });
  const annual = Object.fromEntries(results);
  let economy = assembleEconomy(seed, live, annual, now, monthly);
  try {
    await postIngest({ economy, expectedEconomyHash, feedId: 'world-bank-annual', mode: 'automatic' }, { env, fetchImpl });
  } catch (error) {
    if (error?.code !== 'ingest_http_409') throw error;
    // A native monthly source or another importer committed while the annual
    // series were being collected. Rebase once on the latest full document,
    // retaining its CPI vintages before retrying the same official snapshots.
    ({ live, expectedEconomyHash } = await readLiveEconomy(origin, fetchImpl));
    economy = assembleEconomy(seed, live, annual, now, monthly);
    try { await postIngest({ economy, expectedEconomyHash, feedId: 'world-bank-annual', mode: 'automatic' }, { env, fetchImpl }); }
    catch (retryError) {
      if (retryError?.code === 'ingest_http_409') throw new CollectorError('economy_changed_during_refresh');
      throw retryError;
    }
  }
  return { ok: true, countries: economy.countries.length, annualThroughYear: economy.meta.window.latestReportedAnnualYear, sourceUpdated: economy.meta.sourceUpdated, monthlyStatus: economy.meta.monthlyRefresh.status, monthlyHistoryCountries: economy.meta.monthlyCpiHistoryCountriesCount, monthlySourcesUpdated: monthly.successfulSources, refreshedAt: now.toISOString() };
}
export async function main() {
  try { console.log(JSON.stringify(await refreshEconomy())); }
  catch (error) { console.error(error instanceof CollectorError ? error.code : 'economy_refresh_failed; previous database content was retained'); process.exitCode = 1; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
