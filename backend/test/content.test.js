import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleContent, storeArticles, importEvents, importEconomy, cleanupContent, contentUrl } from '../src/content.js';
import { importBatches } from '../scripts/import-content.mjs';
import { parseFeed } from '../src/feed.js';

// Execute the real SQL against SQLite; this adapter mirrors the small D1 surface
// used by the content module, including atomic batch rollback and FK cascades.
function database({ legacy = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  if (legacy) sqlite.prepare('INSERT INTO news (id,canonical_url,title,original_headline,summary,category,region,keywords,published_at,ingested_at,source_json,feed_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy', 'https://news.example.com/legacy', 'Old headline', 'Old headline', '', 'Politics', 'Europe', '', ago(1), ago(1), JSON.stringify({ publisher: 'Example News', url: 'https://news.example.com/legacy', basis: 'headline' }), 'old-feed');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(file => file.endsWith('.sql') && file !== '0001_init.sql').sort()) sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  let queries = 0;
  const DB = {
    prepare(sql) {
      const statement = { sql, args: [], bind(...args) { return { ...this, args }; },
        async all() { queries++; return { results: sqlite.prepare(this.sql).all(...this.args).map(x => ({ ...x })) }; },
        async first() { queries++; const row = sqlite.prepare(this.sql).get(...this.args); return row ? { ...row } : null; },
        async run() { queries++; return { success: true, meta: { changes: Number(sqlite.prepare(this.sql).run(...this.args).changes) } }; } };
      return statement;
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return { DB, sqlite, get queries() { return queries; } };
}
const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const fixture = (id, patch = {}) => ({ id, title: 'An attributed headline', originalHeadline: 'An attributed headline', summary: 'Headline metadata.', category: 'Politics', region: 'Europe', keywords: ['public policy'], publishedAt: ago(1), source: { publisher: 'Example News', url: 'https://news.example.com/' + id, sourceType: 'Reporting', basis: 'headline' }, officialSources: [], ...patch });
const request = (path, init) => new Request('https://threadline.example.com' + path, init);
const get = async (env, path, access = false) => {
  const response = await handleContent(request(path), env, {}, { canAccessArchive: access });
  return { response, data: await response.json() };
};
const event = () => ({ id: 'sample-event', title: 'A documented event', category: 'Politics', region: 'Europe', coverageEnd: ago(2).slice(0, 10), context: 'Full context survives import.', milestones: [{ date: ago(2).slice(0, 10), dateType: 'event', title: 'A significant development', summary: 'An attributed account.', kind: 'Official record', key: true, sources: [{ publisher: 'Agency', type: 'Official record', title: 'A release', published: ago(2).slice(0, 10), url: 'https://agency.example.com/release' }] }] });

test('the impact pool mixes recent categories and never accepts or needs reader attributes', async () => {
  const db = database(), env = { DB: db.DB, NEWS_FEED_DAYS: '4' };
  await storeArticles(env, [
    fixture('newest', { publishedAt: ago(1) }),
    fixture('next', { publishedAt: ago(2) }),
    fixture('other', { category: 'Health', region: 'India', publishedAt: ago(3) }),
    fixture('expired', { publishedAt: ago(5) })
  ], 'fixture', 'curated');
  const { data } = await get(env, '/api/news/impact');
  assert.deepEqual(data.articles.map(item => item.id), ['newest', 'other', 'next']);
  assert.ok(data.articles.every(item => item.summary === ''));
  assert.equal((await get(env, '/api/news/impact?region=India')).response.status, 400);
});

test('later automated headline refreshes preserve stronger reviewed text and its publication context while recording source lineage', async () => {
  const db = database(), env = { DB: db.DB };
  const reviewed = fixture('reviewed', { title: 'The reviewed account', summary: 'A source-reviewed brief.', digestBasis: 'article-reviewed', source: { publisher: 'Example News', url: 'https://news.example.com/reviewed', basis: 'article', sourceType: 'News report' } });
  await storeArticles(env, [reviewed], 'editorial', 'curated');
  const update = { ...reviewed, title: 'A changed feed headline', summary: 'Headline metadata.', digestBasis: 'headline-only', publishedAt: ago(0), source: { ...reviewed.source, basis: 'headline' } };
  await storeArticles(env, [update], 'incoming-rss', 'automatic');
  const stored = db.sqlite.prepare('SELECT title,summary,published_at,source_json,metadata_json FROM news').get();
  assert.equal(stored.title, reviewed.title); assert.equal(stored.summary, reviewed.summary); assert.equal(stored.published_at, reviewed.publishedAt);
  assert.equal(JSON.parse(stored.source_json).basis, 'article'); assert.equal(JSON.parse(stored.metadata_json).digestBasis, 'article-reviewed');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM article_revisions').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM article_source_lineage').get().n, 2);
  await storeArticles(env, [{ ...reviewed, summary: 'An explicit editorial correction.' }], 'editorial-correction', 'curated');
  assert.equal(db.sqlite.prepare('SELECT summary FROM news').get().summary, 'An explicit editorial correction.');
});

test('automatic source excerpts improve headlines and survive future weaker feed metadata', async () => {
  const db = database(), env = { DB: db.DB }, original = fixture('source-excerpt');
  await storeArticles(env, [original], 'rss', 'automatic');
  const excerpt = { ...original, summary: 'A bounded institutional excerpt.', digestBasis: 'source-extract', source: { ...original.source, basis: 'article' } };
  await storeArticles(env, [excerpt], 'source-enrichment', 'automatic');
  await storeArticles(env, [original], 'rss', 'automatic');
  assert.equal(db.sqlite.prepare('SELECT summary FROM news').get().summary, excerpt.summary);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM article_revisions').get().n, 1);
});

test('explicit import backfills legacy rows, updates metadata, preserves prior revision and lineage', async () => {
  const db = database({ legacy: true }), env = { DB: db.DB };
  const item = fixture('new-import-id', { title: 'Corrected headline', source: { publisher: 'Example News', url: 'https://news.example.com/legacy?utm_source=rss#section', sourceType: 'Reporting', basis: 'headline' } });
  await storeArticles(env, [item], 'import-one', 'seed');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM news').get().n, 1);
  const stored = db.sqlite.prepare('SELECT * FROM news').get();
  assert.equal(stored.id, 'legacy'); assert.equal(stored.publisher, 'Example News'); assert.equal(stored.source_type, 'News report');
  assert.equal(JSON.parse(db.sqlite.prepare('SELECT payload_json FROM article_revisions').get().payload_json).title, 'Old headline');
  await storeArticles(env, [item], 'import-two', 'seed');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM article_revisions').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM article_source_lineage').get().n, 2);
  const otherPublisher = { ...item, source: { ...item.source, publisher: 'Different Publisher' } };
  await assert.rejects(storeArticles(env, [otherPublisher], 'other'), /different publisher/);
  const safe = await storeArticles(env, [otherPublisher, fixture('unrelated')], 'other','automatic');
  assert.equal(safe.attributionConflicts,1);
  assert.equal(safe.accepted,1);
  assert.equal(db.sqlite.prepare("SELECT publisher FROM news WHERE id='legacy'").get().publisher,'Example News');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM article_source_lineage WHERE news_id='legacy' AND feed_id='other'").get().n,0);
});

