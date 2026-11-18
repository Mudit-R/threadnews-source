import { XMLParser } from 'fast-xml-parser';
import { readLimited } from './feed.js';
import { fetchJSON } from './upstream.js';

const FX_FEED = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const FX_SOURCE = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html';
const GDP_SOURCE = 'https://data.worldbank.org/indicator/NY.GDP.MKTP.CD';
const WORLD_BANK = 'https://api.worldbank.org/v2';
const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });

export function parseExchangeRates(body, now = new Date()) {
  if (/<!DOCTYPE/i.test(body)) throw Error('unexpected_fx_format');
  const release = xml.parse(body)?.Envelope?.Cube?.Cube;
  const publishedDate = release?.['@_time'];
  if (typeof publishedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)
    || publishedDate > now.toISOString().slice(0, 10) || !Array.isArray(release.Cube)) throw Error('invalid_fx_release');
  const rates = { EUR: 1 };
  for (const item of release.Cube) {
    const code = item['@_currency'], rate = Number(item['@_rate']);
    if (/^[A-Z]{3}$/.test(code || '') && code !== 'EUR' && Number.isFinite(rate) && rate > 0) rates[code] = rate;
  }
  if (!rates.USD || !rates.INR || !rates.GBP || !rates.JPY) throw Error('incomplete_fx_release');
  return { base: 'EUR', publishedDate, fetchedAt: now.toISOString(), rates,
    source: { publisher: 'European Central Bank', url: FX_SOURCE, frequency: 'business-day reference rate' } };
}

async function loadExchangeRates() {
  const response = await fetch(FX_FEED, { redirect: 'manual', signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw Error('fx_upstream_unavailable');
  return parseExchangeRates(await readLimited(response, 64 * 1024));
}

export function rankEconomies(directory, observations) {
  const economies = new Map(directory.filter(item => item.region?.id !== 'NA' && item.region?.value !== 'Aggregates'
    && /^[A-Z]{3}$/.test(item.id) && /^[A-Z]{2}$/.test(item.iso2Code)).map(item => [item.id, item]));
  const byYear = new Map();
  for (const item of observations) {
    const country = economies.get(item.countryiso3code);
    const year = Number(item.date), value = item.value;
    if (!country || !Number.isInteger(year) || !Number.isFinite(value) || value <= 0) continue;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push({ code: country.iso2Code, name: country.name, gdpUsd: value });
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);
  for (const year of years) {
    const rows = byYear.get(year);
    const previous = [...(byYear.get(year - 1) || [])].sort((a, b) => b.gdpUsd - a.gdpUsd).slice(0, 10);
    const codes = new Set(rows.map(row => row.code));
    if (codes.size < 10 || previous.some(item => !codes.has(item.code))) continue;
    return { year, countries: rows.sort((a, b) => b.gdpUsd - a.gdpUsd).slice(0, 10),
      source: { publisher: 'World Bank', url: GDP_SOURCE, measure: 'Nominal GDP, current US dollars' } };
  }
  throw Error('gdp_ranking_unavailable');
}

async function loadGdpRanking() {
  const year = new Date().getUTCFullYear();
  const [countries, values] = await Promise.all([
    fetchJSON(`${WORLD_BANK}/country?format=json&per_page=400`, { timeoutMs: 9000, maxBytes: 512 * 1024 }),
    fetchJSON(`${WORLD_BANK}/country/all/indicator/NY.GDP.MKTP.CD?date=${year - 2}:${year - 1}&format=json&per_page=600`,
      { timeoutMs: 9000, maxBytes: 512 * 1024 })
  ]);
  if (!Array.isArray(countries?.[1]) || !Array.isArray(values?.[1])) throw Error('invalid_gdp_source');
  return rankEconomies(countries[1], values[1]);
}

export async function handleMarkets(request, ctx) {
  if (request.method !== 'GET') return Response.json({ error:'method_not_allowed' }, { status:405, headers:{ allow:'GET' } });
  const url = new URL(request.url);
  const fx = url.pathname === '/api/economy/fx';
  const cache = globalThis.caches?.default;
  const key = new Request(url.origin + url.pathname);
  const cached = await cache?.match(key);
  if (cached) return cached;
  try {
    const data = await (fx ? loadExchangeRates() : loadGdpRanking());
    const response = Response.json(data, { headers: {
      'cache-control': fx ? 'public, max-age=300, s-maxage=900' : 'public, max-age=3600, s-maxage=86400',
      'x-content-type-options': 'nosniff'
    } });
    if (cache) ctx?.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    return response;
  } catch {
    return Response.json({ error:'market_source_unavailable' }, { status:502, headers:{'cache-control':'no-store'} });
  }
}
