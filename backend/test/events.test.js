import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { storeArticles } from '../src/content.js';
import { normalizeTrackingText, validateEventTracking, matchEventTracking, syncEventTracking, linkArticlesToEvents, linkRecentArticles, handleEventCoverage } from '../src/events.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) { return { sql, args: [], bind(...args) { return { ...this, args }; }, async all() { return { results: sqlite.prepare(this.sql).all(...this.args).map(row => ({ ...row })) }; }, async first() { const row = sqlite.prepare(this.sql).get(...this.args); return row ? { ...row } : null; }, async run() { return { success: true, meta: { changes: Number(sqlite.prepare(this.sql).run(...this.args).changes) } }; } }; },
    async batch(statements) { sqlite.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }
  };
  return { DB, sqlite };
}
const now = () => new Date();
const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const tracking = rules => ({ version: 1, enabled: true, rules });
const aiRules = tracking([{ all: ['Air India'], any: ['AI171', 'AI-171', 'flight 171', 'Ahmedabad crash'], none: ['share price'] }]);
const article = (id, title, patch = {}) => ({ id, title, summary: 'Source headline metadata.', category: 'Health', region: 'Asia', keywords: [], publishedAt: ago(1), source: { publisher: 'Publisher One', url: 'https://www.publicnews.org/' + id, sourceType: 'News report', basis: 'headline' }, officialSources: [], ...patch });
async function event(env, id, rules = aiRules) {
  await env.DB.prepare('INSERT INTO event_payloads (id,title,category,region,coverage_end,updated_at,payload_json,content_hash) VALUES (?,?,?,?,?,?,?,?)').bind(id, id, 'Public safety', 'Asia', ago(1).slice(0, 10), ago(0), JSON.stringify({ id, title: id, milestones: [] }), 'fixture').run();
  await syncEventTracking(env, [{ id, tracking: rules }]);
}
const get = async (env, path) => { const response = await handleEventCoverage(new Request('https://threadnews.example.org' + path), env); return { status: response.status, data: await response.json() }; };

test('event matching requires bounded specific anchors, context and complete phrase boundaries', () => {
  assert.equal(normalizeTrackingText('Mumbai–Ahmedābād: High-Speed Rail'), 'mumbai ahmedabad high speed rail');
  assert(matchEventTracking({ title: 'Air India AI-171 investigation reaches a new stage' }, aiRules));
  assert.equal(matchEventTracking({ title: 'Air India share price rises after AI171 story' }, aiRules), null);
  assert.equal(matchEventTracking({ title: 'Other airline investigation', keywords: ['Air India share price'] }, aiRules), null);
  assert.equal(matchEventTracking({ title: 'Air Indian AI1710 flight' }, aiRules), null);
  assert.equal(matchEventTracking({ title: 'Air India launches a new route' }, aiRules), null);
  assert.throws(() => validateEventTracking(tracking([{ all: ['India', 'war'] }])), /specific event anchor/);
  assert.throws(() => validateEventTracking(tracking([{ all: ['.*'] }])), /phrase/);
  assert.throws(() => validateEventTracking(tracking([{ all: ['AI171'], none: ['ai171'] }])), /Contradictory/);
  assert.throws(() => validateEventTracking({ rules: Array.from({ length: 9 }, () => ({ all: ['hormuz'] })) }), /eight rules/);
  assert.equal(matchEventTracking({ title: 'Air India AI171 investigation' }, { ...aiRules, enabled: false }), null);
});

test('persisted definitions link source metadata separately from reviewed milestone documents', async () => {
  const env = database(); await event(env, 'air-india-171');
  const item = article('investigation', 'Air India AI171 investigation update');
  await storeArticles(env, [item], 'source-feed', 'automatic');
  const result = await linkArticlesToEvents(env, [item]); assert.equal(result.linked, 1);
  const read = await get(env, '/api/events/air-india-171/coverage'); assert.equal(read.status, 200); assert.equal(read.data.coverage.length, 1);
  assert.equal(read.data.coverage[0].source.publisher, 'Publisher One'); assert.equal(read.data.coverage[0].verification, 'not-reviewed');
  assert.equal(read.data.coverage[0].matchedBy.type, 'rule-match');
  assert.deepEqual(JSON.parse(env.sqlite.prepare('SELECT payload_json FROM event_payloads').get().payload_json).milestones, []);
  assert.equal(env.sqlite.prepare('SELECT event_id FROM news').get().event_id, 'air-india-171');
  env.sqlite.prepare('DELETE FROM news').run();
  assert.equal((await get(env, '/api/events/air-india-171/coverage')).data.coverage.length, 1, 'current-news expiry must preserve the coverage snapshot');
});