test('canonical URL dedup keeps independent publisher reports and bulk ingestion has a bounded query count', async () => {
  const db = database(), env = { DB: db.DB };
  const articles = Array.from({ length: 100 }, (_, i) => fixture('n-' + i, { source: { publisher: i % 2 ? 'Publisher A' : 'Publisher B', url: 'https://news.example.com/story-' + i, basis: 'headline' } }));
  await storeArticles(env, articles, 'bulk-feed', 'automatic');
  assert(db.queries <= 12, 'batch ingestion and event matching must use a bounded query count'); assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM news').get().n, 100);
  await storeArticles(env, [articles[0], { ...articles[0], source: { ...articles[0].source, url: articles[0].source.url + '?utm_medium=rss' } }], 'bulk-feed');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM news').get().n, 100);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM article_revisions').get().n, 0);
});

test('article imports canonicalize the reviewed category alias and persist deterministic rejections', async () => {
  const db = database(), env = { DB: db.DB };
  const missing = fixture('missing-category'); delete missing.category;
  const result = await storeArticles(env, [
    fixture('world-alias', { category: 'World affairs' }),
    fixture('finance-alias', { category: ' finance ' }),
    fixture('technology-rejected', { category: 'Technology' }),
    fixture('business-rejected', { category: 'Business' }),
    missing
  ], 'category-fixtures', 'curated');
  assert.equal(result.accepted, 2);
  assert.equal(result.rejectedByCategory, 3);
  assert.equal(db.sqlite.prepare('SELECT category FROM news WHERE id=?').get('world-alias').category, 'World');
  assert.equal(db.sqlite.prepare('SELECT category FROM news WHERE id=?').get('finance-alias').category, 'Finance');
  assert.deepEqual(db.sqlite.prepare('SELECT submitted_category,reject_reason FROM article_category_rejections ORDER BY submitted_category').all().map(row => ({ ...row })), [
    { submitted_category: '', reject_reason: 'category_missing' },
    { submitted_category: 'Business', reject_reason: 'category_not_allowed' },
    { submitted_category: 'Technology', reject_reason: 'category_not_allowed' }
  ]);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM news WHERE id IN (?,?,?)').get('technology-rejected','business-rejected','missing-category').n, 0);

  const corrected = await storeArticles(env, [fixture('technology-rejected', { category: 'Health' })], 'category-fixtures', 'curated');
  assert.equal(corrected.accepted, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM article_category_rejections').get().n, 2);
});

test('news cursor paginates equal timestamps deterministically and remains scoped to filters', async () => {
  const db = database(), env = { DB: db.DB }, at = ago(1);
  await storeArticles(env, ['a', 'c', 'b'].map(id => fixture(id, { publishedAt: at })), 'manual');
  const first = await get(env, '/api/news?limit=2');
  assert.deepEqual(first.data.articles.map(a => a.id), ['c', 'b']); assert.equal(first.data.meta.hasMore, true); assert.equal(first.data.meta.total, 3);
  const next = await get(env, '/api/news?limit=2&cursor=' + first.data.meta.nextCursor);
  assert.deepEqual(next.data.articles.map(a => a.id), ['a']); assert.equal(next.data.meta.nextCursor, null);
  const mismatch = await get(env, '/api/news?publisher=Other&cursor=' + first.data.meta.nextCursor);
  assert.equal(mismatch.response.status, 400);
  assert.equal((await get(env, '/api/news?cursor=malformed')).response.status, 400);
  assert.equal((await get(env, '/api/news?limit=500')).response.status, 400);
});

test('related coverage keeps editorial links and ranks nearby matching reports from other publishers', async () => {
  const db = database(), env = { DB: db.DB };
  const title = 'New coastal flooding maps guide housing insurance';
  function report(id, publisher, days, changes = {}) {
    return fixture(id, { title, publishedAt: ago(days), source: {
      publisher, url: 'https://news.example.com/' + id, sourceType: 'Reporting', basis: 'headline'
    }, ...changes });
  }
  const closest = report('closest', 'Regional Press', 0.5, { title: 'Coastal flooding maps guide housing insurance' });
  const farther = report('farther', 'Community News', 1.5);
  const reviewed = { publisher: 'Flooding Agency', articleUrl: 'https://agency.example.com/report' };
  const worldSources = Array.from({ length: 9 }, (_, index) => ({ ...reviewed, articleUrl: reviewed.articleUrl + '-' + index }));
  const worldArticle = report('other-category', 'World Journal', 0.3, { category: 'World', secondarySources: worldSources });
  await storeArticles(env, [
    report('lead', 'Example News', 0.25, { secondarySources: [reviewed] }),
    closest, farther,
    report('same-publisher', 'example news', 0.3),
    worldArticle,
    report('earlier', 'Daily Journal', 3.5),
    report('unrelated', 'Public News', 0.3, { title: 'Coastal council approves airport infrastructure plan' })
  ], 'coverage-fixture');

  const feed = (await get(env, '/api/news?archive=1', true)).data;
  const detail = (await get(env, '/api/news/lead')).data.article;
  for (const article of [feed.articles.find(item => item.id === 'lead'), detail]) {
    assert.deepEqual(article.secondarySources.map(item => item.articleUrl || item.url),
      [reviewed.articleUrl, closest.source.url, farther.source.url]);
  }
  assert.deepEqual(feed.articles.find(item => item.id === worldArticle.id).secondarySources, worldSources.slice(0, 8));
});

test('feed and archive windows enforce access even with a crafted cursor and facets count the whole matching database set', async () => {
  const db = database(), env = { DB: db.DB };
  await storeArticles(env, [fixture('recent'), fixture('archived', { publishedAt: ago(4.5) })], 'manual');
  assert.equal((await get(env, '/api/news')).data.articles.length, 1);
  assert.equal((await get(env, '/api/news?archive=1')).response.status, 403);
  const archive = await get(env, '/api/news?archive=1', true); assert.equal(archive.data.articles.length, 2);
  const facets = await get(env, '/api/facets?archive=1&limit=1', true);
  assert.equal(facets.data.total, 2); assert.deepEqual(facets.data.publishers, [{ value: 'Example News', count: 2 }]);
  const scope = JSON.stringify({ archive: false, topic: '', region: '', publisher: '', q: '', evidence: 'all' });
  const cursor = Buffer.from(JSON.stringify({ v: 1, at: ago(4.1), id: 'recent', cutoff: ago(4.9), until: new Date().toISOString(), scope })).toString('base64url');
  const crafted = await get(env, '/api/news?cursor=' + cursor);
  assert.equal(crafted.response.status, 200); assert.equal(crafted.data.articles.length, 0);
});

test('public article feeds, single articles, facets and paid archives hide legacy disallowed categories', async () => {
  const db = database(), env = { DB: db.DB };
  await storeArticles(env, [
    fixture('current-world', { category: 'World' }),
    fixture('archive-world', { category: 'World', publishedAt: ago(6) })
  ], 'manual');
  const insertLegacy = (id, category, publishedAt) => {
    const url = `https://news.example.com/${id}`;
    const source = JSON.stringify({ publisher: 'Example News', url, basis: 'headline', sourceType: 'News report' });
    db.sqlite.prepare(`INSERT INTO news (id,canonical_url,title,original_headline,summary,category,region,keywords,published_at,ingested_at,source_json,official_sources_json,event_id,feed_id,data_mode,publisher,source_type,official_count,content_hash,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,url,'A stored legacy item','A stored legacy item','Legacy metadata.',category,'Global','[]',publishedAt,publishedAt,source,'[]',null,'legacy-feed','automatic','Example News','News report',0,'legacy-hash-'+id,'{}');
  };
  insertLegacy('legacy-technology', 'Technology', ago(1));
  insertLegacy('legacy-archive-technology', 'Technology', ago(6));

  const current = await get(env, '/api/news');
  assert.equal(current.response.status, 200);
  assert.deepEqual(current.data.articles.map(article => article.id), ['current-world']);
  const single = await get(env, '/api/news/legacy-technology');
  assert.equal(single.response.status, 404);
  const currentFacets = await get(env, '/api/facets');
  assert.equal(currentFacets.data.total, 1);
  assert.deepEqual(currentFacets.data.topics.map(topic => topic.value), ['World']);

  const archive = await get(env, '/api/news?archive=1', true);
  assert.deepEqual(archive.data.articles.map(article => article.id), ['current-world', 'archive-world']);
  const archivedSingle = await get(env, '/api/news/legacy-archive-technology?archive=1', true);
  assert.equal(archivedSingle.response.status, 404);
  const archiveFacets = await get(env, '/api/facets?archive=1', true);
  assert.equal(archiveFacets.data.total, 2);
  assert.deepEqual(archiveFacets.data.topics.map(topic => topic.value), ['World']);
});

test('topic, region, publisher, search and evidence filters execute parameterized SQL', async () => {
  const db = database(), env = { DB: db.DB };
  await storeArticles(env, [fixture('report'), fixture('official', { category: 'Infrastructure', region: 'Global', title: '100% launch readiness', source: { publisher: 'Agency', url: 'https://agency.example.com/official', sourceType: 'Official release', basis: 'article' } }), fixture('linked', { officialSources: [{ publisher: 'Agency', url: 'https://agency.example.com/record' }] })], 'manual');
  assert.equal((await get(env, '/api/news?evidence=official')).data.articles.length, 1);
  assert.equal((await get(env, '/api/news?evidence=with-official')).data.articles.length, 2);
  assert.equal((await get(env, '/api/news?topic=Infrastructure&region=Global&publisher=Agency&evidence=article')).data.articles.length, 1);
  assert.equal((await get(env, '/api/news?topic=Science')).response.status, 400);
  assert.equal((await get(env, '/api/news?q=100%25')).data.articles.length, 1);
  assert.equal((await get(env, '/api/news?q=%25%27%20OR%201%3D1%20--')).data.articles.length, 0);
});

test('events and economy are database documents with complete source-linked payloads', async () => {
  const db = database(), env = { DB: db.DB };
  assert.equal((await get(env, '/api/economy')).response.status, 404);
  await importEvents(env, [event()]);
  assert.equal((await get(env, '/api/events')).data.events[0].milestoneCount, 1);
  assert.deepEqual((await get(env, '/api/events/sample-event')).data.event, event());
  assert.equal((await get(env, '/api/events/missing')).response.status, 404);
  const economy = { meta: { asOfDate: ago(0).slice(0, 10) }, countries: [{ iso3: 'IND', values: [{ year: 2026, value: null }], source: { url: 'https://api.worldbank.org/v2/country/IND' } }] };
  await importEconomy(env, economy); assert.deepEqual((await get(env, '/api/economy')).data, economy);
  const invalid = event(); invalid.milestones[0].date = '2099-01-01';
  await assert.rejects(importEvents(env, [invalid]), /future/);
});

test('event detail exposes a bounded earliest-first timeline preview unless full access is verified', async () => {
  const db = database(), env = { DB: db.DB }, longEvent = event();
  longEvent.id = 'long-event';
  longEvent.milestones = Array.from({ length: 12 }, (_, index) => ({
    date: `${2010 + index}-01-01`, dateType: 'event', title: `Development ${index + 1}`, summary: 'A source-attributed development.',
    kind: 'Reporting', key: false, sources: [{ publisher: 'Agency', type: 'Official record', title: `Record ${index + 1}`, published: `${2010 + index}-01-01`, url: `https://agency.example.com/record-${index + 1}` }]
  }));
  longEvent.coverageEnd = '2021-01-01';
  await importEvents(env, [longEvent]);

  const previewResponse = await handleContent(request('/api/events/long-event'), env, {}, { canAccessFullTimelines: false });
  const preview = (await previewResponse.json()).event;
  assert.equal(preview.milestones.length, 10);
  assert.equal(preview.milestones[0].date, '2010-01-01');
  assert.equal(preview.milestones.at(-1).date, '2019-01-01');
  assert.equal(preview.previewTruncated, true);
  assert.equal(preview.originalMilestoneCount, 12);
  assert.equal(preview.previewCutoff, '2019-01-01');
  assert.equal(preview.previewLimit, 10);

  const fullResponse = await handleContent(request('/api/events/long-event'), env, {}, { canAccessFullTimelines: true });
  const full = (await fullResponse.json()).event;
  assert.equal(full.milestones.length, 12);
  assert.equal(full.previewTruncated, undefined);
});

