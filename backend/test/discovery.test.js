import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDiscovery,sourceURL,fetchSource} from '../src/discovery.js';
import {isImpactNews} from '../src/policy.js';
const now=new Date('2026-11-03T12:00:00Z');
const feed={id:'gdelt-economy',format:'gdelt',category:'Economy',query:'(inflation OR tariff)'};
const record={url:'https://www.bbc.com/news/economy-report?utm_source=feed',title:'Central bank announces policy decision',seendate:'20261103T100000Z',sourcecountry:'United Kingdom',socialimage:'https://example.com/unlicensed.jpg'};
test('GDELT records preserve indexed-time basis and publisher attribution without images or bodies',async()=>{
 const [item]=await parseDiscovery(JSON.stringify({articles:[record]}),feed,now);
 assert.equal(item.source.publisher,'BBC News');assert.equal(item.source.dateBasis,'indexed');assert.equal(item.source.indexedAt,'2026-11-03T10:00:00.000Z');assert.equal(item.source.url,'https://www.bbc.com/news/economy-report');assert.equal(item.source.discoveryUrl,'https://www.gdeltproject.org/');assert.equal(item.source.basis,'headline');assert.equal(item.socialimage,undefined);assert.equal(item.image,undefined);assert.equal(item.body,undefined);
});
test('GDELT rejects malformed dates, future entries, stale entries, duplicate links and private URLs',async()=>{
 const rows=[record,record,{...record,url:'https://example.com/future',seendate:'20261104T010000Z'},{...record,url:'https://example.com/stale',seendate:'20261001T100000Z'},{...record,url:'https://localhost/item'},{...record,url:'https://example.com/invalid',seendate:'20260230T100000Z'}];
 assert.equal((await parseDiscovery(JSON.stringify({articles:rows}),feed,now)).length,1);
 await assert.rejects(()=>parseDiscovery('upstream error',feed,now));await assert.rejects(()=>parseDiscovery('{}',feed,now));
});
test('Source queries are bounded to recent headline discovery on the fixed GDELT API',()=>{
 const url=new URL(sourceURL(feed));assert.equal(url.origin,'https://api.gdeltproject.org');assert.equal(url.searchParams.get('mode'),'artlist');assert.equal(url.searchParams.get('maxrecords'),'25');assert.equal(url.searchParams.get('timespan'),'4d');assert.match(url.searchParams.get('query'),/sourcelang:english/);
});
test('Public-impact scope excludes sporting results and personal journey stories',()=>{
 assert.equal(isImpactNews({category:'Sport',title:'Championship final result'}),false);assert.equal(isImpactNews({category:'World affairs',title:'Karl Bushby returns home after a 28-year journey'}),false);assert.equal(isImpactNews({category:'Economy',title:'Public transport fares change next month'}),true);
});
test('Canonical feed redirects stay on the exact registry origin and never turn into arbitrary fetches',async()=>{
 const calls=[];const google={id:'google-world',url:'https://news.google.com/rss?hl=en-US'};
 const response=await fetchSource(google,{fetchImpl:async url=>{calls.push(url);return calls.length===1?new Response(null,{status:302,headers:{location:'/rss/topics/canonical'}}):new Response('ok');}});
 assert.equal(await response.text(),'ok');assert.deepEqual(calls,['https://news.google.com/rss?hl=en-US','https://news.google.com/rss/topics/canonical']);
 await assert.rejects(()=>fetchSource(google,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://localhost/private'}})}),/left the registry origin/);
});