test('canonical deduplication retains original attribution and records changed headline metadata', async () => {
  const env = database(); await event(env, 'air-india-171');
  const item = article('investigation', 'Air India AI171 investigation update');
  await storeArticles(env, [item], 'source-feed', 'automatic');
  await linkArticlesToEvents(env, [item]); await linkArticlesToEvents(env, [item]);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM event_coverage').get().n, 1);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM event_coverage_revisions').get().n, 0);
  const changed = { ...item, title: 'Air India AI171 investigation: correction to source headline' };
  await storeArticles(env, [changed], 'source-feed', 'automatic');
  // Raw call arguments cannot overwrite the attribution in the validated store.
  await linkArticlesToEvents(env, [{ ...changed, source: { ...item.source, publisher: 'Impersonator' } }]);
  const list = (await get(env, '/api/events/air-india-171/coverage')).data;
  assert.equal(list.coverage[0].source.publisher, 'Publisher One'); assert.equal(list.coverage[0].revisionCount, 1);
  const revision = await get(env, '/api/events/air-india-171/coverage/' + list.coverage[0].id + '/revisions');
  assert.equal(revision.data.revisions[0].coverage.title, item.title);
});

test('ambiguous rule matches are skipped while an explicit editor event link takes priority', async () => {
  const env = database(); await event(env, 'one'); await event(env, 'two');
  const item = article('ambiguous', 'Air India AI171 investigation update');
  await storeArticles(env, [item], 'source-feed', 'automatic');
  const result = await linkArticlesToEvents(env, [item]); assert.equal(result.ambiguous, 1); assert.equal(result.linked, 0);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM event_coverage').get().n, 0);
  const curated = article('curated', 'An editor-selected investigation source', { eventId: 'two' });
  await storeArticles(env, [curated], 'reviewed', 'curated');
  await linkArticlesToEvents(env, [curated]);
  assert.equal((await get(env, '/api/events/two/coverage')).data.coverage[0].matchedBy.type, 'editor-linked');
});

test('event import reconciliation and cursor pagination are stable and remain event scoped', async () => {
  const env = database(), items = ['one', 'two', 'three'].map(id => article(id, 'Air India AI171 investigation ' + id));
  await storeArticles(env, items, 'feed', 'automatic'); await event(env, 'air-india-171'); await event(env, 'other', tracking([{ all: ['hormuz'] }]));
  await linkRecentArticles(env);
  const first = await get(env, '/api/events/air-india-171/coverage?limit=1'); assert.equal(first.data.meta.total, 3); assert(first.data.meta.hasMore);
  const second = await get(env, '/api/events/air-india-171/coverage?limit=2&cursor=' + first.data.meta.nextCursor);
  assert.equal(second.data.coverage.length, 2); assert.equal(second.data.meta.hasMore, false);
  assert.equal(new Set([first.data.coverage[0].id, ...second.data.coverage.map(row => row.id)]).size, 3);
  assert.equal((await get(env, '/api/events/other/coverage?cursor=' + first.data.meta.nextCursor)).status, 400);
  assert.equal((await get(env, '/api/events/air-india-171/coverage?cursor=broken')).status, 400);
  assert.equal((await get(env, '/api/events/air-india-171/coverage?limit=1000')).status, 400);
  assert.equal((await get(env, '/api/events/missing/coverage')).status, 404);
  assert.equal(await handleEventCoverage(new Request('https://threadnews.example.org/api/events/air-india-171'), env), null);
  assert.equal((await handleEventCoverage(new Request('https://threadnews.example.org/api/events/air-india-171/coverage', { method: 'POST' }), env)).status, 405);
  assert.equal((await get({}, '/api/events/air-india-171/coverage')).status, 503);
});

test('disabling tracking takes effect without deleting prior coverage history', async () => {
  const env = database(); await event(env, 'air-india-171');
  const first = article('first', 'Air India AI171 investigation update');
  await storeArticles(env, [first], 'feed', 'automatic'); await linkArticlesToEvents(env, [first]);
  await syncEventTracking(env, [{ id: 'air-india-171' }]);
  const second = article('second', 'Air India AI171 new report');
  await storeArticles(env, [second], 'feed', 'automatic'); await linkArticlesToEvents(env, [second]);
  assert.equal((await get(env, '/api/events/air-india-171/coverage')).data.coverage.length, 1);
  env.sqlite.prepare("DELETE FROM event_payloads WHERE id='air-india-171'").run();
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM event_coverage').get().n, 0);
});

test('recent coverage uses publication dates and scoped cursors cannot change its period', async () => {
  const env = database(); await event(env, 'air-india-171');
  const items = [article('old', 'Air India AI171 older report', { publishedAt: ago(100) }), article('fresh-one', 'Air India AI171 current report'), article('fresh-two', 'Air India AI171 another current report')];
  await storeArticles(env, items, 'source-feed', 'automatic'); await linkArticlesToEvents(env, items);
  const since = ago(60).slice(0, 10), first = await get(env, '/api/events/air-india-171/coverage?limit=1&since=' + since);
  assert.equal(first.data.meta.total, 2); assert.equal(first.data.meta.since, since);
  assert.equal((await get(env, '/api/events/air-india-171/coverage')).data.meta.total, 3);
  const next = await get(env, '/api/events/air-india-171/coverage?limit=1&since=' + since + '&cursor=' + first.data.meta.nextCursor);
  assert.equal(next.status, 200); assert.equal(next.data.coverage.length, 1);
  assert.equal((await get(env, '/api/events/air-india-171/coverage?cursor=' + first.data.meta.nextCursor)).status, 400);
  assert.equal((await get(env, '/api/events/air-india-171/coverage?since=2026-02-30')).status, 400);
  assert.equal((await get(env, '/api/events/air-india-171/coverage?since=2099-01-01')).status, 400);
});
