import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/worker.js';
import { sha256 } from '../src/feed.js';
import planConfig from '../../config/plans.json' with { type: 'json' };
import { retrieveStoryChanges } from '../src/ai-evidence.js';
import { validateClaims } from '../src/ai-provider.js';
import { refreshSourceSummaries } from '../src/source-summary.js';
import { storeArticles } from '../src/content.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const DB = {
    prepare(query) {
      return {
        query,
        args: [],
        bind(...args) { return { ...this, args }; },
        async first() { return sqlite.prepare(this.query).get(...this.args) || null; },
        async all() { return { results: sqlite.prepare(this.query).all(...this.args).map(row => ({ ...row })) }; },
        async run() { return { success: true, meta: { changes: Number(sqlite.prepare(this.query).run(...this.args).changes) } }; }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return { sqlite, DB };
}

test('original releases are read and stored before the reader requests a summary; feed repeats keep the upgrade', async () => {
  const { DB, sqlite } = database();
  const now = new Date();
  const env = { DB, AI: {}, APP_ORIGIN:'https://threadnews.online' };
  const title = 'Government updates its electricity plans';
  const article = { id:'fixture-uk-release', title, category:'Energy', publishedAt:now.toISOString(), digestBasis:'headline-only',
    source:{ publisher:'UK Department for Energy Security and Net Zero', basis:'headline', sourceType:'Official source', url:'https://www.gov.uk/government/news/clean-power' } };
  await storeArticles(env,[article],'uk-energy','automatic',{now});
  const seen = [];
  const result = await refreshSourceSummaries(env,{now,fetchImpl:async (input, options) => {
    const url = new URL(input); seen.push(url.pathname);
    assert.equal(options.headers.authorization,undefined);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
    return new Response(`<main><p>Unrelated navigation and site text that should not be treated as the content of an energy policy release.</p><div class="govspeak">
      <p>The energy department opened a consultation on a proposed electricity grid investment programme intended to improve reliability in rural communities.</p>
      <p>Network operators can respond in writing to the public consultation. The department has not approved the proposal and will consider submissions before a decision. It also asked local councils to describe recent outages and to estimate how often they interrupted public services in their areas.</p></div></main>`,{headers:{'content-type':'text/html'}});
  },generate:async (_env, _prompt, evidence) => {
    assert.equal(evidence.length,2);
    assert.ok(evidence[0].excerpt.includes('rural communities'));
    return {claims:[{text:'The energy department is seeking feedback on proposed grid investment to improve reliability in rural areas. Officials have yet to approve the plan.'}]};
  }});
  assert.equal(result.published,1,JSON.stringify(result.statuses));
  assert.deepEqual(seen,['/robots.txt','/government/news/clean-power']);
  await storeArticles(env,[article],'uk-energy','automatic',{now});
  const stored = sqlite.prepare('SELECT summary,metadata_json,source_json FROM news WHERE id=?').get(article.id);
  assert.match(stored.summary,/rural areas/);
  assert.equal(JSON.parse(stored.metadata_json).digestBasis,'source-summary');
  assert.equal(JSON.parse(stored.source_json).summaryMethod,'original-source-paraphrase');
  assert.equal((await refreshSourceSummaries(env,{now})).attempted,0);
});

async function seedRecords({ sqlite, DB }, { paid = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const eventId = 'coverage-policy-test';
  await DB.prepare(`INSERT INTO event_payloads
    (id,title,category,region,coverage_end,updated_at,payload_json,content_hash)
    VALUES (?,?,?,?,?,?,?,?)`).bind(
      eventId, 'Coverage policy test', 'World', 'Everywhere', new Date().toISOString().slice(0, 10),
      new Date().toISOString(), JSON.stringify({ id: eventId, title: 'Coverage policy test', milestones: [] }), 'event-fixture'
    ).run();
  const recentId = 'coverage-' + 'a'.repeat(40), oldId = 'coverage-' + 'b'.repeat(40);
  const recentDate = new Date(Date.now() - 86400000).toISOString();
  const oldDate = new Date(Date.now() - 20 * 86400000).toISOString();
  for (const [id, publishedAt, title] of [[recentId, recentDate, 'Recent source headline'], [oldId, oldDate, 'Older source headline']]) {
    const payload = JSON.stringify({ title, publishedAt, source: { publisher: 'Fixture publisher' }, verification: 'not-reviewed' });
    await DB.prepare(`INSERT INTO event_coverage
      (id,event_id,source_url,news_id,published_at,first_seen_at,last_seen_at,payload_json,content_hash)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, eventId, `https://publisher.example/${id}`, `news-${title.startsWith('Recent') ? 'recent' : 'old'}`,
      publishedAt, publishedAt, publishedAt, payload, title).run();
  }
  await DB.prepare(`INSERT INTO event_coverage_revisions (coverage_id,recorded_at,content_hash,payload_json)
    VALUES (?,?,?,?)`).bind(oldId, oldDate, 'old-revision', JSON.stringify({ title: 'Earlier headline version' })).run();

  const token = 'session-token-for-worker-test-1234567890';
  const userId = paid ? 'paid-reader' : 'free-reader';
  await DB.prepare('INSERT INTO users (id,provider,provider_subject,name,email,created_at) VALUES (?,?,?,?,?,?)')
    .bind(userId, 'google', 'subject-' + userId, 'Reader', `${userId}@example.test`, now).run();
  await DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)')
    .bind(await sha256(token), userId, now + 3600).run();
  if (paid) {
    await DB.prepare(`INSERT INTO billing_subscriptions
      (user_id,checkout_kind,plan_key,status,last_payment_at,created_at,updated_at)
      VALUES (?,'subscription','annual','ACTIVE',?,?,?)`).bind(userId, now - 60, now - 60, now - 60).run();
  }
  const env = { DB, APP_ORIGIN: 'https://threadnews.online', NEWS_STORAGE: 'd1', NEWS_FEED_DAYS: '4' };
  return { env, eventId, oldId, recentId, token, sqlite };
}

async function get(env, path, token) {
  const request = new Request('https://threadnews.online' + path, {
    headers: token ? { cookie: `__Host-threadline-session=${token}` } : {}
  });
  const response = await worker.fetch(request, env, {});
  return { status: response.status, headers: response.headers, data: await response.json() };
}

test('anonymous readers receive full historical coverage during the free launch window', async () => {
  const fixture = database(), seeded = await seedRecords(fixture);
  const recent = await get(seeded.env, `/api/events/${seeded.eventId}/coverage`);
  assert.equal(recent.status, 200);
  assert.equal(recent.data.coverage.length, 2);
  assert.match(recent.data.coverage[0].title, /Recent/);
  assert.equal(recent.data.meta.total, 2);
  assert.equal((await get(seeded.env, `/api/events/${seeded.eventId}/coverage?since=2026-01-01`)).status, 200);
  assert.equal((await get(seeded.env, `/api/events/${seeded.eventId}/coverage/${seeded.oldId}/revisions`)).status, 200);
});

test('signed-in free readers also receive full historical coverage during the free window', async () => {
  const fixture = database(), seeded = await seedRecords(fixture);
  const recent = await get(seeded.env, `/api/events/${seeded.eventId}/coverage`, seeded.token);
  assert.equal(recent.status, 200);
  assert.equal(recent.data.coverage.length, 2);
  const oldSince = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  assert.equal((await get(seeded.env, `/api/events/${seeded.eventId}/coverage?since=${oldSince}`, seeded.token)).status, 200);
  assert.equal((await get(seeded.env, `/api/events/${seeded.eventId}/coverage/${seeded.oldId}/revisions`, seeded.token)).status, 200);
});

test('verified paid readers can request historical coverage and revision records', async () => {
  const fixture = database(), seeded = await seedRecords(fixture, { paid: true });
  const oldSince = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const history = await get(seeded.env, `/api/events/${seeded.eventId}/coverage?since=${oldSince}`, seeded.token);
  assert.equal(history.status, 200);
  assert.equal(history.data.coverage.length, 2);
  const revisions = await get(seeded.env, `/api/events/${seeded.eventId}/coverage/${seeded.oldId}/revisions`, seeded.token);
  assert.equal(revisions.status, 200);
  assert.equal(revisions.data.revisions[0].coverage.title, 'Earlier headline version');
});

test('coverage responses bypass the shared Cache API', async () => {
  const fixture = database(), seeded = await seedRecords(fixture, { paid: true });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  let cacheCalls = 0;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    async match() { cacheCalls++; return null; },
    async put() { cacheCalls++; }
  } } });
  try {
    const response = await get(seeded.env, `/api/events/${seeded.eventId}/coverage`, seeded.token);
    assert.equal(response.status, 200);
    assert.equal(cacheCalls, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'caches', previous);
    else delete globalThis.caches;
  }
});

