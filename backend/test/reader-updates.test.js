import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { sha256 } from '../src/feed.js';
import { handleReaderUpdates, dispatchReaderUpdates, coverageRss, timelineCalendar, deliveryConfig, readerUpdatesExport } from '../src/reader-updates.js';

const NOW=Math.floor(Date.parse('2026-11-04T12:00:00Z')/1000),ORIGIN='https://threadnews.online';
async function fixture(extra={}) {
  const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^000[1-8]_.*\.sql$/.test(name)).sort())sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const DB={prepare(query){return {args:[],bind(...args){return {...this,args};},async first(){return sql.prepare(query).get(...this.args)||null;},async all(){return {results:sql.prepare(query).all(...this.args).map(row=>({...row}))};},async run(){return {success:true,meta:{changes:Number(sql.prepare(query).run(...this.args).changes)}};}};},async batch(items){sql.exec('BEGIN');try{const r=[];for(const item of items)r.push(await item.run());sql.exec('COMMIT');return r;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  for(const [id,character] of [['reader-one','a'],['reader-two','b']]) {
    sql.prepare('INSERT INTO users (id,provider,provider_subject,name,email,created_at) VALUES (?,?,?,?,?,?)').run(id,'google',id,'Reader',id+'@example.test',NOW);
    sql.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(await sha256(character.repeat(43)),id,NOW+365*86400);
  }
  const env={DB,APP_ORIGIN:ORIGIN,EMAIL_SEND_ENABLED:'true',EMAIL_FROM:'updates@threadnews.online',EMAIL_POSTAL_ADDRESS:'Fixture sender address for unit tests only',EMAIL_TOKEN_SECRET:'fixture-signing-secret-of-at-least-32-characters',RESEND_API_KEY:'fixture-resend-secret',...extra};
  const sends=[];
  const fetchImpl=async (url,options)=>{assert.equal(url,'https://api.resend.com/emails');assert.equal(options.redirect,'manual');sends.push({providerHeaders:options.headers,...JSON.parse(options.body)});return Response.json({id:'fixture-'+sends.length});};
  const request=async (path,{method='GET',body,user='reader-one',origin=ORIGIN,now=NOW,fetcher=fetchImpl}={})=>{
    const headers={};if(user)headers.cookie='__Host-threadline-session='+(user==='reader-one'?'a':'b').repeat(43);if(origin!==null)headers.origin=origin;if(body!==undefined)headers['content-type']='application/json';
    return handleReaderUpdates(new Request(ORIGIN+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})}),env,{now,fetchImpl:fetcher});
  };
  return {sql,env,request,sends,fetchImpl};
}
async function optIn(f,preferences={alerts:true,weekly:true},user='reader-one') {
  const response=await f.request('/api/account/email-updates',{method:'PUT',body:preferences,user});assert.equal(response.status,200);
  const sent=f.sends.at(-1),link=sent.text.match(/https:\/\/threadnews\.online\/api\/email\/confirm\?token=[A-Za-z0-9_-]+/)[0];
  const url=new URL(link);return {path:url.pathname+url.search,link};
}
async function confirmed(f,preferences={alerts:true,weekly:true},user='reader-one') {const pending=await optIn(f,preferences,user);assert.equal((await f.request(pending.path,{method:'POST',user:null,origin:null})).status,200);return pending;}
function addEvent(f,id='fixture-event',count=12) {
  const event={id,title:'Tracked infrastructure',milestones:Array.from({length:count},(_,i)=>({title:'Milestone '+i,date:'2026-10-'+String(i+1).padStart(2,'0'),summary:'A documented source statement.',sources:[{url:'https://agency.example.test/release'}]}))};
  f.sql.prepare('INSERT INTO event_payloads (id,title,category,region,updated_at,payload_json,content_hash) VALUES (?,?,?,?,?,?,?)').run(id,event.title,'Infrastructure','Asia',new Date(NOW*1000).toISOString(),JSON.stringify(event),'fixture');return event;
}
function coverage(f,id,eventId='fixture-event',seen=NOW+10) {
  const published=new Date((NOW+1)*1000).toISOString(),at=new Date(seen*1000).toISOString(),payload={title:'Source headline '+id,eventId,source:{publisher:'Agency',url:'https://agency.example.test/'+id}};
  f.sql.prepare('INSERT INTO event_coverage (id,event_id,source_url,news_id,published_at,first_seen_at,last_seen_at,payload_json,content_hash) VALUES (?,?,?,?,?,?,?,?,?)').run(id,eventId,payload.source.url,id,published,at,at,JSON.stringify(payload),'fixture');
}

