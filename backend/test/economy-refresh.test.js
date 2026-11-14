import test from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMY_SOURCE_ADAPTERS, refreshEconomicSource } from '../src/economy-refresh.js';

function initialDocument() {
  const countryCode = index => `A${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`;
  return {
    countries: Array.from({ length: 19 }, (_, index) => ({ iso3: countryCode(index),
      monthlyCpiHistory: [], quarterlyCpiHistory: [], gdpGrowth: [], inflation: [] })),
    meta: { monthlyRefresh: { nationalSourcesChecked: false, sources: [] } }
  };
}

function fakeDb(document = initialDocument()) {
  const appState = new Map();
  const row = { id: 'economy', updated_at: '2026-11-01T00:00:00.000Z', payload_json: JSON.stringify(document), content_hash: 'initial-hash' };
  const db = {
    appState, row,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() {
          if (sql.startsWith('SELECT value FROM app_state')) return appState.has(args[0]) ? { value: appState.get(args[0]) } : null;
          if (sql.includes('RETURNING value')) {
            const [key, value, now] = args;
            const current = appState.get(key);
            if (current == null || Number.parseInt(current, 10) <= now) appState.set(key, value);
            return { value: appState.get(key) };
          }
          if (sql.includes("FROM content_documents WHERE id='economy'")) return { ...row };
          if (sql.startsWith('UPDATE content_documents')) {
            const [updatedAt, payload, hash, oldHash, oldUpdatedAt] = args;
            if (row.content_hash !== oldHash || row.updated_at !== oldUpdatedAt) return null;
            row.updated_at = updatedAt; row.payload_json = payload; row.content_hash = hash;
            return { id: 'economy' };
          }
          return null;
        },
        async run() {
          if (sql.startsWith('INSERT INTO app_state')) appState.set(args[0], args[1]);
          else if (sql.startsWith('DELETE FROM app_state')) {
            if (appState.get(args[0]) === args[1]) appState.delete(args[0]);
          }
          return { success: true };
        }
      };
    },
    async batch(statements) { for (const statement of statements) await statement.run(); return []; }
  };
  return db;
}

const at = new Date('2026-11-03T12:00:00.000Z');
const makeAdapter = (id, fetch) => ({ id, countries: ['AAA'], frequency: 'monthly', national: false, fetch });
const resultFor = (period = '2026-10') => ({
  byCountry: { AAA: [{ period, value: 4.2, frequency: 'monthly', measure: 'CPI, year-on-year', unit: 'percent', source: { publisher: 'Statistics Office', dataset: 'CPI', title: 'All-items CPI', measure: 'CPI, year-on-year', url: 'https://stats.example.org/cpi' } }] },
  quarterlyByCountry: {}, coveredCountries: ['AAA'], observations: 1
});

test('registry rotates through ten fixed adapter groups', () => {
  assert.equal(ECONOMY_SOURCE_ADAPTERS.length, 10);
  assert.equal(new Set(ECONOMY_SOURCE_ADAPTERS.flatMap(adapter => adapter.countries)).size, 19);
  assert.equal(ECONOMY_SOURCE_ADAPTERS.reduce((n, adapter) => n + adapter.countries.length, 0), 19);
  assert.equal(ECONOMY_SOURCE_ADAPTERS.find(adapter => adapter.id === 'australia-quarterly').frequency, 'quarterly');
});

test('failed source keeps the published economy document and advances the cursor', async () => {
  const DB = fakeDb(), original = DB.row.payload_json;
  const adapter = makeAdapter('source-a', async () => { throw Object.assign(new Error('offline'), { code: 'upstream_fetch_failed' }); });
  const result = await refreshEconomicSource({ DB }, { now: at, adapters: [adapter] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream_fetch_failed');
  assert.equal(DB.row.payload_json, original);
  assert.equal(DB.appState.get('economy_source_refresh_cursor'), '0');
  const progress = JSON.parse(DB.appState.get('economy_source_refresh_status'));
  assert.equal(progress.sources['source-a'].status, 'failed');
  assert.equal(progress.sources['source-a'].lastSuccessAt, null);
});

test('successful source merges history without deleting earlier observations', async () => {
  const document = initialDocument();
  document.countries[0].monthlyCpiHistory = [
    { period: '2026-09', value: 3.8, frequency: 'monthly', sourceId: 0 }
  ];
  document.countries[0].monthlyCpiHistorySource = { publisher: 'Statistics Office', dataset: 'CPI', title: 'All-items CPI', measure: 'CPI, year-on-year', url: 'https://stats.example.org/cpi' };
  const DB = fakeDb(document);
  const result = await refreshEconomicSource({ DB }, { now: at, adapters: [makeAdapter('source-a', async () => resultFor())] });
  assert.equal(result.ok, true);
  const published = JSON.parse(DB.row.payload_json);
  assert.deepEqual(published.countries[0].monthlyCpiHistory.map(point => point.period), ['2026-09', '2026-10']);
  assert.equal(published.countries[0].latestInflation.value, 4.2);
  assert.equal(published.meta.monthlyRefresh.lastSourceCheckAt, at.toISOString());
});

test('concurrent scheduled calls acquire only one source lease', async () => {
  const DB = fakeDb();
  let starts = 0, finish, markStarted;
  const gate = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const adapter = makeAdapter('source-a', async () => { starts++; markStarted(); await gate; return resultFor(); });
  const first = refreshEconomicSource({ DB }, { now: at, adapters: [adapter] });
  const second = refreshEconomicSource({ DB }, { now: at, adapters: [adapter] });
  const secondResult = await second;
  assert.ok(['another_refresh_running', 'not_due'].includes(secondResult.skipped));
  await started;
  assert.equal(starts, 1);
  finish();
  assert.equal((await first).ok, true);
});

test('compare-and-swap preserves a newer import made during an upstream fetch', async () => {
  const DB = fakeDb();
  const adapter = makeAdapter('source-a', async () => {
    DB.row.updated_at = '2026-11-03T12:01:00.000Z';
    DB.row.content_hash = 'newer-import-hash';
    DB.row.payload_json = JSON.stringify({ ...initialDocument(), newerImport: true });
    return resultFor();
  });
  const result = await refreshEconomicSource({ DB }, { now: at, adapters: [adapter] });
  assert.equal(result.reason, 'economy_document_changed_during_refresh');
  assert.equal(JSON.parse(DB.row.payload_json).newerImport, true);
});