test('automatic economy imports compare the observed ETag while manual imports remain unconditional', async () => {
  const db = database(), env = { DB: db.DB, INGEST_SECRET: 'local-test-ingestion-secret-with-sufficient-length' };
  const send = body => handleContent(request('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.INGEST_SECRET }, body: JSON.stringify(body) }), env, {});
  const first = { meta: { asOfDate: ago(0).slice(0, 10) }, countries: [{ iso3: 'IND', annual: 1 }] };
  const created = await send({ economy: first, expectedEconomyHash: null, feedId: 'world-bank-annual', mode: 'automatic' });
  assert.equal(created.status, 200, await created.clone().text());
  const currentResponse = await get(env, '/api/economy');
  const firstEtag = currentResponse.response.headers.get('etag');
  assert.match(firstEtag, /^"[a-f0-9]{64}"$/);
  assert.deepEqual(currentResponse.data, first);

  const second = { ...first, countries: [{ iso3: 'IND', annual: 2 }] };
  const updated = await send({ economy: second, expectedEconomyHash: firstEtag.slice(1, -1), feedId: 'world-bank-annual', mode: 'automatic' });
  assert.equal(updated.status, 200);
  const stale = await send({ economy: first, expectedEconomyHash: firstEtag.slice(1, -1), feedId: 'world-bank-annual', mode: 'automatic' });
  assert.equal(stale.status, 409);
  assert.deepEqual((await get(env, '/api/economy')).data, second);

  const invalidVersion = await send({ economy: first, expectedEconomyHash: 'not-a-hash', feedId: 'world-bank-annual', mode: 'automatic' });
  assert.equal(invalidVersion.status, 400);
  const manuallyCurated = { ...first, countries: [{ iso3: 'IND', annual: 3 }] };
  await importEconomy(env, manuallyCurated);
  assert.deepEqual((await get(env, '/api/economy')).data, manuallyCurated);
  assert.equal((await send({ economy: first, expectedEconomyHash: null, feedId: 'world-bank-annual', mode: 'automatic' })).status, 409);
});

test('RSS collector records without keywords can enter the real database API',async()=>{
  const db=database(),env={DB:db.DB,INGEST_SECRET:'local-test-ingestion-secret-with-sufficient-length'};
  const items=await parseFeed(`<rss><channel><item><title>A new release</title><link>https://www.nasa.gov/news/new-release/</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,{id:'nasa',url:'https://www.nasa.gov/feed/',publisher:'NASA',sourceType:'Official source',category:'Health',region:'Global'});
  assert.equal(items.length,1);assert.equal(items[0].keywords,'');
  const response=await handleContent(request('/api/ingest',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+env.INGEST_SECRET},body:JSON.stringify({articles:items,feedId:'nasa',mode:'automatic'})}),env,{});
  assert.equal(response.status,200);const read=await get(env,'/api/news');assert.equal(read.data.articles.length,1);assert.deepEqual(read.data.articles[0].keywords,[]);
});

test('event archive paginates a growing set without skipping equal-timestamp records', async () => {
  const db=database(),env={DB:db.DB},at=new Date();
  const events=Array.from({length:47},(_,i)=>({...event(),id:'event-'+String(i).padStart(3,'0')}));
  for(let i=0;i<events.length;i+=20)await importEvents(env,events.slice(i,i+20),{now:at});
  const seen=[];let cursor=null;
  do{const {response,data}=await get(env,'/api/events?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(response.status,200);assert.equal(data.meta.total,47);assert(data.events.length<=20);seen.push(...data.events.map(e=>e.id));cursor=data.meta.nextCursor;}while(cursor);
  assert.deepEqual(seen,events.map(e=>e.id));assert.equal((await get(env,'/api/events?limit=99999')).response.status,400);
});

test('timeline filters search beyond the first page and scope their cursor', async () => {
  const db=database(), env={DB:db.DB};
  await importEvents(env,[ {...event(),id:'history-public'}, ...Array.from({length:3},(_,i)=>({
    ...event(),id:`agency-${i}`,title:`Agency action ${i}`,keywords:['ABCD-1000'],recordType:'rulemaking'
  })) ]);
  const found=await get(env,'/api/events?kind=record&q=abcd-1000&limit=1');
  assert.equal(found.data.meta.total,3);
  assert.equal(found.data.events[0].recordType,'rulemaking');
  assert.equal((await get(env,`/api/events?kind=editorial&cursor=${encodeURIComponent(found.data.meta.nextCursor)}`)).response.status,400);
  assert.deepEqual((await get(env,'/api/events?kind=editorial')).data.events.map(item=>item.id),['history-public']);
  const article=fixture('linked-record',{eventId:'agency-0'});
  await storeArticles(env,[article],'public-records','automatic');
  await storeArticles(env,[{...article,eventId:null,title:'New agency headline'}],'public-records','automatic');
  assert.equal((await get(env,'/api/news/linked-record')).data.article.eventId,'agency-0');
});

test('cleanup archives by query window, deletes only expired news and cascades revision/lineage rows', async () => {
  const db = database(), env = { DB: db.DB };
  await storeArticles(env, [fixture('fresh'), fixture('archive', { publishedAt: ago(6) }), fixture('expired', { publishedAt: ago(181) })], 'manual');
  await storeArticles(env, [fixture('expired', { publishedAt: ago(181), title: 'A changed title' })], 'manual');
  await importEvents(env, [event()]);
  const result = await cleanupContent(env); assert.equal(result.deleted, 1); assert.equal(result.archived, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM article_revisions WHERE news_id='expired'").get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM article_source_lineage WHERE news_id='expired'").get().n, 0);
  assert.equal((await get(env, '/api/events')).data.events.length, 1);
  db.sqlite.prepare('INSERT INTO feed_state (id,last_attempt_at,error,item_count) VALUES (?,?,?,?)').run('nasa', ago(0), 'Internal upstream detail', 4);
  db.sqlite.prepare('INSERT INTO app_state (key,value) VALUES (?,?)').run('scheduled_paypal_reconciliation', JSON.stringify({ ok: true, checked: 2, invokedAt: ago(0) }));
  const status = (await get(env, '/api/pipeline/status')).data;
  assert.equal(status.meta.cleanup.deleted, 1); assert.equal(status.meta.total, 2);
  const reconciliation = status.tracking.scheduled_paypal_reconciliation;
  assert.equal(reconciliation.ok, true); assert.equal(reconciliation.checked, 2);
  assert.equal(Number.isFinite(Date.parse(reconciliation.invokedAt)), true);
  assert.equal(status.feeds.find(f => f.id === 'nasa').lastSuccessAt, null);
  assert.equal(status.feeds.find(f => f.id === 'nasa').error, 'The last feed refresh failed.');
});

test('ingestion authenticates, bounds payloads, validates the full request and never fetches source URLs', async () => {
  const db = database(), env = { DB: db.DB, INGEST_SECRET: 'a-long-test-secret-with-32-characters' };
  const post = async (body, headers = {}) => handleContent(request('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.INGEST_SECRET, ...headers }, body: JSON.stringify(body) }), env, {});
  assert.equal((await post({ articles: [fixture('blocked')] }, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post({ articles: [] }, { 'content-length': String(3 * 1024 * 1024) })).status, 413);
  assert.equal((await post({ articles: [] }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ articles: [fixture('valid')], events: [{ id: 'invalid' }] })).status, 400);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM news').get().n, 0);
  assert.equal((await post({ articles: [fixture('valid')], feedId: 'curated-import', mode: 'seed' })).status, 200);
  const at = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await post({ articles: [fixture('future', { publishedAt: at })] })).status, 400);
  assert.equal((await handleContent(request('/api/ingest'), env, {})).status, 405);
  assert.equal(await handleContent(request('/api/auth/session'), env, {}), null);
  assert.equal((await get({}, '/api/news')).response.status, 503);
});

test('source metadata rejects unsafe domains, credentials, invalid dates and disallowed publisher domains', async () => {
  for (const url of ['https://127.0.0.1/a', 'https://[::1]/a', 'https://localhost/a', 'https://user:pass@news.example.com/a', 'javascript:alert(1)', 'https://news.internal/a']) assert.throws(() => contentUrl(url));
  assert.throws(() => contentUrl('https://other.example.com/a', { INGEST_ALLOWED_DOMAINS: 'agency.gov' }));
  assert.equal(contentUrl('https://news.example.com/a?utm_source=rss#top'), 'https://news.example.com/a');
  const db = database();
  await assert.rejects(storeArticles({ DB: db.DB }, [fixture('bad-date', { publishedAt: '2026-02-30' })]), /publishedAt|date/);
});

test('explicit import batches are bounded and retain complete event and economy metadata', () => {
  const data = { articles: Array.from({ length: 60 }, (_, i) => fixture('i-' + i)), events: [event()], economy: { countries: [] } };
  const batches = importBatches(data);
  assert.deepEqual(batches.filter(b => b.articles).map(b => b.articles.length), [25, 25, 10]);
  assert.deepEqual(batches.find(b => b.events).events[0], data.events[0]);
  assert.deepEqual(batches.at(-1).economy, data.economy);
});

test('single-article API respects the current window and checks archive entitlement before returning a record', async () => {
  const db = database(), env = { DB: db.DB };
  await storeArticles(env, [fixture('fresh-detail'), fixture('archive-detail', { publishedAt: ago(6) })], 'manual');
  assert.equal((await get(env, '/api/news/fresh-detail')).data.article.id, 'fresh-detail');
  assert.equal((await get(env, '/api/news/archive-detail')).response.status, 404);
  assert.equal((await get(env, '/api/news/archive-detail?archive=1')).response.status, 403);
  assert.equal((await get(env, '/api/news/archive-detail?archive=1', true)).data.article.id, 'archive-detail');
  assert.equal((await get(env, '/api/news/unknown')).response.status, 404);
  const publicLinks={...env,PUBLIC_ARTICLE_LINKS:'true'};
  assert.equal((await get(publicLinks, '/api/news/archive-detail')).data.article.id, 'archive-detail');
  assert.equal((await get(publicLinks, '/api/news?archive=1')).response.status, 403);
});

test('authenticated feed health persists successes, preserves them on failure and rejects future health metadata', async () => {
  const db = database(), env = { DB: db.DB, INGEST_SECRET: 'a-long-test-secret-with-32-characters' };
  const post = state => handleContent(request('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.INGEST_SECRET }, body: JSON.stringify({ articles: [], feedId: 'nasa', mode: 'automatic', feedState: state }) }), env, {});
  const success = { lastAttemptAt: ago(0.02), lastSuccessAt: ago(0.01), itemCount: 12, error: null };
  assert.equal((await post(success)).status, 200);
  assert.equal((await post({ lastAttemptAt: ago(0), error: 'feed_http_503' })).status, 200);
  const state = db.sqlite.prepare("SELECT * FROM feed_state WHERE id='nasa'").get();
  assert.equal(state.last_success_at, success.lastSuccessAt); assert.equal(state.item_count, 12); assert.equal(state.error, 'feed_http_503');
  assert.equal((await post({ lastAttemptAt: new Date(Date.now() + 60000).toISOString() })).status, 400);
  assert.equal((await post({ lastAttemptAt: ago(0), lastSuccessAt: ago(0), error: 'failed' })).status, 400);
});

test('personalization ranks the entire filtered database before paginating and preserves stable timestamp ties', async () => {
  const db = database(), env = { DB: db.DB }, anchor = Date.now() - 3600000;
  const topics = ['Economy', 'World', 'Health', 'Trade'];
  const records = Array.from({ length: 100 }, (_, index) => fixture('personal-' + String(index).padStart(3, '0'), { category: topics[index % topics.length], publishedAt: new Date(anchor - Math.floor(index / 3) * 3600000).toISOString() }));
  await storeArticles(env, records, 'personalization-check', 'curated');
  const priorities = new Set(['Economy', 'Trade']);
  const expected = [...records].sort((a, b) => Number(priorities.has(b.category)) - Number(priorities.has(a.category)) || b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id)).map(record => record.id);
  const seen = []; let cursor = null;
  do {
    // Selection order is immaterial: the second request uses the reversed list.
    const url = '/api/news?limit=7&priorities=' + encodeURIComponent(cursor ? 'Trade,Economy' : 'Economy,Trade') + (cursor ? '&cursor=' + cursor : '');
    const { response, data } = await get(env, url);
    assert.equal(response.status, 200); assert.equal(data.meta.total, 100); assert.equal(data.meta.personalized, true); assert.deepEqual(data.meta.priorities, ['Economy', 'Trade']);
    seen.push(...data.articles.map(record => record.id)); cursor = data.meta.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, expected); assert.equal(new Set(seen).size, 100);
  // All fifty matching stories must precede every other category, including
  // preferred stories absent from the newest fifty unpersonalized records.
  assert(seen.slice(0, 50).every(id => priorities.has(records.find(record => record.id === id).category)));
  const normal = await get(env, '/api/news?limit=100');
  assert.equal(normal.data.meta.personalized, false); assert.deepEqual(normal.data.meta.priorities, []);
  assert.deepEqual(normal.data.articles.map(record => record.id), [...records].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id)).map(record => record.id));
});

test('personalization keeps topic, region, publisher and evidence filters and never grants archive access', async () => {
  const db = database(), env = { DB: db.DB };
  await storeArticles(env, [fixture('economy', { category: 'Economy', region: 'Asia' }), fixture('health', { category: 'Health', region: 'Asia', source: { publisher: 'Public Health Agency', url: 'https://publichealth.gov/current', sourceType: 'Official release', basis: 'headline' } }), fixture('health-old', { category: 'Health', region: 'Asia', publishedAt: ago(10) }), fixture('health-europe', { category: 'Health' })], 'personalization-check');
  const read = await get(env, '/api/news?priorities=Economy&topic=Health&region=Asia&publisher=Public%20Health%20Agency&evidence=official');
  assert.equal(read.response.status, 200); assert.equal(read.data.meta.total, 1); assert.deepEqual(read.data.articles.map(record => record.id), ['health']);
  assert.equal((await get(env, '/api/news?priorities=Economy&archive=1')).response.status, 403);
  const facets = await get(env, '/api/facets?priorities=Economy'); assert.equal(facets.data.total, 3);
});

test('priority lists are bounded, strictly allowlisted and insensitive to duplicate selection order', async () => {
  const env = { DB: database().DB };
  for (const value of ['Economy,', ',Economy', 'Technology', 'Economy,Unknown', "Economy') OR 1=1--", '<b>Economy</b>', 'Economy,'.repeat(9), 'x'.repeat(201)]) {
    const response = await get(env, '/api/news?priorities=' + encodeURIComponent(value)); assert.equal(response.response.status, 400, value);
  }
  assert.equal((await get(env, '/api/news?priorities=Economy&priorities=Trade')).response.status, 400);
  assert.deepEqual((await get(env, '/api/news?priorities=Trade,Economy,Economy')).data.meta.priorities, ['Economy', 'Trade']);
  const allowed = ['Economy', 'Finance', 'Politics', 'World', 'Infrastructure', 'Health', 'Energy', 'Trade'];
  assert.deepEqual((await get(env, '/api/news?priorities=' + encodeURIComponent(allowed.join(',')))).data.meta.priorities, allowed);
  assert.deepEqual((await get(env, '/api/news?priorities=World%20affairs')).data.meta.priorities, ['World']);
});

test('personalized cursors reject changed interests, forged ranks and bounds that could widen the feed', async () => {
  const db = database(), env = { DB: db.DB }, at = ago(1);
  await storeArticles(env, [fixture('preferred-a', { category: 'Economy', publishedAt: at }), fixture('preferred-b', { category: 'Economy', publishedAt: at }), fixture('other', { category: 'Health', publishedAt: at }), fixture('expired-preference', { category: 'Economy', publishedAt: ago(10) })], 'personalization-check');
  const first = await get(env, '/api/news?priorities=Economy&limit=1'); assert.equal(first.response.status, 200);
  const valid = JSON.parse(Buffer.from(first.data.meta.nextCursor, 'base64url').toString('utf8'));
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const change of [{ rank: 1 }, { rank: -1 }, { rank: '0' }, { rank: 100 }, { id: 'missing' }, { at: ago(2) }, { cutoff: '1990-01-01T00:00:00.000Z' }, { until: '2099-01-01T00:00:00.000Z' }]) {
    const forged = await get(env, '/api/news?priorities=Economy&cursor=' + encode({ ...valid, ...change }));
    assert.equal(forged.response.status, 400, JSON.stringify(change));
  }
  assert.equal((await get(env, '/api/news?priorities=Health&cursor=' + first.data.meta.nextCursor)).response.status, 400);
  assert.equal((await get(env, '/api/news?cursor=' + first.data.meta.nextCursor)).response.status, 400);
  const next = await get(env, '/api/news?priorities=Economy&limit=100&cursor=' + first.data.meta.nextCursor);
  assert.equal(next.response.status, 200); assert(!next.data.articles.some(record => record.id === 'expired-preference')); assert.equal(next.data.articles.length, 2);
});

test('private content backups authenticate, paginate every retained news/event record and exclude account data', async () => {
  const db = database(), env = { DB: db.DB, INGEST_SECRET: 'private-backup-test-key-at-least-32-characters' };
  const adminGet = path => handleContent(request(path, { headers: { authorization: 'Bearer ' + env.INGEST_SECRET } }), env, {});
  const articles = Array.from({ length: 101 }, (_, index) => fixture('backup-' + String(index).padStart(3, '0'), { publishedAt: ago(index % 2 ? 8 : 1), evidenceNote: 'Retained original evidence note', countries: ['IND'], officialSources: [{ publisher: 'Official Records', url: 'https://official.gov/record-' + index, title: 'Primary reference' }] }));
  await storeArticles(env, articles.slice(0, 100), 'backup-fixture', 'curated'); await storeArticles(env, articles.slice(100), 'backup-fixture', 'curated');
  const events = Array.from({ length: 101 }, (_, index) => ({ ...event(), id: 'backup-event-' + String(index).padStart(3, '0') }));
  for (let index = 0; index < events.length; index += 25) await importEvents(env, events.slice(index, index + 25));
  const economy = { meta: { asOfDate: ago(0).slice(0, 10), note: 'Retained source vintage' }, countries: [{ iso3: 'IND', gdpGrowth: [{ year: 2025, value: 5 }], source: { publisher: 'Official Records', url: 'https://official.gov/economy' } }] };
  await importEconomy(env, economy);
  db.sqlite.prepare('INSERT INTO users (id,provider,provider_subject,name,email,created_at) VALUES (?,?,?,?,?,?)').run('private-reader', 'google', 'private-provider-subject', 'Never Export This Reader', 'never-export-this-reader@example.org', Math.floor(Date.now() / 1000));
  db.sqlite.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run('never-export-this-session-hash', 'private-reader', Math.floor(Date.now() / 1000) + 1000);
  db.sqlite.prepare('INSERT INTO reading_saves (user_id,record_type,record_id,saved_at) VALUES (?,?,?,?)').run('private-reader', 'article', articles[0].id, Math.floor(Date.now() / 1000));
  db.sqlite.prepare('UPDATE news SET title=? WHERE id=?').run('Italy celebrates Formula 1 champion Kimi Antonelli', articles[0].id);
  const hidden = await handleContent(request('/api/admin/retract', { method: 'POST', headers: { authorization: 'Bearer ' + env.INGEST_SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [articles[0].id] }) }), env, {}); assert.equal(hidden.status, 200);
  for (const kind of ['news', 'events', 'economy']) {
    assert.equal((await handleContent(request('/api/admin/content-backup?kind=' + kind), env, {})).status, 401);
    assert.equal((await handleContent(request('/api/admin/content-backup?kind=' + kind, { headers: { authorization: 'Bearer wrong' } }), env, {})).status, 401);
  }
  const newsResponse = await adminGet('/api/admin/content-backup?kind=news'), first = await newsResponse.json();
  assert.equal(newsResponse.status, 200); assert.equal(newsResponse.headers.get('cache-control'), 'no-store'); assert.equal(first.records.length, 100); assert(first.nextCursor);
  const next = await (await adminGet('/api/admin/content-backup?kind=news&cursor=' + first.nextCursor)).json(); assert.equal(next.records.length, 1); assert.equal(next.nextCursor, null);
  const newsRecords = [...first.records, ...next.records]; assert.equal(new Set(newsRecords.map(row => row.id)).size, 101);
  const restoredHidden = newsRecords.find(row => row.id === articles[0].id); assert.equal(restoredHidden.editorialExcluded, 1); assert.equal(restoredHidden.evidenceNote, articles[0].evidenceNote); assert.deepEqual(restoredHidden.officialSources, articles[0].officialSources); assert.deepEqual(restoredHidden.countries, ['IND']);
  assert(newsRecords.some(row => row.publishedAt < ago(4)), 'backup includes retained records outside the homepage feed window');
  const eventFirst = await (await adminGet('/api/admin/content-backup?kind=events')).json(); assert.equal(eventFirst.records.length, 100); assert(eventFirst.nextCursor);
  const eventNext = await (await adminGet('/api/admin/content-backup?kind=events&cursor=' + eventFirst.nextCursor)).json(); assert.equal(eventNext.records.length, 1); assert.equal(eventNext.nextCursor, null);
  assert.deepEqual([...eventFirst.records, ...eventNext.records], events);
  const economyBackup = await (await adminGet('/api/admin/content-backup?kind=economy')).json(); assert.deepEqual(economyBackup, { records: [economy], nextCursor: null });
  const serialized = JSON.stringify([newsRecords, eventFirst, eventNext, economyBackup]);
  for (const privateValue of ['Never Export This Reader', 'never-export-this-reader@example.org', 'private-provider-subject', 'never-export-this-session-hash', 'private-reader']) assert(!serialized.includes(privateValue));
  assert.equal((await adminGet('/api/admin/content-backup?kind=events&cursor=' + first.nextCursor)).status, 400);
  assert.equal((await adminGet('/api/admin/content-backup?kind=news&cursor=broken')).status, 400);
  assert.equal((await adminGet('/api/admin/content-backup?kind=users')).status, 400);
  assert.equal((await adminGet('/api/admin/content-backup')).status, 400);
  const forgedEconomyCursor = Buffer.from(JSON.stringify({ v: 1, scope: 'backup:economy', id: 'unexpected-page' })).toString('base64url');
  assert.equal((await adminGet('/api/admin/content-backup?kind=economy&cursor=' + forgedEconomyCursor)).status, 400);
  assert.equal((await handleContent(request('/api/admin/content-backup?kind=news', { method: 'POST' }), env, {})).status, 405);
});

test('retraction hides public records without deleting retained metadata, account saves or timeline coverage; review restores access', async () => {
  const db = database(), env = { DB: db.DB, INGEST_SECRET: 'private-retract-test-key-at-least-32-characters' };
  const tracked = event(); await importEvents(env, [tracked]);
  const target = fixture('retract-target', { category: 'Economy', eventId: tracked.id, evidenceNote: 'Original evidence remains in backup.' }), unrelated = fixture('unrelated');
  await storeArticles(env, [target, unrelated], 'reviewed-fixture', 'curated');
  db.sqlite.prepare('INSERT INTO users (id,provider,provider_subject,created_at) VALUES (?,?,?,?)').run('reader', 'google', 'reader-subject', 1);
  db.sqlite.prepare('INSERT INTO reading_saves (user_id,record_type,record_id,saved_at) VALUES (?,?,?,?)').run('reader', 'article', target.id, 1);
  const coverageBefore = db.sqlite.prepare('SELECT * FROM event_coverage WHERE event_id=?').all(tracked.id), eventBefore = db.sqlite.prepare('SELECT payload_json FROM event_payloads WHERE id=?').get(tracked.id).payload_json;
  db.sqlite.prepare('UPDATE news SET title=? WHERE id=?').run('Italy celebrates Formula 1 champion Kimi Antonelli', target.id);
  const retract = ids => handleContent(request('/api/admin/retract', { method: 'POST', headers: { authorization: 'Bearer ' + env.INGEST_SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ ids }) }), env, {});
  assert.equal((await (await retract([target.id, target.id, 'unknown-id'])).json()).retracted, 1);
  assert.equal((await (await retract([target.id])).json()).retracted, 0, 'repeat retraction is idempotent');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM news').get().n, 2); assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reading_saves').get().n, 1);
  const stored = db.sqlite.prepare('SELECT * FROM news WHERE id=?').get(target.id), metadata = JSON.parse(stored.metadata_json); assert.equal(metadata.editorialExcluded, 1); assert.equal(metadata.evidenceNote, target.evidenceNote); assert.equal(typeof metadata.exclusionReason, 'string'); assert(metadata.exclusionReason.length > 0); assert(Number.isFinite(Date.parse(metadata.excludedAt)));
  assert.deepEqual((await get(env, '/api/news')).data.articles.map(row => row.id), [unrelated.id]);
  assert.equal((await get(env, '/api/news?priorities=Economy')).data.meta.total, 1);
  assert.equal((await get(env, '/api/news/' + target.id)).response.status, 404); assert.equal((await get(env, '/api/news/' + target.id + '?archive=1', true)).response.status, 404);
  const facets = (await get(env, '/api/facets')).data; assert.equal(facets.total, 1); assert(!facets.topics.some(row => row.value === 'Economy'));
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM event_coverage WHERE event_id=?').all(tracked.id), coverageBefore); assert.equal(db.sqlite.prepare('SELECT payload_json FROM event_payloads WHERE id=?').get(tracked.id).payload_json, eventBefore);
  const backupResponse = await handleContent(request('/api/admin/content-backup?kind=news', { headers: { authorization: 'Bearer ' + env.INGEST_SECRET } }), env, {}), backup = await backupResponse.json(); assert.equal(backup.records.find(row => row.id === target.id).editorialExcluded, 1);
  await storeArticles(env, [target], 'reviewed-restoration', 'curated');
  assert.equal((await get(env, '/api/news/' + target.id)).response.status, 200); assert.equal((await get(env, '/api/news')).data.meta.total, 2);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM news WHERE id=?').get(unrelated.id).n, 1);
});

test('retraction authenticates before writes, validates the whole bounded request and accepts at most100 ids', async () => {
  const db = database(), env = { DB: db.DB, INGEST_SECRET: 'private-retract-test-key-at-least-32-characters' }; await storeArticles(env, [fixture('protected')], 'reviewed-fixture');
  db.sqlite.prepare('UPDATE news SET title=?,original_headline=? WHERE id=?').run('Celebrity couple spotted together on the red carpet', 'Celebrity couple spotted together on the red carpet', 'protected');
  const post = (body, headers = {}) => handleContent(request('/api/admin/retract', { method: 'POST', headers: { authorization: 'Bearer ' + env.INGEST_SECRET, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, {});
  assert.equal((await post({ ids: ['protected'] }, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await handleContent(request('/api/admin/retract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['protected'] }) }), env, {})).status, 401);
  for (const body of [{ ids: [] }, { ids: ['protected', 'bad id'] }, { ids: ['protected'], extra: true }, { ids: Array.from({ length: 101 }, (_, index) => 'id-' + index) }, { ids: 'protected' }]) assert.equal((await post(body)).status, 400);
  assert.equal((await post({ ids: ['protected'] }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await handleContent(request('/api/admin/retract', { method: 'POST', headers: { authorization: 'Bearer ' + env.INGEST_SECRET, 'content-type': 'application/json' }, body: '{not-json' }), env, {})).status, 400);
  assert.equal((await post({ ids: ['protected'] }, { 'content-length': '17000' })).status, 400);
  assert.equal((await get(env, '/api/news/protected')).response.status, 200, 'invalid requests must leave all records visible');
  const hundred = await post({ ids: Array.from({ length: 100 }, (_, index) => index ? 'unknown-' + index : 'protected') }); assert.equal(hundred.status, 200); assert.equal((await hundred.json()).retracted, 1);
  assert.equal((await handleContent(request('/api/admin/retract'), env, {})).status, 405);
});

test('an automatic source refresh must not undo an editorial retraction', async () => {
  const db = database(), env = { DB: db.DB, INGEST_SECRET: 'private-retract-test-key-at-least-32-characters' }, target = fixture('editorially-hidden', { category: 'Economy' });
  await storeArticles(env, [target], 'source-feed', 'automatic');
  db.sqlite.prepare('UPDATE news SET category=? WHERE id=?').run('Entertainment', target.id);
  await handleContent(request('/api/admin/retract', { method: 'POST', headers: { authorization: 'Bearer ' + env.INGEST_SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [target.id] }) }), env, {});
  await storeArticles(env, [{ ...target, title: 'Updated headline from the same automatic source' }], 'source-feed', 'automatic');
  assert.equal((await get(env, '/api/news/' + target.id)).response.status, 404);
  assert.equal(JSON.parse(db.sqlite.prepare('SELECT metadata_json FROM news WHERE id=?').get(target.id).metadata_json).editorialExcluded, 1);
});

test('policy retraction rechecks current records and leaves corrected public-impact reporting visible', async () => {
  const db = database(), env = { DB: db.DB, INGEST_SECRET: 'private-retract-test-key-at-least-32-characters' };
  await storeArticles(env, [fixture('corrected-report', { category: 'Economy', title: 'Central bank changes household borrowing rates' }), fixture('legacy-entertainment')], 'reviewed-fixture', 'curated');
  db.sqlite.prepare('UPDATE news SET category=? WHERE id=?').run('Entertainment', 'legacy-entertainment');
  const response = await handleContent(request('/api/admin/retract', { method: 'POST', headers: { authorization: 'Bearer ' + env.INGEST_SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['corrected-report', 'legacy-entertainment'] }) }), env, {});
  assert.equal(response.status, 200); assert.equal((await response.json()).retracted, 1);
  assert.equal((await get(env, '/api/news/corrected-report')).response.status, 200); assert.equal((await get(env, '/api/news/legacy-entertainment')).response.status, 404);
});

test('a concurrent correction cannot be hidden by a stale policy retraction', async () => {
  const db = database(), env = { DB: db.DB, INGEST_SECRET: 'private-retract-test-key-at-least-32-characters' };
  await storeArticles(env, [fixture('corrected-during-review', { category: 'Economy' })], 'reviewed-fixture', 'curated');
  db.sqlite.prepare('UPDATE news SET category=? WHERE id=?').run('Entertainment', 'corrected-during-review');
  const originalPrepare = db.DB.prepare.bind(db.DB); let corrected = false;
  db.DB.prepare = sql => {
    const statement = originalPrepare(sql);
    if (!/^UPDATE news SET metadata_json=json_set/i.test(sql)) return statement;
    const wrap = current => ({ ...current, bind(...args) { return wrap(current.bind(...args)); }, async run() {
      if (!corrected) { corrected = true; db.sqlite.prepare('UPDATE news SET title=?,category=?,content_hash=? WHERE id=?').run('Central bank changes household borrowing rates', 'Economy', 'new-reviewed-correction-hash', 'corrected-during-review'); }
      return current.run();
    } });
    return wrap(statement);
  };
  const response = await handleContent(request('/api/admin/retract', { method: 'POST', headers: { authorization: 'Bearer ' + env.INGEST_SECRET, 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['corrected-during-review'] }) }), env, {});
  assert.equal(response.status, 200); assert(corrected, 'the correction must race after policy inspection and before the write'); assert.equal((await response.json()).retracted, 0);
  assert.equal((await get(env, '/api/news/corrected-during-review')).response.status, 200);
});
