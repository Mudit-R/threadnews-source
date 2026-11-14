import { canonicalUrl, plainText, parseFeed, readLimited, sha256 } from './feed.js';
import { isImpactNews } from './policy.js';

const PUBLISHERS = {'bbc.com':'BBC News','bbc.co.uk':'BBC News','cnn.com':'CNN','reuters.com':'Reuters','apnews.com':'Associated Press','bloomberg.com':'Bloomberg','economist.com':'The Economist','nhk.or.jp':'NHK WORLD-JAPAN','channelnewsasia.com':'CNA','aljazeera.com':'Al Jazeera','dw.com':'DW','ft.com':'Financial Times','theguardian.com':'The Guardian'};
function publisher(host) { const domain = host.replace(/^www\./,''); return Object.entries(PUBLISHERS).find(([suffix])=>domain===suffix||domain.endsWith('.'+suffix))?.[1] || domain; }
function indexTime(value) {
  if (typeof value !== 'string' || !/^\d{8}T\d{6}Z$/.test(value)) return null;
  const iso=value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z');
  const date=new Date(iso);return Number.isFinite(date.getTime())&&date.toISOString().replace('.000Z','Z')===iso?date:null;
}
export function sourceURL(feed) {
  if (feed.format!=='gdelt') return feed.url;
  const url=new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  for(const [key,value] of Object.entries({query:feed.query+' sourcelang:english',mode:'artlist',format:'json',maxrecords:'25',timespan:'4d',sort:'datedesc'}))url.searchParams.set(key,value);
  return url.href;
}
// Public feed redirects carry no ingestion credentials and stay on the exact
// registry origin. Google topic feeds redirect to their canonical topic ID.
export async function fetchSource(feed,{fetchImpl=fetch,...options}={}){
  let url=new URL(sourceURL(feed));const origin=url.origin;
  for(let hop=0;hop<4;hop++){
    const response=await fetchImpl(url.href,{...options,redirect:'manual'});
    if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');if(!location)throw new Error('Source redirect has no location');
    const next=new URL(location,url);if(next.origin!==origin||next.protocol!=='https:'||next.username||next.password)throw new Error('Source redirect left the registry origin');
    url=next;
  }
  throw new Error('Too many source redirects');
}
export async function parseDiscovery(raw,feed,now=new Date(),maxItems=50) {
  let payload;try{payload=JSON.parse(raw);}catch{throw new Error('Discovery returned invalid JSON');}
  if(!payload||!Array.isArray(payload.articles)||payload.articles.length>250)throw new Error('Invalid discovery response');
  const out=[],seen=new Set();
  for(const record of payload.articles.slice(0,50)){
    if(out.length>=maxItems)break;
    const url=canonicalUrl(record.url),title=plainText(record.title,350),at=indexTime(record.seendate);
    if(!url||!title||!at||at.getTime()>now.getTime()+600000||at.getTime()<now.getTime()-4*86400000||seen.has(url))continue;
    const host=new URL(url).hostname;
    if(!host.includes('.')||/^\d+(?:\.\d+){3}$/.test(host)||/(?:localhost|\.local|\.internal)$/.test(host))continue;
    seen.add(url);
    const article={id:'feed-'+(await sha256(url)).slice(0,24),title,originalHeadline:title,
      summary:'Headline discovered through GDELT. Open the publisher’s reporting for context. The displayed time is when GDELT indexed this link; its publication time has not been verified.',
      category:feed.category,region:'Global',keywords:[],publishedAt:at.toISOString(),
      source:{publisher:publisher(host),url,sourceType:'News report',basis:'headline',feedId:feed.id,discoverySource:'The GDELT Project',discoveryUrl:'https://www.gdeltproject.org/',dateBasis:'indexed',indexedAt:at.toISOString(),sourceCountry:plainText(record.sourcecountry,80)},
      officialSources:[],eventId:null};
    if(isImpactNews(article))out.push(article);
  }
  return out;
}
export async function parseSource(raw,feed,now=new Date(),maxItems=50) {
  return (feed.format==='gdelt'?await parseDiscovery(raw,feed,now,maxItems):await parseFeed(raw,feed,now,maxItems)).filter(isImpactNews);
}
export async function readSource(response,feed,now=new Date(),maxBytes=512*1024,maxItems=50){return parseSource(await readLimited(response,maxBytes),feed,now,maxItems);}
