import test from 'node:test';
import assert from 'node:assert/strict';
import '../../web/economy-metrics.js';
import {
  fetchBrazilMonthlyCpi, fetchCanadaMonthlyCpi, fetchEurostatHicp, fetchUsMonthlyCpi,
  fetchUkMonthlyCpi, refreshMonthlyCpi, fetchWorldBankGemMonthlyCpi,
  fetchArgentinaMonthlyCpi, fetchAustraliaQuarterlyCpi
} from '../scripts/monthly-inflation.js';

const metrics = globalThis.ThreadNewsEconomyMetrics;
const monthRange = (startYear, startMonth, count) => Array.from({ length: count }, (_, i) => {
  const index = startYear * 12 + startMonth - 1 + i;
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
});
const country = (iso3, gdp, inflation) => ({
  iso3,
  gdpGrowth: Object.entries(gdp).map(([year, value]) => ({ year: Number(year), value })),
  inflation: Object.entries(inflation).map(([year, value]) => ({ year: Number(year), value }))
});
const jsonFetch = payload => async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

test('momentum compares the latest common annual period and exposes both contributions', () => {
  const a = country('AAA', { 2022: 2, 2023: 3, 2024: 4, 2025: 6 }, { 2022: 5, 2023: 4, 2024: 3, 2025: 2 });
  const b = country('BBB', { 2022: -1, 2023: 0, 2024: 1 }, { 2022: 3, 2023: 2, 2024: 2.5 });
  assert.deepEqual(metrics.commonComparisonYears([a, b]), [2023, 2024]);
  assert.deepEqual(metrics.momentumScore(a, [a, b]), {
    version: 'macro-momentum-v1', score: 57.5, status: 'Mixed', period: { from: 2023, to: 2024 }, baseline: 50,
    growthChange: 1, growthContribution: 5, inflationChange: -1, inflationContribution: 2.5,
    formula: 'clamp(50 + 5 × annual GDP-growth change − 2.5 × annual CPI-inflation change, 0, 100)'
  });
});

test('momentum withholds a score when no shared adjacent year is complete', () => {
  const a = country('AAA', { 2023: 1, 2024: 2 }, { 2023: 3, 2024: 2 });
  const b = country('BBB', { 2023: 1, 2024: 2 }, { 2023: 3 });
  assert.deepEqual(metrics.commonComparisonYears([a, b]), []);
  assert.equal(metrics.momentumScore(a, [a, b]), null);
});

test('momentum score is bounded at zero and one hundred', () => {
  const rise = country('AAA', { 2023: -20, 2024: 20 }, { 2023: 0, 2024: 100 });
  assert.equal(metrics.momentumScore(rise, [rise]).score, 0);
  const fall = country('AAA', { 2023: 20, 2024: -20 }, { 2023: 100, 2024: 0 });
  assert.equal(metrics.momentumScore(fall, [fall]).score, 100);
});

test('Statistics Canada index adapter calculates year-on-year CPI from official monthly index values', async () => {
  const points = monthRange(2014, 1, 36).map((period, index) => ({ refPer: `${period}-01`, value: index < 12 ? 100 + index : 103 + index - 12, releaseTime: `${period}-20T08:30` }));
  const fetchImpl = jsonFetch([{ status: 'SUCCESS', object: { responseStatusCode: 0, vectorId: 41690973, vectorDataPoint: points } }]);
  const history = await fetchCanadaMonthlyCpi({ fetchImpl, now: new Date('2016-12-15T00:00:00Z') });
  assert.equal(history[0].period, '2015-01');
  assert.equal(history[0].value, 3);
  assert.equal(history[0].source.publisher, 'Statistics Canada');
});

test('Statistics Canada retries one transient network failure, then succeeds', async () => {
  const points = monthRange(2014, 1, 36).map((period, index) => ({ refPer: `${period}-01`, value: 100 + index }));
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new TypeError('transient network failure');
    return Response.json([{ status: 'SUCCESS', object: { responseStatusCode: 0, vectorId: 41690973, vectorDataPoint: points } }]);
  };
  const history = await fetchCanadaMonthlyCpi({ fetchImpl, now: new Date('2016-12-15T00:00:00Z') });
  assert.equal(calls, 2);
  assert.equal(history[0].period, '2015-01');
});

test('Statistics Canada does not retry a server error without honoring server retry guidance', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('', { status: 503, headers: { 'retry-after': '120' } }); };
  await assert.rejects(fetchCanadaMonthlyCpi({ fetchImpl }), /upstream_http_503/);
  assert.equal(calls, 1);
});

test('BLS adapter requests bounded year windows and computes CPI-U year-on-year values', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push([request.startyear, request.endyear]);
    const data = monthRange(2014, 1, 72).map((period, i) => {
      const [year, month] = period.split('-');
      return { year, period: `M${month}`, value: String(100 + i) };
    }).filter(row => Number(row.year) >= Number(request.startyear) && Number(row.year) <= Number(request.endyear));
    return new Response(JSON.stringify({ status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID: 'CUUR0000SA0', data }] } }), { status: 200 });
  };
  const history = await fetchUsMonthlyCpi({ fetchImpl, now: new Date('2019-12-15T00:00:00Z') });
  assert.deepEqual(calls, [['2014','2019']]);
  assert.equal(history[0].period, '2015-01');
  assert.equal(history[0].value, 12);
  assert.equal(history[0].source.publisher, 'U.S. Bureau of Labor Statistics');
});

