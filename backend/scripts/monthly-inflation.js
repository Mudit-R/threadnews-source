import { fetchJSON } from '../src/upstream.js';
import { readLimited } from '../src/feed.js';

const FROM_YEAR = 2014; // The extra year is needed to calculate January 2015 year-on-year CPI.
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function finite(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}
function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

async function fetchText(url, { fetchImpl = fetch, maxBytes = 256 * 1024, ...options } = {}) {
  const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: options.signal || AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`upstream_http_${response.status}`);
  return readLimited(response, maxBytes);
}
async function fetchJSONTransientRetry(url, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetchJSON(url, options); }
    catch (error) {
      const retryable = error instanceof TypeError || error?.code === 'upstream_fetch_failed';
      if (!retryable || attempt >= 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
}

function monthFromDate(value) {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?/.exec(String(value || ''));
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
  return `${match[1]}-${match[2]}`;
}

function monthIndex(period) {
  if (!YEAR_MONTH.test(period)) return null;
  const [year, month] = period.split('-').map(Number);
  return year * 12 + month - 1;
}

function normalizeIndex(rows, source) {
  const values = new Map();
  for (const row of rows) {
    const period = monthFromDate(row.period);
    const value = finite(row.value);
    if (!period || value === null || value <= 0) continue;
    values.set(period, { value, releaseDate: row.releaseDate || null });
  }
  return [...values.keys()].sort().flatMap(period => {
    const index = monthIndex(period), previousPeriod = index === null ? null : `${Math.floor((index - 12) / 12)}-${String(((index - 12) % 12 + 12) % 12 + 1).padStart(2, '0')}`;
    const current = values.get(period), previous = previousPeriod && values.get(previousPeriod);
    if (!previous || Number(period.slice(0, 4)) < 2015) return [];
    return [{
      period,
      value: Number((((current.value / previous.value) - 1) * 100).toFixed(3)),
      frequency: 'monthly',
      measure: source.measure || 'Headline CPI, year-on-year',
      unit: 'percent',
      releaseDate: current.releaseDate,
      source
    }];
  });
}

function normalizeReportedRates(rows, source, measure = 'Headline CPI, year-on-year') {
  const map = new Map();
  for (const row of rows) {
    const period = row.period;
    const value = finite(row.value);
    if (!YEAR_MONTH.test(String(period || '')) || value === null) continue;
    if (Number(period.slice(0, 4)) < 2015) continue;
    map.set(period, {
      period, value: Number(value.toFixed(3)), frequency: 'monthly', measure,
      unit: 'percent', releaseDate: row.releaseDate || null, source
    });
  }
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
}

const SOURCE = {
  usa: { publisher: 'U.S. Bureau of Labor Statistics', dataset: 'CPI-U, U.S. city average, all items, not seasonally adjusted', title: 'Consumer Price Index series CUUR0000SA0', url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0', measure: 'U.S. CPI-U, all items, year-on-year' },
  canada: { publisher: 'Statistics Canada', dataset: 'Consumer Price Index, monthly, not seasonally adjusted, table 18-10-0004-01; vector 41690973', title: 'Canada; All-items CPI index (2002=100)', url: 'https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorByReferencePeriodRange?vectorIds=%2241690973%22&startRefPeriod=2014-01-01', measure: 'Canada all-items CPI, year-on-year' },
  brazil: { publisher: 'Instituto Brasileiro de Geografia e Estatística (IBGE)', dataset: 'SIDRA table 1737, variable 2266', title: 'IPCA all-items index (December 1993=100)', url: 'https://apisidra.ibge.gov.br/values/t/1737/n1/all/v/2266/p/201401-202611', measure: 'Brazil IPCA, year-on-year' },
  uk: { publisher: 'Office for National Statistics', dataset: 'MM23, time series D7G7', title: 'CPI annual rate 00: all items', url: 'https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/d7g7/mm23/data', measure: 'UK CPI, year-on-year' },
  eurostat: { publisher: 'Eurostat', dataset: 'prc_hicp_manr', title: 'All-items Harmonised Index of Consumer Prices, annual rate of change', url: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_manr', measure: 'HICP, year-on-year (harmonised CPI)' }
};

const GEM_COUNTRIES = Object.freeze(['CHN', 'IND', 'IDN', 'JPN', 'MEX', 'KOR', 'RUS', 'SAU', 'ZAF', 'TUR', 'CAN']);
const GEM_INDICATOR = 'CPTOTNSXN';
const GEM_SOURCE_ID = '15';
const GEM_SOURCE = {
  publisher: 'World Bank Global Economic Monitor',
  dataset: 'CPTOTNSXN — CPI Price, nominal (not seasonally adjusted)',
  title: 'CPI Price, nominal; year-on-year change derived from the index',
  sourceNote: 'The consumer price index reflects the change in prices for the average consumer of a constant basket of consumer goods. Data is not seasonally adjusted.',
  sourceOrganization: 'World Bank staff calculations based on Datastream',
  measure: 'World Bank GEM CPI index, year-on-year (derived; not seasonally adjusted)',
  url: 'https://api.worldbank.org/v2/indicator/CPTOTNSXN?source=15&format=json'
};
const ARGENTINA_SERIES = '148.3_INIVELNAL_DICI_M_26';
const ARGENTINA_SOURCE = {
  publisher: 'Instituto Nacional de Estadística y Censos (INDEC), via Datos.gob.ar',
  dataset: 'Índice de Precios al Consumidor Nacional (IPC), base diciembre 2016',
  title: 'National all-items CPI index; year-on-year change derived from the index',
  measure: 'Argentina national CPI, year-on-year (derived from monthly index)',
  url: `https://apis.datos.gob.ar/series/api/series/?ids=${ARGENTINA_SERIES}`
};
const AUSTRALIA_QUARTERLY_SOURCE = {
  publisher: 'Australian Bureau of Statistics',
  dataset: 'Consumer Price Index Quarterly (CPI_Q)',
  title: 'All groups CPI, seasonally adjusted; year-on-year change derived from quarterly index',
  measure: 'Australia all-groups CPI, seasonally adjusted, year-on-year (derived from quarterly index)',
  url: 'https://data.api.abs.gov.au/rest/data/ABS,CPI_Q/1.999901.20.50.Q?startPeriod=2014-Q1&format=csv'
};

function quarterIndex(period) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(period || ''));
  return match ? Number(match[1]) * 4 + Number(match[2]) - 1 : null;
}

function normalizeQuarterlyIndex(rows, source) {
  const values = new Map();
  for (const row of rows) {
    const index = quarterIndex(row.period), value = finite(row.value);
    if (index === null || value === null || value <= 0) continue;
    values.set(row.period, { index, value });
  }
  return [...values.keys()].sort().flatMap(period => {
    const index = quarterIndex(period), previousPeriod = index === null ? null : `${Math.floor((index - 4) / 4)}-Q${((index - 4) % 4 + 4) % 4 + 1}`;
    const current = values.get(period), previous = previousPeriod && values.get(previousPeriod);
    if (!previous || Number(period.slice(0, 4)) < 2015) return [];
    return [{ period, value: Number((((current.value / previous.value) - 1) * 100).toFixed(3)), frequency: 'quarterly', measure: source.measure, unit: 'percent', source }];
  });
}

export function worldBankGemMonthlyURL(page = 1, endYear = new Date().getUTCFullYear(), countries = GEM_COUNTRIES) {
  const url = new URL(`https://api.worldbank.org/v2/country/${countries.join(';')}/indicator/${GEM_INDICATOR}`);
  url.searchParams.set('source', GEM_SOURCE_ID);
  url.searchParams.set('date', `2014M01:${endYear}M12`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('per_page', '1000');
  url.searchParams.set('page', String(page));
  return url.href;
}

export async function fetchWorldBankGemMonthlyCpi({ fetchImpl = fetch, now = new Date(), countries = GEM_COUNTRIES } = {}) {
  const expected = new Set(countries), records = [];
  let pages = 1, total = null, lastupdated = null;
  for (let page = 1; page <= pages; page++) {
    const url = worldBankGemMonthlyURL(page, now.getUTCFullYear(), countries);
    const payload = await fetchJSON(url, { fetchImpl, maxBytes: 768 * 1024, headers: { accept: 'application/json', 'user-agent': 'ThreadNews/0.5 (official CPI history reader)' } });
    if (!Array.isArray(payload) || !payload[0] || !Array.isArray(payload[1])) throw new Error('world_bank_gem_invalid_response');
    const meta = payload[0];
    if (String(meta.sourceid) !== GEM_SOURCE_ID || Number(meta.page) !== page || !Number.isInteger(Number(meta.pages)) || Number(meta.pages) < 1 || Number(meta.pages) > 10 || !Number.isInteger(Number(meta.total)) || Number(meta.total) < 1) throw new Error('world_bank_gem_invalid_pagination');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.lastupdated || '') || meta.lastupdated > now.toISOString().slice(0, 10)) throw new Error('world_bank_gem_invalid_vintage');
    if ((total !== null && total !== Number(meta.total)) || (lastupdated && lastupdated !== meta.lastupdated)) throw new Error('world_bank_gem_vintage_changed');
    total = Number(meta.total); lastupdated = meta.lastupdated; pages = Number(meta.pages);
    for (const row of payload[1]) {
      const iso3 = row.country?.id, periodMatch = /^(\d{4})M(0[1-9]|1[0-2])$/.exec(row.date || '');
      if (!expected.has(iso3) || row.indicator?.id !== GEM_INDICATOR || !periodMatch || Number(periodMatch[1]) < 2014 || Number(periodMatch[1]) > now.getUTCFullYear() || (row.value !== null && (typeof row.value !== 'number' || !Number.isFinite(row.value)))) throw new Error('world_bank_gem_invalid_observation');
      records.push({ iso3, period: `${periodMatch[1]}-${periodMatch[2]}`, value: row.value });
    }
  }
  if (records.length !== total) throw new Error('world_bank_gem_incomplete_pagination');
  const grouped = new Map(countries.map(iso3 => [iso3, new Map()]));
  for (const row of records) {
    const points = grouped.get(row.iso3);
    if (points.has(row.period)) throw new Error('world_bank_gem_duplicate_observation');
    points.set(row.period, row.value);
  }
  const source = { ...GEM_SOURCE, updatedAt: lastupdated };
  const byCountry = {};
  for (const iso3 of countries) {
    const rows = [...grouped.get(iso3)].map(([period, value]) => ({ period, value }));
    const history = normalizeIndex(rows, source);
    if (history.length) byCountry[iso3] = history;
  }
  return { byCountry, sourceUpdated: lastupdated, sourceTotal: total };
}

