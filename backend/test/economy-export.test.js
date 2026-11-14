import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../../web/economy-metrics.js';

const metrics = globalThis.ThreadNewsEconomyMetrics;
const firstSource = { publisher: 'Statistics Office A', dataset: 'CPI index A', url: 'https://statistics.example/a', updatedAt: '2026-10-20', measure: 'National CPI, year-on-year' };
const laterSource = { publisher: 'Statistics Office B', dataset: 'CPI index B', url: 'https://statistics.example/b', retrievedAt: '2026-11-01', measure: 'HICP, year-on-year' };
const country = { iso3: 'IND', name: 'Example economy',
  gdpGrowth: [{ year: 2024, value: -1.2 }, { year: 2025, value: null }],
  inflation: [{ year: 2024, value: 2.5 }], gdpGrowthSource: { publisher: 'World Bank', dataset: 'WDI', url: 'https://api.worldbank.org/gdp', updated: '2026-10-08' },
  monthlyCpiHistory: [{ period: '2026-08', value: 2, sourceId: 0 }, { period: '2026-09', value: 2.1, releaseDate: '2026-10-20' }],
  monthlyCpiHistorySource: laterSource, monthlyCpiHistorySources: [firstSource, laterSource],
  quarterlyCpiHistory: [{ period: '2026-Q3', value: 1.5 }], quarterlyCpiHistorySource: firstSource };

test('economic exports preserve frequency, source switches, vintages and missing observations', () => {
  const rows = metrics.observationRows([country]);
  const objects = rows.slice(1).map(row => Object.fromEntries(rows[0].map((key, index) => [key, row[index]])));
  assert.equal(objects.find(row => row.period === '2025').value, '');
  assert.equal(objects.find(row => row.period === '2025').observation_status, 'not_reported');
  assert.equal(objects.find(row => row.period === '2024' && row.indicator === 'Real GDP growth').value, -1.2);
  assert.equal(objects.find(row => row.period === '2026-08').publisher, firstSource.publisher);
  assert.equal(objects.find(row => row.period === '2026-08').source_updated_at, firstSource.updatedAt);
  assert.equal(objects.find(row => row.period === '2026-09').publisher, laterSource.publisher);
  assert.equal(objects.find(row => row.period === '2026-09').release_date, '2026-10-20');
  assert.equal(objects.find(row => row.period === '2026-Q3').frequency, 'quarterly');
});
test('coverage counts actual source-linked histories rather than a configured country count', () => {
  assert.deepEqual(metrics.coverage([country, { name: 'Missing', monthlyCpiHistory: [{ period: '2026-99', value: 2 }] }]), {
    countries: 2, monthlyCountries: 1, quarterlyCountries: 1
  });
});
test('CSV protects labels from spreadsheet formula execution while preserving numeric negative values', () => {
  const csv = metrics.csv([['country', 'value'], ['=WEBSERVICE("https://bad.example")', -1.2], ['Example, "quoted"', null]]);
  assert.ok(csv.includes('"\'=WEBSERVICE(""https://bad.example"")"'));
  assert.ok(csv.includes('"-1.2"'));
  assert.ok(csv.includes('"Example, ""quoted""",""'));
});
test('economy UI uses live coverage and exports all available series and metadata', async () => {
  const main = { innerHTML: '' }, downloads = [];
  const context = vm.createContext({ ECONOMY_SNAPSHOT: { countries: [country], meta: { sourceUpdated: '2026-10-08' } },
    ThreadNewsEconomyMetrics: metrics, Intl, Date, Blob, URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:fixture'; }, revokeObjectURL() {} },
    location: { pathname: '/economy' }, matchMedia: () => ({ matches: false }),
    window: { scrollY: 0, scrollTo() {} }, setTimeout() {},
    document: { querySelector(selector) { return selector === '#main' ? main : null; }, createElement() { return { click() {} }; } }
  });
  vm.runInContext(readFileSync(new URL('../../web/economy.js', import.meta.url), 'utf8'), context);
  const view = context.createEconomyView(); view.render();
  assert.match(main.innerHTML, /monthly history is stored for 1 countries and quarterly history for 1/);
  assert.ok(!main.innerHTML.includes('verified for seven countries'));
  view.handleAction(null, { dataset: { action: 'econ-export-history' } });
  const csv = await downloads[0].text();
  assert.match(csv, /2026-09/); assert.match(csv, /2026-Q3/); assert.match(csv, /Statistics Office B/);
  view.handleAction(null, { dataset: { action: 'econ-export-json' } });
  const json = JSON.parse(await downloads[1].text());
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.countries[0].monthlyCpiHistorySources[0].publisher, firstSource.publisher);
});