test('IBGE adapter identifies table, variable and computes the reported index-based annual change', async () => {
  const periods = monthRange(2014, 1, 36);
  const payload = [
    { D2C: 'Variável (Código)' },
    { D2C: '2266', D2N: 'IPCA - Número-índice (base: dezembro de 1993 = 100)' },
    ...periods.map((period, index) => ({ D2C: '2266', D2N: 'IPCA - Número-índice (base: dezembro de 1993 = 100)', D3C: period.replace('-', ''), V: String(100 + index) }))
  ];
  const history = await fetchBrazilMonthlyCpi({ fetchImpl: jsonFetch(payload), now: new Date('2016-12-15T00:00:00Z') });
  assert.equal(history[0].period, '2015-01');
  assert.equal(history[0].value, 12);
  assert.equal(history[0].source.publisher, 'Instituto Brasileiro de Geografia e Estatística (IBGE)');
});

test('ONS adapter keeps the published monthly annual CPI rate and release vintage', async () => {
  const months = monthRange(2015, 1, 36).map(period => {
    const [year, month] = period.split('-').map(Number);
    return { year: String(year), month: new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }), value: '2.5', updateDate: `${period}-20T07:00:00Z` };
  });
  const payload = { months, description: { cdid: 'D7G7', datasetId: 'MM23' } };
  const history = await fetchUkMonthlyCpi({ fetchImpl: jsonFetch(payload) });
  assert.equal(history[0].period, '2015-01');
  assert.equal(history[0].value, 2.5);
  assert.equal(history[0].releaseDate, '2015-01-20');
  assert.match(history[0].measure, /UK CPI/);
});

test('Eurostat adapter preserves harmonised HICP as a distinct measure', async () => {
  const times = monthRange(2023, 1, 36);
  const payload = {
    id: ['freq', 'unit', 'coicop', 'geo', 'time'],
    dimension: { geo: { category: { index: { DE: 0 } } }, time: { category: { index: Object.fromEntries(times.map((period, i) => [period, i])) } } },
    value: Object.fromEntries(times.map((_, i) => [i, 2 + i / 100]))
  };
  const history = await fetchEurostatHicp('DE', { fetchImpl: jsonFetch(payload) });
  assert.equal(history[0].period, '2023-01');
  assert.equal(history[0].measure, 'HICP, year-on-year (harmonised CPI)');
  assert.equal(history[0].source.publisher, 'Eurostat');
});