export function argentinaMonthlyCpiURL(endDate = new Date()) {
  const url = new URL('https://apis.datos.gob.ar/series/api/series/');
  url.searchParams.set('ids', ARGENTINA_SERIES);
  url.searchParams.set('start_date', '2016-12-01');
  url.searchParams.set('end_date', `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-01`);
  url.searchParams.set('limit', '1000');
  url.searchParams.set('format', 'json');
  return url.href;
}

export async function fetchArgentinaMonthlyCpi({ fetchImpl = fetch, now = new Date() } = {}) {
  const url = argentinaMonthlyCpiURL(now);
  const payload = await fetchJSON(url, { fetchImpl, maxBytes: 256 * 1024, headers: { accept: 'application/json', 'user-agent': 'ThreadNews/0.5 (official CPI history reader)' } });
  const metadata = payload?.meta?.[1], field = metadata?.field, rows = payload?.data;
  if (!Array.isArray(rows) || rows.length < 24 || Number(payload.count) < rows.length || payload.meta?.[0]?.frequency !== 'month' || field?.id !== ARGENTINA_SERIES || !/Nivel General Nacional/i.test(field?.description || '') || !/INDEC/i.test(metadata?.dataset?.source || '')) throw new Error('datos_argentina_unexpected_series');
  const source = { ...ARGENTINA_SOURCE, dataset: metadata.dataset.title || ARGENTINA_SOURCE.dataset, title: field.description, retrievedAt: now.toISOString() };
  const history = normalizeIndex(rows.map(row => ({ period: row?.[0], value: row?.[1] })), source);
  if (history.length < 24) throw new Error('datos_argentina_insufficient_monthly_history');
  return history;
}

