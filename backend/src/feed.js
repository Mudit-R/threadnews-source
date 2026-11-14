import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { canonicalPublisher } from './feeds.js';

export const MAX_FEED_BYTES=512*1024;
const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',textNodeName:'#text',removeNSPrefix:true,parseTagValue:false,parseAttributeValue:false,trimValues:true,processEntities:false});
const list=v=>v==null?[]:Array.isArray(v)?v:[v];
const text=v=>typeof v==='string'||typeof v==='number'?String(v):v&&typeof v==='object'?text(v['#text']):'';
export function plainText(v,max=600){return text(v).replace(/<[^>]*>/g,' ').replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/gi,e=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&#x27;':"'"}[e.toLowerCase()]||e)).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}
function feedBrief(){
  // RSS description/summary fields can contain copied article text, so they
  // remain discovery metadata only. Automated collectors publish headlines
  // and source links; article digests require separate review of the article.
  return '';
}
function relatedHeadlines(item,feed,currentUrl,currentPublisher){
  if(!feed.discovery)return [];
  const markup=text(item.description??item.summary??item.content);
  const found=[],seen=new Set([currentUrl]);
  for(const match of markup.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)){
    const entry=match[1],anchor=entry.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if(!anchor)continue;
    const url=canonicalUrl(anchor[1]);
    const publisher=plainText(entry.match(/<font\b[^>]*>([\s\S]*?)<\/font>/i)?.[1],160);
    const title=plainText(anchor[2],350);
    if(!url||!title||!publisher||seen.has(url)||publisher.toLowerCase()===String(currentPublisher||'').toLowerCase())continue;
    let host;try{host=new URL(url).hostname;}catch{continue;}
    if(host!=='news.google.com')continue;
    seen.add(url);found.push({publisher,url,title,sourceType:'News report'});
    if(found.length>=8)break;
  }
  return found;
}
function thumbnailUrl(item){
  const candidates=[];
  const add=(value,kind)=>{
    for(const candidate of list(value)){
      if(typeof candidate==='string'){
        if(kind==='thumbnail')candidates.push({url:candidate,declaredImage:true});
        continue;
      }
      if(!candidate||typeof candidate!=='object')continue;
      const url=candidate['@_url']||candidate['@_href']||candidate.url||candidate.href||candidate['#text'];
      if(typeof url!=='string')continue;
      const type=String(candidate['@_type']||candidate['@_medium']||candidate['@_format']||'').toLowerCase();
      const declaredImage=kind==='thumbnail'||type==='image'||type.startsWith('image/')||/\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(url);
      if(declaredImage)candidates.push({url,declaredImage:true});
    }
  };
  // RSS Media, Atom media extensions, and standard RSS enclosures.
  add(item.thumbnail,'thumbnail');
  add(item.enclosure,'enclosure');
  add(item.content,'content');
  add(item.image,'image');
  for(const candidate of candidates){
    const url=canonicalUrl(candidate.url);
    if(!url)continue;
    try{if(new URL(url).protocol==='https:')return url;}catch{}
  }
  return '';
}
export function canonicalUrl(value){
  try {const u=new URL(value);if(u.protocol!=='https:'&&u.protocol!=='http:')return null;if(u.username||u.password)return null;u.hash='';for(const k of [...u.searchParams.keys()])if(/^utm_/i.test(k)||['fbclid','gclid','oc'].includes(k))u.searchParams.delete(k);return u.href;}catch{return null;}
}
export async function sha256(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function readLimited(response,limit=MAX_FEED_BYTES){
  if(Number(response.headers.get('content-length'))>limit)throw new Error('Feed exceeds byte limit');
  if(!response.body)return '';
  const reader=response.body.getReader();const chunks=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('Feed exceeds byte limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let n=0;for(const c of chunks){bytes.set(c,n);n+=c.length;}return new TextDecoder().decode(bytes);
}
export async function parseFeed(xml,feed,now=new Date(),maxItems=50){
  if(new TextEncoder().encode(xml).length>MAX_FEED_BYTES)throw new Error('Feed exceeds byte limit');
  // A literal HTML doctype inside CDATA is article text, not an XML declaration.
  if(/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g,'')))throw new Error('DTD/entity declarations are not supported');
  if(XMLValidator.validate(xml)!==true)throw new Error('Invalid XML');
  const data=parser.parse(xml), items=list(data.rss?.channel?.item||data.feed?.entry||data.RDF?.item);
  if(!data.rss&&!data.feed&&!data.RDF)throw new Error('Unsupported RSS/Atom document');
  const results=[],seen=new Set();
  for(const item of items.slice(0,60)){
    if(results.length>=maxItems)break;
    let publisher=plainText(item.source,160)||feed.publisher;
    const originalHeadline=plainText(item.title,350);
    let title=originalHeadline;
    if(feed.discovery&&title.endsWith(' - '+publisher))title=title.slice(0,-publisher.length-3).trim();
    const atomLink=list(item.link).find(x=>typeof x==='object'&&(!x['@_rel']||x['@_rel']==='alternate'));
    const url=canonicalUrl(typeof item.link==='string'?item.link:atomLink?.['@_href']);
    const at=new Date(text(item.pubDate||item.published||item.updated||item.date));
    if(!title||!url||!Number.isFinite(at.getTime())||at.getTime()>now.getTime()+10*60*1000||seen.has(url))continue;
    // Older feed entries are not resurfaced as current news. Store only a bounded 30-day window.
    if(at.getTime()<now.getTime()-30*86400000)continue;
    seen.add(url);
    const official=feed.sourceType==='Official source', thumbnail=thumbnailUrl(item);
    const brief=feedBrief(), secondarySources=relatedHeadlines(item,feed,url,canonicalPublisher(publisher));
    results.push({id:'feed-'+(await sha256(url)).slice(0,24),title,originalHeadline,
      summary:brief|| (official?'Official-source headline. Open the original release for details; it has not been independently corroborated here.':'Headline-based discovery item. Open the original reporting for the full context; no article summary has been generated.'),
      digestBasis:brief?'feed-description':'headline-only',
      category:feed.category,region:feed.region,keywords:'',publishedAt:at.toISOString(),ingestedAt:now.toISOString(),
      source:{publisher:canonicalPublisher(publisher),url,discoveryUrl:feed.discovery?url:feed.url,sourceType:feed.sourceType,basis:brief?'feed-description':'headline',feedId:feed.id,discoverySource:feed.discovery||feed.publisher,...(thumbnail?{thumbnailUrl:thumbnail}:{})},
      officialSources:[],secondarySources,eventId:null});
  }
  return results.slice(0,50);
}