test('World Bank GEM CPI adapter validates source-vintage pagination and computes rates from monthly index', async () => {
  const calls = [];
  const row = (iso3, date, value) => ({ indicator: { id: 'CPTOTNSXN', value: 'CPI Price,not seas.adj,,,' }, country: { id: iso3, value: iso3 }, countryiso3code: '', date, value, unit: '', obs_status: '', decimal: 0 });
  const pages = [
    [row('CHN', '2014M01', 100), row('CHN', '2015M01', 110)],
    [row('RUS', '2014M01', 120), row('RUS', '2015M01', 126), row('RUS', '2026M08', null)]
  ];
  const fetchImpl = async input => {
    const url = new URL(input), page = Number(url.searchParams.get('page'));
    calls.push(url);
    return Response.json([{ page, pages: 2, per_page: 1000, total: 5, sourceid: '15', lastupdated: '2026-09-08' }, pages[page - 1]]);
  };
  const result = await fetchWorldBankGemMonthlyCpi({ fetchImpl, countries: ['CHN', 'RUS'], now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get('source'), '15');
  assert.equal(calls[0].searchParams.get('date'), '2014M01:2026M12');
  assert.equal(result.byCountry.CHN[0].period, '2015-01');
  assert.equal(result.byCountry.CHN[0].value, 10);
  assert.equal(result.byCountry.RUS[0].value, 5);
  assert.equal(result.byCountry.RUS[0].source.publisher, 'World Bank Global Economic Monitor');
  assert.equal(result.byCountry.RUS[0].source.updatedAt, '2026-09-08');
  assert.match(result.byCountry.RUS[0].measure, /not seasonally adjusted/i);
  await assert.rejects(fetchWorldBankGemMonthlyCpi({ countries: ['CHN'], now: new Date('2026-11-03T00:00:00Z'), fetchImpl: async () => Response.json([{ page: 1, pages: 1, total: 1, sourceid: '17', lastupdated: '2026-09-08' }, [row('CHN', '2015M01', 100)]]) }), /pagination/);
});

test('Argentina adapter verifies the national INDEC series metadata and derives year-on-year CPI', async () => {
  const periods = monthRange(2016, 12, 36);
  const payload = {
    count: periods.length,
    meta: [
      { frequency: 'month', start_date: '2016-12-01', end_date: '2019-11-01' },
      { dataset: { title: 'Índice de Precios al Consumidor Nacional (IPC). Base diciembre 2016.', source: 'Instituto Nacional de Estadística y Censos (INDEC)' }, field: { id: '148.3_INIVELNAL_DICI_M_26', description: 'IPC. Nivel General Nacional. Base dic 2016. Mensual.' } }
    ],
    data: periods.map((period, i) => [`${period}-01`, 100 + i])
  };
  const history = await fetchArgentinaMonthlyCpi({ fetchImpl: jsonFetch(payload), now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(history[0].period, '2017-12');
  assert.equal(history[0].value, 12);
  assert.match(history[0].source.publisher, /INDEC/);
  await assert.rejects(fetchArgentinaMonthlyCpi({ fetchImpl: jsonFetch({ ...payload, meta: [{ frequency: 'year' }, payload.meta[1]] }) }), /unexpected_series/);
});

test('ABS adapter preserves Australia CPI as a separate quarterly, seasonally adjusted series', async () => {
  const periods = Array.from({ length: 32 }, (_, i) => {
    const index = 2014 * 4 + i, year = Math.floor(index / 4), quarter = index % 4 + 1;
    return `${year}-Q${quarter}`;
  });
  const csv = ['DATAFLOW,MEASURE,INDEX,TSEST,REGION,FREQ,TIME_PERIOD,OBS_VALUE,UNIT_MEASURE,OBS_STATUS,DECIMALS,OBS_COMMENT',
    ...periods.map((period, i) => `ABS:CPI_Q(1.0.0),1,999901,20,50,Q,${period},${100 + i},IN,,,`)].join('\r\n');
  const fetchImpl = async (input, options) => {
    assert.match(String(input), /CPI_Q\/1\.999901\.20\.50\.Q/);
    assert.equal(options.redirect, 'manual');
    return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
  };
  const history = await fetchAustraliaQuarterlyCpi({ fetchImpl, now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(history[0].period, '2015-Q1');
  assert.equal(history[0].frequency, 'quarterly');
  assert.equal(history[0].value, 4);
  assert.match(history[0].measure, /seasonally adjusted/i);
  assert.equal(history.at(-1).period, '2021-Q4');
  await assert.rejects(fetchAustraliaQuarterlyCpi({ fetchImpl: async (_input, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://other.example.net/data.csv' } });
  } }), /upstream_http_302/);
});

test('monthly refresh tolerates one unavailable source without erasing other countries', async () => {
  const adapters = [
    { id: 'ok', countries: ['USA'], fetch: async () => [{ period: '2026-01', value: 2 }] },
    { id: 'down', countries: ['IND'], fetch: async () => { throw new Error('unavailable'); } }
  ];
  const result = await refreshMonthlyCpi({ adapters });
  assert.deepEqual(Object.keys(result.byCountry), ['USA']);
  assert.equal(result.statuses[0].status, 'updated');
  assert.equal(result.statuses[1].status, 'failed');
  assert.equal(result.successfulSources, 1);
});

test('monthly refresh records partial multi-country coverage and keeps quarterly data separate', async () => {
  const result = await refreshMonthlyCpi({ adapters: [
    { id: 'multi', countries: ['CHN', 'ARG'], fetch: async () => ({ byCountry: { CHN: [{ period: '2015-01', value: 2 }] }, sourceUpdated: '2026-09-08' }) },
    { id: 'quarterly', countries: ['AUS'], frequency: 'quarterly', fetch: async () => [{ period: '2015-Q1', value: 2 }] }
  ] });
  assert.deepEqual(Object.keys(result.byCountry), ['CHN']);
  assert.deepEqual(Object.keys(result.quarterlyByCountry), ['AUS']);
  assert.equal(result.statuses[0].status, 'partial');
  assert.equal(result.statuses[0].sourceUpdated, '2026-09-08');
  assert.equal(result.successfulSources, 2);
  assert.equal(result.successfulCountries, 2);
});

test('direct Statistics Canada history takes precedence over the World Bank fallback', async () => {
  const direct = [{ period: '2026-07', value: 2.1, source: { publisher: 'Statistics Canada', url: 'https://www.statcan.gc.ca/cpi' } }];
  const fallback = [{ period: '2026-07', value: 2.4, source: { publisher: 'World Bank Global Economic Monitor', url: 'https://api.worldbank.org/v2/indicator/CPTOTNSXN?source=15' } }];
  const result = await refreshMonthlyCpi({ adapters: [
    { id: 'canada', countries: ['CAN'], fetch: async () => direct },
    { id: 'world-bank-gem', countries: ['CAN', 'CHN'], fetch: async () => ({ byCountry: { CAN: fallback, CHN: fallback } }) }
  ] });
  assert.equal(result.byCountry.CAN[0].source.publisher, 'Statistics Canada');
  assert.equal(result.byCountry.CHN[0].source.publisher, 'World Bank Global Economic Monitor');
});