function parseCsvLine(line) {
  const fields = []; let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { fields.push(field); field = ''; }
    else field += char;
  }
  fields.push(field);
  return fields;
}

export async function fetchAustraliaQuarterlyCpi({ fetchImpl = fetch, now = new Date() } = {}) {
  const url = AUSTRALIA_QUARTERLY_SOURCE.url;
  const text = await fetchText(url, { fetchImpl, maxBytes: 64 * 1024, headers: { accept: 'text/csv', 'user-agent': 'ThreadNews/0.5 (official CPI history reader)' } });
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 20) throw new Error('abs_insufficient_quarterly_history');
  const header = parseCsvLine(lines.shift());
  const required = ['DATAFLOW', 'MEASURE', 'INDEX', 'TSEST', 'REGION', 'FREQ', 'TIME_PERIOD', 'OBS_VALUE'];
  if (!required.every(key => header.includes(key))) throw new Error('abs_unexpected_quarterly_csv');
  const rows = lines.map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => [header[index], value])));
  if (rows.some(row => !/^ABS:CPI_Q\(/.test(row.DATAFLOW || '') || row.MEASURE !== '1' || row.INDEX !== '999901' || row.TSEST !== '20' || row.REGION !== '50' || row.FREQ !== 'Q' || !/^\d{4}-Q[1-4]$/.test(row.TIME_PERIOD || '') || (row.OBS_VALUE !== '' && finite(row.OBS_VALUE) === null))) throw new Error('abs_unexpected_quarterly_series');
  const source = { ...AUSTRALIA_QUARTERLY_SOURCE, retrievedAt: now.toISOString() };
  const history = normalizeQuarterlyIndex(rows.map(row => ({ period: row.TIME_PERIOD, value: row.OBS_VALUE })), source);
  if (history.length < 24) throw new Error('abs_insufficient_quarterly_history');
  return history;
}