test('event details are fully open to all readers during the free launch window', async () => {
  const fixture = database(), seeded = await seedRecords(fixture, { paid: true });
  const milestones = Array.from({ length: 12 }, (_, index) => ({
    date: `2020-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
    dateType: 'event', title: `Documented milestone ${index + 1}`, summary: 'Attributed timeline fixture.', sources: []
  }));
  await seeded.env.DB.prepare('UPDATE event_payloads SET payload_json=?,content_hash=? WHERE id=?')
    .bind(JSON.stringify({ id: seeded.eventId, title: 'Coverage policy test', milestones }), 'long-timeline-fixture', seeded.eventId).run();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  let cacheCalls = 0;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    async match() { cacheCalls++; return null; },
    async put() { cacheCalls++; }
  } } });
  try {
    const guest = await get(seeded.env, `/api/events/${seeded.eventId}`);
    assert.equal(guest.status, 200);
    assert.equal(guest.data.event.milestones.length, 12);
    assert.equal(guest.data.event.previewTruncated, undefined);

    const paid = await get(seeded.env, `/api/events/${seeded.eventId}`, seeded.token);
    assert.equal(paid.status, 200);
    assert.equal(paid.data.event.milestones.length, 12);
    assert.equal(paid.data.event.previewTruncated, undefined);
    assert.equal(cacheCalls, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'caches', previous);
    else delete globalThis.caches;
  }
});

test('after the free window, configured live billing limits unpaid readers to previews and recent coverage', async () => {
  const realNow = Date.now;
  Date.now = () => Date.parse(planConfig.billing.billingStartsAt) + 1000;
  try {
    const fixture = database(), seeded = await seedRecords(fixture);
    Object.assign(seeded.env, {
      BILLING_ENABLED: 'true',
      PAYPAL_ENV: 'live',
      TERMS_PUBLISHED:'true',TERMS_VERSION:'fixture-v1',LEGAL_SELLER_NAME:'Fixture Seller',LEGAL_SELLER_TYPE:'individual',LEGAL_SELLER_ADDRESS:'Fixture address',LEGAL_SELLER_COUNTRY:'India',REFUND_WINDOW_DAYS:'14',
      PAYPAL_CLIENT_ID: 'live-client-fixture',
      PAYPAL_CLIENT_SECRET: 'live-secret-fixture',
      PAYPAL_WEBHOOK_ID: 'WH-LIVE-FIXTURE',
      PAYPAL_SUBSCRIPTIONS_ACCESS: 'true',
      PAYPAL_PLAN_MONTHLY_ID: 'P-LIVE-MONTHLY',
      PAYPAL_PLAN_ANNUAL_ID: 'P-LIVE-ANNUAL'
    });
    const milestones = Array.from({ length: 12 }, (_, index) => ({
      date: `2020-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
      dateType: 'event', title: `Post-launch milestone ${index + 1}`, summary: 'Attributed timeline fixture.', sources: []
    }));
    await seeded.env.DB.prepare('UPDATE event_payloads SET payload_json=?,content_hash=? WHERE id=?')
      .bind(JSON.stringify({ id: seeded.eventId, title: 'Coverage policy test', milestones }), 'post-launch-timeline-fixture', seeded.eventId).run();
    const guest = await get(seeded.env, `/api/events/${seeded.eventId}`);
    assert.equal(guest.data.event.milestones.length, 10);
    assert.equal(guest.data.event.previewTruncated, true);
    assert.equal((await get(seeded.env, `/api/events/${seeded.eventId}/coverage?since=2026-01-01`)).status, 403);
    assert.equal((await get(seeded.env, `/api/events/${seeded.eventId}/coverage/${seeded.oldId}/revisions`)).status, 403);
  } finally { Date.now = realNow; }
});

