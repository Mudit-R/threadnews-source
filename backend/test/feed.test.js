import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, canonicalUrl, readLimited } from '../src/feed.js';
import { enabledFeeds } from '../src/feeds.js';

const now=new Date('2026-11-03T09:00:00Z');
const feed={id:'test',publisher:'Example News',category:'World affairs',region:'Global',sourceType:'News report',url:'https://example.com/rss'};
test('RSS metadata keeps publication/ingestion separate and deduplicates canonical links',async()=>{
  const xml=`<rss version="2.0"><channel><item><title><![CDATA[One development]]></title><link>https://example.com/a?utm_source=rss</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item><item><title>Repeated item</title><link>https://example.com/a</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  const items=await parseFeed(xml,feed,now);
  assert.equal(items.length,1);assert.equal(items[0].source.url,'https://example.com/a');assert.equal(items[0].publishedAt,'2026-11-02T10:00:00.000Z');assert.equal(items[0].ingestedAt,now.toISOString());assert.equal(items[0].source.basis,'headline');assert.equal(items[0].eventId,null);assert.match(items[0].summary,/no article summary/);
});
test('Google discovery preserves the reported publisher and does not claim article access',async()=>{
  const items=await parseFeed(`<rss><channel><item><title>Shipping development - Example News</title><link>https://news.google.com/rss/articles/abc?oc=5</link><source url="https://example.com">Example News</source><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><description>Unreviewed full body must not become a summary</description></item></channel></rss>`,{...feed,discovery:'Google News'},now);
  assert.equal(items[0].title,'Shipping development');assert.equal(items[0].source.publisher,'Example News');assert.equal(items[0].source.discoverySource,'Google News');assert(!items[0].summary.includes('Unreviewed full body'));
});
test('Atom alternate link and date are supported',async()=>{
  const items=await parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Official update</title><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/update"/><updated>2026-11-02T20:00:00+05:30</updated></entry></feed>`,{...feed,sourceType:'Official source'},now);
  assert.equal(items[0].source.url,'https://example.com/update');assert.equal(items[0].publishedAt,'2026-11-02T14:30:00.000Z');assert.match(items[0].summary,/not been independently corroborated/);
});
test('DTD/entity declarations, invalid XML and oversized streamed input are rejected',async()=>{
  await assert.rejects(parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',feed,now),/DTD/);
  await assert.rejects(parseFeed('<rss><channel></rss>',feed,now),/Invalid XML/);
  await assert.rejects(readLimited(new Response('123456'),5),/byte limit/);
});
test('unsafe links, dates far in the future, missing dates and stale entries are omitted',async()=>{
  const items=await parseFeed(`<rss><channel><item><title>A</title><link>javascript:alert(1)</link><pubDate>2026-11-02</pubDate></item><item><title>B</title><link>https://example.com/b</link><pubDate>2027-01-01</pubDate></item><item><title>C</title><link>https://example.com/c</link></item><item><title>D</title><link>https://example.com/d</link><pubDate>2024-01-01</pubDate></item></channel></rss>`,feed,now);
  assert.equal(items.length,0);assert.equal(canonicalUrl('https://user:pass@example.com/a'),null);
});
test('restricted sources cannot be enabled accidentally through environment config',()=>{
  assert(!enabledFeeds({ENABLED_FEEDS:'cna-world,nasa'}).some(x=>x.id==='cna-world'));assert.deepEqual(enabledFeeds({ENABLED_FEEDS:'nasa'}).map(x=>x.id),['nasa']);assert.deepEqual(enabledFeeds({ENABLED_FEEDS:''}),[]);
});