async function fetchBlsRows({ fetchImpl = fetch, now = new Date() } = {}) {
  const endYear = now.getUTCFullYear();
  // Unregistered requests are kept to six-year windows, safely inside BLS limits.
  const windows = [[FROM_YEAR, Math.min(FROM_YEAR + 5, endYear)]];
  if (endYear > FROM_YEAR + 5) windows.push([FROM_YEAR + 6, endYear]);
  const result = [];
  for (const [startyear, endyear] of windows) {
    const payload = await fetchJSON('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      fetchImpl, maxBytes: 768 * 1024, method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ seriesid: ['CUUR0000SA0'], startyear: String(startyear), endyear: String(endyear) })
    });
    if (payload.status !== 'REQUEST_SUCCEEDED' || !Array.isArray(payload.Results?.series) || payload.Results.series[0]?.seriesID !== 'CUUR0000SA0') throw new Error('bls_invalid_series_response');
    for (const row of payload.Results.series[0].data || []) {
      const periodNumber = /^M(0[1-9]|1[0-2])$/.exec(row.period || '');
      if (!/^\d{4}$/.test(row.year || '') || !periodNumber) continue;
      const value = finite(row.value);
      if (value === null) continue;
      result.push({ period: `${row.year}-${periodNumber[1]}`, value, releaseDate: null });
    }
  }
  return result;
}

export async function fetchUsMonthlyCpi({ fetchImpl = fetch, now = new Date() } = {}) {
  const rows = await fetchBlsRows({ fetchImpl, now });
  const history = normalizeIndex(rows, SOURCE.usa);
  if (history.length < 24) throw new Error('bls_insufficient_monthly_history');
  return history;
}