test('email settings require a session and same-origin mutations and reject arbitrary recipient addresses',async()=>{
  const f=await fixture();
  assert.equal((await f.request('/api/account/email-updates',{user:null})).status,401);
  assert.equal((await f.request('/api/account/email-updates',{method:'PUT',origin:'https://attacker.example',body:{alerts:true,weekly:true}})).status,403);
  await f.request('/api/account/email-updates',{method:'PUT',body:{alerts:true,weekly:false,email:'victim@example.test'}});
  assert.deepEqual(f.sends[0].to,['reader-one@example.test']);
  assert.ok(!JSON.stringify(f.sends[0]).includes('victim@example.test'));f.sql.close();
});
test('confirmation requires a user action, is one-use and precedes all digest delivery',async()=>{
  const f=await fixture(),pending=await optIn(f);
  assert.equal(f.sql.prepare('SELECT status FROM reader_updates').get().status,'pending');
  await f.request(pending.path,{user:null,origin:null});
  assert.equal(f.sql.prepare('SELECT status FROM reader_updates').get().status,'pending');
  const before=f.sends.length;await dispatchReaderUpdates(f.env,{now:NOW+1,fetchImpl:f.fetchImpl});assert.equal(f.sends.length,before);
  assert.equal((await f.request(pending.path,{method:'POST',user:null,origin:null})).status,200);
  assert.equal((await f.request(pending.path,{method:'POST',user:null,origin:null})).status,400);
  assert.equal(f.sql.prepare('SELECT status FROM reader_updates').get().status,'confirmed');
  assert.equal(f.sql.prepare('SELECT payload_json FROM reader_email_outbox').get().payload_json,'{}');f.sql.close();
});
test('unconfigured delivery sends nothing, preserves follows and honestly refuses opt-in',async()=>{
  const f=await fixture({EMAIL_SEND_ENABLED:'false'});
  const response=await f.request('/api/account/email-updates',{method:'PUT',body:{alerts:true,weekly:true}});assert.equal(response.status,503);
  assert.equal(deliveryConfig(f.env).enabled,false);
  assert.equal((await dispatchReaderUpdates(f.env,{now:NOW,fetchImpl:f.fetchImpl})).skipped,'email_not_configured');assert.equal(f.sends.length,0);f.sql.close();
});
test('confirmation email is rate-limited, and a new confirmation revokes the previous link',async()=>{
  const f=await fixture(),first=await optIn(f);
  assert.equal((await f.request('/api/account/email-updates',{method:'PUT',body:{alerts:true,weekly:true},now:NOW+1})).status,429);
  assert.equal((await f.request('/api/account/email-updates',{method:'PUT',body:{alerts:true,weekly:true},now:NOW+301})).status,200);
  assert.equal((await f.request(first.path,{method:'POST',user:null,origin:null,now:NOW+302})).status,400);f.sql.close();
});
test('an unconsumed confirmation link expires after 24 hours',async()=>{
  const f=await fixture(),pending=await optIn(f);
  assert.equal((await f.request(pending.path,{method:'POST',user:null,origin:null,now:NOW+86401})).status,400);
  assert.equal(f.sql.prepare('SELECT status FROM reader_updates').get().status,'pending');f.sql.close();
});
test('private feeds are account scoped and old tokens stop working after regeneration and account deletion',async()=>{
  const f=await fixture(),event=addEvent(f);coverage(f,'source-one');
  f.sql.prepare('INSERT INTO reading_saves (user_id,record_type,record_id,saved_at) VALUES (?,?,?,?)').run('reader-one','event',event.id,NOW);
  const one=await (await f.request('/api/account/feed-links')).json(),two=await (await f.request('/api/account/feed-links',{user:'reader-two'})).json();
  const url=new URL(one.links.rss),second=new URL(two.links.rss);
  assert.match(await (await f.request(url.pathname+url.search,{user:null})).text(),/Source headline source-one/);
  assert.doesNotMatch(await (await f.request(second.pathname+second.search,{user:null})).text(),/Source headline source-one/);
  await f.request('/api/account/feed-links',{method:'POST'});assert.equal((await f.request(url.pathname+url.search,{user:null})).status,401);
  const newLinks=await (await f.request('/api/account/feed-links')).json(),fresh=new URL(newLinks.links.rss);
  f.sql.prepare('DELETE FROM users WHERE id=?').run('reader-one');assert.equal((await f.request(fresh.pathname+fresh.search,{user:null})).status,401);f.sql.close();
});
test('event calendars follow the same free-window and paid-access restrictions as the event API',async()=>{
  const f=await fixture();addEvent(f);
  const before=await f.request('/api/events/fixture-event/calendar.ics',{user:null});assert.equal((await before.text()).match(/BEGIN:VEVENT/g).length,12);
  Object.assign(f.env,{BILLING_ENABLED:'true',PAYPAL_ENV:'live',PAYPAL_CLIENT_ID:'fixture',PAYPAL_CLIENT_SECRET:'fixture',PAYPAL_WEBHOOK_ID:'fixture',PAYPAL_PLAN_MONTHLY_ID:'P-MONTH',PAYPAL_PLAN_ANNUAL_ID:'P-YEAR',PAYPAL_SUBSCRIPTIONS_ACCESS:'true',TERMS_PUBLISHED:'true',TERMS_VERSION:'fixture-v1',LEGAL_SELLER_NAME:'Fixture seller',LEGAL_SELLER_TYPE:'individual',LEGAL_SELLER_ADDRESS:'Fixture address for unit tests only',LEGAL_SELLER_COUNTRY:'India',REFUND_WINDOW_DAYS:'14'});
  const after=await f.request('/api/events/fixture-event/calendar.ics',{user:null,now:Math.floor(Date.parse('2026-12-10')/1000)});assert.equal((await after.text()).match(/BEGIN:VEVENT/g).length,10);assert.equal(after.headers.get('cache-control'),'private, no-store');f.sql.close();
});
test('RSS escapes publisher text and ICS escapes injection and folds Unicode without splitting bytes',async()=>{
  const rss=coverageRss('A & B',[{id:'one',eventId:'fixture',title:'<script>&',publishedAt:'2026-11-04',source:{publisher:'A&B',url:'https://source.example'}}],ORIGIN,ORIGIN+'/feed');assert.match(rss,/&lt;script&gt;&amp;/);assert.doesNotMatch(rss,/<script>/);
  const ics=await timelineCalendar([{id:'fixture',title:'A',milestones:[{title:'Bad\rBEGIN:VALARM\n'+('語'.repeat(60)),date:'2026-11-04'},{title:'Invalid date',date:'2026-02-31'}]}],{origin:ORIGIN});
  assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,1);assert.doesNotMatch(ics,/\r\nBEGIN:VALARM/);for(const line of ics.trimEnd().split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
});
test('alerts deliver all equally timestamped batches once and unsubscribe stops queued messages',async()=>{
  const f=await fixture();await confirmed(f,{alerts:true,weekly:false});addEvent(f);f.sql.prepare('INSERT INTO reading_saves (user_id,record_type,record_id,saved_at) VALUES (?,?,?,?)').run('reader-one','event','fixture-event',NOW);
  for(let i=0;i<21;i++)coverage(f,'coverage-'+String(i).padStart(2,'0'));
  assert.equal((await dispatchReaderUpdates(f.env,{now:NOW+20,fetchImpl:f.fetchImpl})).sent,1);
  assert.equal((await dispatchReaderUpdates(f.env,{now:NOW+21,fetchImpl:f.fetchImpl})).sent,1);
  assert.equal((await dispatchReaderUpdates(f.env,{now:NOW+22,fetchImpl:f.fetchImpl})).sent,0);
  const header=f.sends.at(-1).providerHeaders['Idempotency-Key'];assert.ok(header.startsWith('alerts-'));
  const unsubscribe=new URL(f.sends.at(-1).headers['List-Unsubscribe'].slice(1,-1));
  await f.request(unsubscribe.pathname+unsubscribe.search,{user:null,origin:null});assert.equal(f.sql.prepare('SELECT status FROM reader_updates').get().status,'confirmed');
  await f.request(unsubscribe.pathname+unsubscribe.search,{method:'POST',user:null,origin:null});assert.equal(f.sql.prepare('SELECT status FROM reader_updates').get().status,'unsubscribed');
  coverage(f,'later',undefined,NOW+40);assert.equal((await dispatchReaderUpdates(f.env,{now:NOW+50,fetchImpl:f.fetchImpl})).sent,0);f.sql.close();
});
test('provider failure retries using the same idempotency key and daily send budget is enforced',async()=>{
  const f=await fixture({EMAIL_DAILY_LIMIT:'1'}),calls=[];
  const fail=async(url,options)=>{calls.push(options.headers['Idempotency-Key']);return Response.json({secret:'must not appear'}, {status:503});};
  assert.equal((await f.request('/api/account/email-updates',{method:'PUT',body:{alerts:true,weekly:true},fetcher:fail})).status,200);
  assert.equal(f.sql.prepare('SELECT error_code FROM reader_email_outbox').get().error_code,'email_provider_http_503');
  assert.equal((await dispatchReaderUpdates(f.env,{now:NOW+500,fetchImpl:f.fetchImpl})).skipped,'daily_email_budget');assert.equal(f.sends.length,0);assert.equal(calls.length,1);f.sql.close();
});
test('weekly briefs follow reader interests, include unsubscribe and postal address, and send once per week',async()=>{
  const f=await fixture();await confirmed(f,{alerts:false,weekly:true});
  f.sql.prepare('INSERT INTO preferences (user_id,topics_json,updated_at) VALUES (?,?,?)').run('reader-one','["Economy"]',NOW);
  const insert=f.sql.prepare('INSERT INTO news (id,canonical_url,title,original_headline,summary,category,region,published_at,ingested_at,source_json,feed_id,publisher) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  for(const [id,category] of [['economic-story','Economy'],['world-story','World']])insert.run(id,'https://source.example/'+id,id,id,'',category,'World',new Date((NOW-100)*1000).toISOString(),new Date(NOW*1000).toISOString(),'{}','fixture','Fixture source');
  assert.equal((await dispatchReaderUpdates(f.env,{now:NOW+1,fetchImpl:f.fetchImpl})).sent,1);
  const mail=f.sends.at(-1);assert.match(mail.text,/economic-story/);assert.doesNotMatch(mail.text,/world-story/);assert.match(mail.text,/Fixture sender address/);assert.match(mail.headers['List-Unsubscribe'],/^<https:/);
  assert.equal((await dispatchReaderUpdates(f.env,{now:NOW+2,fetchImpl:f.fetchImpl})).sent,0);
  const exported=await readerUpdatesExport(f.env,'reader-one');assert.equal(exported.weeklyBrief,true);assert.ok(!JSON.stringify(exported).includes('fixture-signing'));assert.ok(!JSON.stringify(exported).includes('token='));f.sql.close();
});
test('provider retries keep the same key and a changed verified account email prevents sending to the old address',async()=>{
  const f=await fixture(),keys=[];
  await f.request('/api/account/email-updates',{method:'PUT',body:{alerts:true,weekly:false},fetcher:async(url,options)=>{keys.push(options.headers['Idempotency-Key']);return Response.json({}, {status:503});}});
  await dispatchReaderUpdates(f.env,{now:NOW+121,fetchImpl:async(url,options)=>{keys.push(options.headers['Idempotency-Key']);return f.fetchImpl(url,options);}});
  assert.deepEqual(keys,[keys[0],keys[0]]);assert.equal(f.sends.length,1);
  f.sql.prepare("UPDATE reader_updates SET status='confirmed',alerts_enabled=1,confirmed_at=?,alert_cursor_at=? WHERE user_id='reader-one'").run(NOW,new Date(NOW*1000).toISOString());
  addEvent(f);coverage(f,'new-source');f.sql.prepare('INSERT INTO reading_saves (user_id,record_type,record_id,saved_at) VALUES (?,?,?,?)').run('reader-one','event','fixture-event',NOW);
  f.sql.prepare("UPDATE users SET email='changed@example.test' WHERE id='reader-one'").run();
  assert.equal((await dispatchReaderUpdates(f.env,{now:NOW+150,fetchImpl:f.fetchImpl})).sent,0);assert.equal(f.sends.length,1);f.sql.close();
});
test('bounded subscriber scans rotate fairly beyond the first twenty accounts',async()=>{
  const f=await fixture();
  for(let i=0;i<21;i++) {
    const id='weekly-reader-'+String(i).padStart(2,'0'),email=id+'@example.test';
    f.sql.prepare('INSERT INTO users (id,provider,provider_subject,name,email,created_at) VALUES (?,?,?,?,?,?)').run(id,'google',id,'Fixture',email,NOW);
    f.sql.prepare("INSERT INTO reader_updates (user_id,email,status,weekly_enabled,feed_version,confirmed_at,created_at,updated_at) VALUES (?,?,'confirmed',1,?,?,?,?)").run(id,email,'fixture-version',NOW-1,NOW-1,NOW-1);
  }
  await dispatchReaderUpdates(f.env,{now:NOW,fetchImpl:f.fetchImpl});
  assert.equal(f.sql.prepare("SELECT last_checked_at FROM reader_updates WHERE user_id='weekly-reader-20'").get().last_checked_at,0);
  await dispatchReaderUpdates(f.env,{now:NOW+1,fetchImpl:f.fetchImpl});
  assert.equal(f.sql.prepare("SELECT last_checked_at FROM reader_updates WHERE user_id='weekly-reader-20'").get().last_checked_at,NOW+1);assert.equal(f.sends.length,0);f.sql.close();
});
