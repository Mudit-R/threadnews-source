import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { enabledFeeds } from '../src/feeds.js';
import { parseFeed, readLimited } from '../src/feed.js';
import { serializeEdition } from '../src/edition.js';

// Runner alternative: move XML parsing off the 10 ms Workers Free CPU allowance.
const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--output'))throw new Error('Usage: node scripts/refresh-news.mjs [--output PATH]');
const destination=args.length?pathToFileURL(resolve(args[1])):new URL('../../web/news-data.json',import.meta.url);
if(!/\.json$/i.test(destination.pathname))throw new Error('Output must be a .json path; a matching .js browser fallback is written beside it.');
let previous={articles:[],meta:{}};try{const raw=JSON.parse(readFileSync(destination,'utf8'));previous=Array.isArray(raw)?{articles:raw,meta:{}}:raw;}catch{}
const byUrl=new Map((previous.articles||[]).filter(a=>a.source?.url).map(a=>[a.source.url,a]));
const errors=[],successes=[],now=new Date();
for(const feed of enabledFeeds(process.env)){
  try{
    const response=await fetch(feed.url,{headers:{accept:'application/rss+xml, application/atom+xml, application/xml','user-agent':'Threadline/0.2 (headline/link RSS reader)'},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('HTTP '+response.status);
    const articles=await parseFeed(await readLimited(response),feed,now);
    for(const article of articles){const prior=byUrl.get(article.source.url);if(!prior)byUrl.set(article.source.url,article);}
    successes.push({id:feed.id,items:articles.length});
  }catch(error){errors.push({id:feed.id,error:String(error.message).slice(0,160)});}
}
if(!successes.length){console.error('No enabled feed refreshed successfully. Previous edition was left unchanged.');process.exitCode=1;}
else{
  const articles=[...byUrl.values()].filter(a=>Date.parse(a.publishedAt)>=now.getTime()-30*86400000).sort((a,b)=>String(b.publishedAt).localeCompare(String(a.publishedAt))).slice(0,150);
  const payload={articles,meta:{mode:'automatic',generatedAt:now.toISOString(),lastIngestedAt:now.toISOString(),total:articles.length,coverageNote:'Automatically collected headline/link metadata, with original reporting linked. Publisher coverage is incomplete; summaries on automatic items are not article summaries.',feeds:successes,feedErrors:errors}};
  const fallback=new URL(destination.href.replace(/\.json$/i,'.js')),{json,js}=serializeEdition(payload);
  const temp=new URL(destination.href+'.tmp'),scriptTemp=new URL(fallback.href+'.tmp');writeFileSync(temp,json);writeFileSync(scriptTemp,js);renameSync(temp,destination);renameSync(scriptTemp,fallback);
  console.log(JSON.stringify({written:articles.length,feeds:successes,errors}));
}
