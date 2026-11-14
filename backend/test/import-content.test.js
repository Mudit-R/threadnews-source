import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchExistingNews, filterConflictingArticles,hasExistingEconomy,importBatches } from '../scripts/import-content.mjs';

test('release import preserves existing economic histories and bootstraps with an empty-version guard',async()=>{
  const secret='fixture-administrator-key-long-enough';
  const existing={countries:Array.from({length:19},(_,i)=>({iso3:'C'+i,monthlyCpiHistory:[{period:'2026-09',value:3}]}))};
  assert.equal(await hasExistingEconomy('https://example.com',secret,{fetchImpl:async(_url,options)=>{assert.equal(options.redirect,'error');return Response.json({records:[existing]});}}),true);
  assert.deepEqual(importBatches({articles:[],events:[],economy:null}),[]);
  const bootstrap=importBatches({articles:[],events:[],economy:existing});
  assert.equal(bootstrap[0].expectedEconomyHash,null);
  await assert.rejects(hasExistingEconomy('https://example.com',secret,{fetchImpl:async()=>Response.json({error:'unavailable'},{status:503})}));
});

const article = (id, url, publisher) => ({ id, title: id, source: { url, publisher } });

test('import preflight preserves existing IDs, publisher attribution, and accepts clean records', () => {
  const incoming = [
    article('same-id', 'https://publisher.example/new', 'New publisher'),
    article('same-url', 'https://apnews.com/article/1', 'Associated Press'),
    article('clean', 'https://publisher.example/clean', 'Publisher')
  ];
  const existing = [
    article('same-id', 'https://news.google.com/old', 'Old publisher'),
    article('same-url', 'https://apnews.com/article/1', 'AP News')
  ];

  const result = filterConflictingArticles(incoming, existing);
  assert.deepEqual(result.skipped, { idConflict: 1, publisherConflict: 0 });
  assert.deepEqual(result.articles.map(item => item.id), ['same-url', 'clean']);
  assert.equal(result.articles[0].source.publisher, 'AP News');
});

test('import preflight skips a URL already assigned to an unrelated publisher', () => {
  const result = filterConflictingArticles(
    [article('incoming', 'https://publisher.example/shared', 'Publisher B')],
    [article('existing', 'https://publisher.example/shared', 'Publisher A')]
  );
  assert.deepEqual(result.articles, []);
  assert.deepEqual(result.skipped, { idConflict: 0, publisherConflict: 1 });
});

test('existing D1 news preflight follows cursors and sends its credential only to the Worker API', async () => {
  const calls = [];
  const fetchImpl = async input => {
    const url = new URL(input);
    calls.push(url);
    if (url.searchParams.has('cursor')) {
      assert.equal(url.searchParams.get('kind'), 'news');
      return Response.json({ records: [article('page-2', 'https://news.example/2', 'News')], nextCursor: null });
    }
    return Response.json({ records: [article('page-1', 'https://news.example/1', 'News')], nextCursor: 'opaque cursor' });
  };

  const records = await fetchExistingNews('https://threadnews.online', 'test-secret-that-is-never-logged', { fetchImpl });
  assert.equal(records.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].origin, 'https://threadnews.online');
  assert.equal(calls[1].searchParams.get('cursor'), 'opaque cursor');
});

test('existing D1 news preflight fails closed on HTTP errors', async () => {
  await assert.rejects(
    fetchExistingNews('https://threadnews.online', 'test-secret', { fetchImpl: async () => new Response('{}', { status: 503 }) }),
    /preflight existing D1 news: HTTP 503/
  );
});
