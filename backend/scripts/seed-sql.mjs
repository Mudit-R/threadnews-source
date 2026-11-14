import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalUrl } from '../src/feed.js';

// Produces a local import outside migrations. It never embeds API credentials.
const seed=JSON.parse(readFileSync(new URL('../../web/news-data.json',import.meta.url),'utf8'));
const articles=Array.isArray(seed)?seed:seed.articles||seed.items||[];
const quote=v=>v==null?'NULL':"'"+String(v).replaceAll("'","''")+"'";
const now=new Date().toISOString();
const rows=[];
for(const a of articles){
  const url=canonicalUrl(a.source?.url);if(!a.id||!a.title||!url||!Number.isFinite(Date.parse(a.publishedAt)))throw new Error('Seed article has missing identity, URL or publication date');
  const values=[a.id,url,a.title,a.originalHeadline||a.title,a.summary||'',a.category||'World affairs',a.region||'Global',Array.isArray(a.keywords)?JSON.stringify(a.keywords):a.keywords||'',new Date(a.publishedAt).toISOString(),a.ingestedAt||now,JSON.stringify(a.source),JSON.stringify(a.officialSources||[]),a.eventId||null,'curated-seed','seed'];
  rows.push('INSERT INTO news (id,canonical_url,title,original_headline,summary,category,region,keywords,published_at,ingested_at,source_json,official_sources_json,event_id,feed_id,data_mode) VALUES ('+values.map(quote).join(',')+') ON CONFLICT(canonical_url) DO NOTHING;');
}
const out=fileURLToPath(new URL('../seed.sql',import.meta.url));writeFileSync(out,rows.join('\n')+'\n');console.log(`Prepared ${rows.length} curated records in backend/seed.sql. Apply with the documented D1 execute command.`);