export async function fetchCanadaMonthlyCpi({ fetchImpl = fetch, now = new Date() } = {}) {
  const url = new URL('https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorByReferencePeriodRange');
  url.searchParams.set('vectorIds', '"41690973"');
  url.searchParams.set('startRefPeriod', `${FROM_YEAR}-01-01`);
  url.searchParams.set('endReferencePeriod', `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`);
  const payload = await fetchJSONTransientRetry(url, { fetchImpl, maxBytes: 2 * 1024 * 1024, headers: { accept: 'application/json', 'user-agent': 'ThreadNews/0.4 (official statistics reader)' } });
  const entry = Array.isArray(payload) ? payload.find(item => item?.object?.vectorId === 41690973) : null;
  if (entry?.status !== 'SUCCESS' || entry.object.responseStatusCode !== 0 || !Array.isArray(entry.object.vectorDataPoint)) throw new Error('statcan_invalid_vector_response');
  const rows = entry.object.vectorDataPoint.map(point => ({ period: point.refPer, value: point.value, releaseDate: point.releaseTime ? point.releaseTime.slice(0, 10) : null }));
  const history = normalizeIndex(rows, SOURCE.canada);
  if (history.length < 24) throw new Error('statcan_insufficient_monthly_history');
  return history;
}

export function ibgeSidraURL(now = new Date()) {
  const end = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `https://apisidra.ibge.gov.br/values/t/1737/n1/all/v/2266/p/201401-${end}`;
}

export async function fetchBrazilMonthlyCpi({ fetchImpl = fetch, now = new Date() } = {}) {
  const payload = await fetchJSON(ibgeSidraURL(now), { fetchImpl, maxBytes: 2 * 1024 * 1024, headers: { accept: 'application/json', 'user-agent': 'ThreadNews/0.4 (official statistics reader)' } });
  if (!Array.isArray(payload) || payload[0]?.['D2C'] !== 'Variável (Código)' || !payload.some(row => row?.['D2C'] === '2266' && row?.['D2N'] === 'IPCA - Número-índice (base: dezembro de 1993 = 100)')) throw new Error('ibge_unexpected_sidra_table');
  const rows = payload.slice(1).map(row => ({ period: /^\d{6}$/.test(row?.D3C || '') ? `${row.D3C.slice(0, 4)}-${row.D3C.slice(4, 6)}-01` : null, value: row.V }));
  const history = normalizeIndex(rows, { ...SOURCE.brazil, url: ibgeSidraURL(now) });
  if (history.length < 24) throw new Error('ibge_insufficient_monthly_history');
  return history;
}

export async function fetchUkMonthlyCpi({ fetchImpl = fetch } = {}) {
  const payload = await fetchJSON(SOURCE.uk.url, { fetchImpl, maxBytes: 2 * 1024 * 1024, headers: { accept: 'application/json', 'user-agent': 'ThreadNews/0.4 (official statistics reader)' } });
  if (!Array.isArray(payload.months) || payload.description?.cdid !== 'D7G7' || payload.description?.datasetId !== 'MM23') throw new Error('ons_unexpected_cpi_series');
  const monthNumber = new Map(['January','February','March','April','May','June','July','August','September','October','November','December'].map((name, index) => [name, String(index + 1).padStart(2, '0')]));
  const rows = payload.months.map(row => ({
    period: /^\d{4}$/.test(row.year || '') && monthNumber.has(row.month) ? `${row.year}-${monthNumber.get(row.month)}` : null,
    value: row.value,
    releaseDate: row.updateDate ? row.updateDate.slice(0, 10) : null
  }));
  const history = normalizeReportedRates(rows, SOURCE.uk, SOURCE.uk.measure);
  if (history.length < 24) throw new Error('ons_insufficient_monthly_history');
  return history;
}

export function eurostatMonthlyCpiURL(geo) {
  if (!['DE', 'FR', 'IT'].includes(geo)) throw new Error('unsupported_eurostat_country');
  const url = new URL('https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_manr');
  url.searchParams.set('geo', geo);
  url.searchParams.set('unit', 'RCH_A');
  url.searchParams.set('coicop', 'CP00');
  url.searchParams.set('sinceTimePeriod', '2015-01');
  return url.href;
}