test('timeline catch-up separates earlier context from new evidence and excludes retracted or expired reporting', async () => {
  const { sqlite, DB } = database();
  const now = new Date('2026-11-14T10:00:00Z');
  const source = { publisher: 'Fixture publisher', url: 'https://publisher.example/report', basis: 'article' };
  const event = { id: 'fixture', title: 'Fixture timeline', coverageEnd: '2026-10-15',
    milestones: [
      { date: '2026-09-03', title: 'Earlier baseline', summary: 'A dated baseline.', sources: [source] },
      { date: '2026-10-15', title: 'Reviewed change', summary: 'A reviewed milestone.', sources: [source] }
    ]
  };
  sqlite.prepare('INSERT INTO event_payloads (id,title,category,region,coverage_end,updated_at,payload_json,content_hash) VALUES (?,?,?,?,?,?,?,?)')
    .run(event.id, event.title, 'Infrastructure', 'Global', event.coverageEnd, now.toISOString(), JSON.stringify(event), 'fixture');
  const insert = sqlite.prepare(`INSERT INTO news
    (id,canonical_url,title,original_headline,summary,category,region,published_at,ingested_at,source_json,metadata_json,event_id,feed_id)
    VALUES (?,?,?,?,'Reporting excerpt','Infrastructure','Global',?,?,?,?,?,'fixture')`);
  for (const [id, date, hidden, eventId] of [
    ['visible', '2026-11-13', false, 'fixture'],
    ['retracted', '2026-11-13', true, 'fixture'],
    ['expired', '2026-11-02', false, 'fixture'],
    ['other-event', '2026-11-13', false, 'unrelated']
  ]) {
    insert.run(id, source.url + '/' + id, id, id, date + 'T12:00:00.000Z', now.toISOString(),
      JSON.stringify(source), JSON.stringify({ editorialExcluded: hidden }), eventId);
  }
  const result = await retrieveStoryChanges({ DB }, event.id, 30, now);
  assert.equal(result.since, '2026-10-16');
  assert.deepEqual(result.evidence.map(item => [item.title, item.role]), [['Reviewed change', 'baseline'], ['visible', 'report']]);
  assert.deepEqual(result.counts, { milestones: 0, linkedReports: 1 });
});

test('catch-up AI rejects baseline-only claims and numbers absent from cited records', () => {
  const evidence = [
    { id: 1, role: 'baseline', excerpt: 'The old target was 2024.' },
    { id: 2, role: 'milestone', excerpt: 'The agency opened 1,200 metres in Oct 2026.' }
  ];
  const good = { text: 'The agency opened 1200 metres in 2026.', citations: [2] };
  assert.deepEqual(validateClaims({ claims: [
    good,
    { text: 'The target was 2024.', citations: [1] },
    { text: 'The agency opened 1600 metres in 2026.', citations: [2] }
  ] }, evidence, true), [good]);
  assert.equal(validateClaims({ claims: [{ ...good, citations: [3] }] }, evidence, true), null);
});
