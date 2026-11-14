import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readLimited } from '../src/feed.js';

export const DEFAULT_ORIGIN='https://threadnews.online';
export class LiveCheckError extends Error {constructor(code,endpoint){super(code);this.code=code;this.endpoint=endpoint;}}
export function liveOrigin(value=DEFAULT_ORIGIN){
  let url;try{url=new URL(value);}catch{throw new LiveCheckError('invalid_app_origin');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new LiveCheckError('invalid_app_origin');
  return url.origin;
}
async function read(url,{fetchImpl,json=true,expectedStatus=200}={}){
  let response;try{response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{accept:json?'application/json':'text/html, text/javascript'}});}catch{throw new LiveCheckError('live_service_unreachable',url.pathname);}
  if(response.status!==expectedStatus)throw new LiveCheckError('live_http_'+response.status,url.pathname);
  let body;try{body=await readLimited(response,2*1024*1024);}catch{throw new LiveCheckError('oversized_live_response');}
  if(!json)return body;
  try{return JSON.parse(body);}catch{throw new LiveCheckError('invalid_live_json');}
}
function requireValue(condition,code){if(!condition)throw new LiveCheckError(code);}
export async function verifyLive({env=process.env,fetchImpl=fetch,now=new Date()}={}){
  const origin=liveOrigin(env.APP_ORIGIN||DEFAULT_ORIGIN),url=path=>new URL(path,origin),checks=[];
  const [health,configText,news,events,economy,pipeline,providers,privacy,guest,billing,html]=await Promise.all([
    read(url('/api/health'),{fetchImpl}),read(url('/app-config.js'),{fetchImpl,json:false}),
    read(url('/api/news?limit=1'),{fetchImpl}),read(url('/api/events?limit=1'),{fetchImpl}),
    read(url('/api/economy'),{fetchImpl}),read(url('/api/pipeline/status'),{fetchImpl}),
    read(url('/api/auth/providers'),{fetchImpl}),read(url('/api/privacy'),{fetchImpl}),
    read(url('/api/auth/session'),{fetchImpl}),read(url('/api/billing/plans'),{fetchImpl}),read(url('/'),{fetchImpl,json:false})
  ]);
  requireValue(health.ok===true&&health.databaseConfigured===true&&health.newsStorage==='d1','live_database_unavailable');checks.push('live_database');
  let config;try{config=JSON.parse(configText.match(/globalThis\.THREADLINE_CONFIG\s*=\s*(\{[^\n]+\})\s*;/)?.[1]);}catch{}
  requireValue(config?.apiBase===''&&config.mode==='production','frontend_not_using_live_database');checks.push('same_origin_production_frontend');
  const minimum=Number(env.VERIFY_MIN_NEWS||1);
  requireValue(Number.isInteger(minimum)&&minimum>=1&&minimum<=100000,'invalid_verify_min_news');
  requireValue(news.meta?.mode==='database'&&Number.isInteger(news.meta.total)&&news.meta.total>=minimum&&Array.isArray(news.articles)&&news.articles.length>0,'live_news_empty');
  const article=news.articles[0];
  requireValue(typeof article.id==='string'&&typeof article.title==='string'&&/^https?:\/\//.test(article.source?.url||'')&&Number.isFinite(Date.parse(article.publishedAt))&&Date.parse(article.publishedAt)<=now.getTime()+600000,'invalid_live_news_record');checks.push('database_news');
  requireValue(events.meta?.mode==='database'&&Array.isArray(events.events)&&events.events.length>0,'live_timelines_empty');
  const id=events.events[0]?.id;
  requireValue(typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id),'invalid_live_event_id');
  const event=await read(url('/api/events/'+encodeURIComponent(id)),{fetchImpl}),record=event.event||event;
  requireValue(Array.isArray(record.milestones)&&record.milestones.length>0,'live_timeline_missing_milestones');checks.push('database_event_history');
  requireValue(Array.isArray(economy.countries)&&economy.countries.length===19&&new Set(economy.countries.map(c=>c.iso3)).size===19,'live_economy_incomplete');
  requireValue(economy.countries.every(country=>Array.isArray(country.gdpGrowth)&&country.gdpGrowth.some(point=>Number.isFinite(point.value))&&Array.isArray(country.inflation)),'live_economy_missing_history');checks.push('g20_economy_history');
  requireValue(economy.countries.some(country=>country.monthlyCpiHistory?.length>0)&&economy.countries.some(country=>country.quarterlyCpiHistory?.length>0),'live_cpi_source_history_missing');checks.push('monthly_and_quarterly_cpi_history');
  const enabled=Array.isArray(pipeline.feeds)?pipeline.feeds.filter(feed=>feed.enabled):[];
  requireValue(enabled.length>0,'no_enabled_news_sources');
  const freshest=Math.max(...enabled.map(feed=>Date.parse(feed.lastSuccessAt||'')).filter(Number.isFinite));
  const maxAgeHours=Number(env.VERIFY_MAX_PIPELINE_HOURS||12);
  requireValue(Number.isFinite(maxAgeHours)&&maxAgeHours>=1&&maxAgeHours<=168,'invalid_pipeline_max_age');
  requireValue(Number.isFinite(freshest)&&freshest<=now.getTime()+600000&&now.getTime()-freshest<=maxAgeHours*3600000,'pipeline_has_no_recent_success');checks.push('recent_recorded_feed_success');
  requireValue(Array.isArray(providers.providers)&&providers.providers.some(provider=>provider.id==='google')&&providers.providers.every(provider=>provider.enabled?typeof provider.startUrl==='string':provider.startUrl===null),'invalid_auth_provider_configuration');
  requireValue(guest.user===null,'anonymous_session_is_not_private');checks.push('anonymous_session_and_provider_configuration');
  requireValue(Array.isArray(privacy.sections)&&privacy.sections.length>=3,'privacy_notice_unavailable');checks.push('privacy_notice');
  const monthly=billing.plans?.find(plan=>plan.key==='monthly'),annual=billing.plans?.find(plan=>plan.key==='annual');
  requireValue(billing.billing?.freeThroughDate==='2026-11-30'&&billing.billing?.billingStartsAt==='2026-11-30T18:30:00.000Z'
    &&monthly?.price==='2.00'&&monthly.currency==='USD'&&monthly.interval==='month'
    &&annual?.price==='20.00'&&annual.currency==='USD'&&annual.interval==='year','invalid_billing_catalog_or_schedule');
  if(!billing.enabled)requireValue(billing.plans.every(plan=>plan.available===false),'billing_guard_not_active');
  checks.push('billing_catalog_and_launch_schedule');
  requireValue(/ThreadNews/.test(html)&&/account\.js/.test(html),'frontend_assets_outdated');checks.push('deployed_frontend_assets');
  return {ok:true,origin,checkedAt:now.toISOString(),checks,newsTotal:news.meta.total,timelineTotal:events.meta.total??events.events.length,economies:economy.countries.length,enabledFeeds:enabled.length,lastFeedSuccessAt:new Date(freshest).toISOString(),billingEnabled:billing.enabled===true,signInProviders:providers.providers.filter(provider=>provider.enabled).map(provider=>provider.id)};
}
export async function main(){
  try{console.log(JSON.stringify(await verifyLive()));}
  catch(error){console.error(JSON.stringify({ok:false,error:error instanceof LiveCheckError?error.code:'live_verification_failed',...(error instanceof LiveCheckError&&error.endpoint?{endpoint:error.endpoint}:{})}));process.exitCode=1;}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main();