export async function fetchEurostatHicp(geo, { fetchImpl = fetch } = {}) {
  const url = eurostatMonthlyCpiURL(geo);
  const payload = await fetchJSON(url, { fetchImpl, maxBytes: 2 * 1024 * 1024, headers: { accept: 'application/json', 'user-agent': 'ThreadNews/0.4 (official statistics reader)' } });
  if (payload.id?.join(',') !== 'freq,unit,coicop,geo,time' || payload.dimension?.geo?.category?.index?.[geo] !== 0 || !payload.dimension?.time?.category?.index) throw new Error('eurostat_unexpected_hicp_shape');
  const countries = { DE: 'Germany', FR: 'France', IT: 'Italy' };
  const source = { ...SOURCE.eurostat, title: `All-items HICP annual rate of change — ${countries[geo]}`, url, updatedAt: timestamp(payload.updated) };
  const periods = payload.dimension.time.category.index;
  const values = payload.value || {};
  const rows = Object.entries(periods).map(([period, index]) => ({ period, value: values[index] }));
  const history = normalizeReportedRates(rows, source, SOURCE.eurostat.measure);
  if (history.length < 24) throw new Error(`eurostat_insufficient_monthly_history_${geo.toLowerCase()}`);
  return history;
}

export const MONTHLY_CPI_ADAPTERS = Object.freeze([
  { id: 'usa', countries: ['USA'], fetch: fetchUsMonthlyCpi },
  { id: 'canada', countries: ['CAN'], fetch: fetchCanadaMonthlyCpi },
  { id: 'brazil', countries: ['BRA'], fetch: fetchBrazilMonthlyCpi },
  { id: 'uk', countries: ['GBR'], fetch: fetchUkMonthlyCpi },
  { id: 'argentina', countries: ['ARG'], fetch: fetchArgentinaMonthlyCpi },
  { id: 'world-bank-gem', countries: [...GEM_COUNTRIES], fetch: fetchWorldBankGemMonthlyCpi },
  { id: 'australia-quarterly', countries: ['AUS'], frequency: 'quarterly', fetch: fetchAustraliaQuarterlyCpi },
  { id: 'eurostat-de', countries: ['DEU'], fetch: options => fetchEurostatHicp('DE', options) },
  { id: 'eurostat-fr', countries: ['FRA'], fetch: options => fetchEurostatHicp('FR', options) },
  { id: 'eurostat-it', countries: ['ITA'], fetch: options => fetchEurostatHicp('IT', options) }
]);

export async function refreshMonthlyCpi({ fetchImpl = fetch, now = new Date(), adapters = MONTHLY_CPI_ADAPTERS } = {}) {
  const byCountry = {}, quarterlyByCountry = {}, statuses = [];
  for (const adapter of adapters) {
    try {
      const result = await adapter.fetch({ fetchImpl, now });
      const sourceHistories = Array.isArray(result)
        ? Object.fromEntries(adapter.countries.map(iso3 => [iso3, result]))
        : result?.byCountry || { [adapter.countries[0]]: result?.history || [] };
      const target = adapter.frequency === 'quarterly' ? quarterlyByCountry : byCountry;
      const covered = [];
      for (const iso3 of adapter.countries) {
        const history = sourceHistories[iso3];
        if (Array.isArray(history) && history.length) { if (!target[iso3]) target[iso3] = history; covered.push(iso3); }
      }
      const points = covered.flatMap(iso3 => target[iso3]);
      const status = covered.length === adapter.countries.length ? 'updated' : covered.length ? 'partial' : 'failed';
      statuses.push({ id: adapter.id, countries: adapter.countries, coveredCountries: covered, status, observations: points.length, latestPeriod: points.map(point => point.period).sort().at(-1) || null, ...(result?.sourceUpdated ? { sourceUpdated: result.sourceUpdated } : {}) });
    } catch {
      // Keep source failures bounded and non-sensitive; the caller preserves prior observations.
      statuses.push({ id: adapter.id, countries: adapter.countries, status: 'failed', reason: 'source_unavailable' });
    }
  }
  const successes = statuses.filter(item => item.status === 'updated' || item.status === 'partial');
  return { byCountry, quarterlyByCountry, statuses, successfulSources: successes.length, successfulCountries: Object.keys(byCountry).length + Object.keys(quarterlyByCountry).length };
}
