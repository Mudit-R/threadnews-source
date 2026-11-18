import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { handleAuth, COLLECTION_LIMITS, privacyNotice } from '../src/auth.js';
import { sha256 } from '../src/feed.js';

async function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  let queries=0;
  const DB={
    prepare(query){return {query,args:[],bind(...args){return {...this,args};},async first(){queries++;return sql.prepare(this.query).get(...this.args)||null;},async all(){queries++;return {results:sql.prepare(this.query).all(...this.args)};},async run(){queries++;return {success:true,meta:{changes:sql.prepare(this.query).run(...this.args).changes}};}};},
    async batch(statements){sql.exec('BEGIN');try{const results=[];for(const stmt of statements)results.push(await stmt.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}
  };
  const now=Math.floor(Date.now()/1000),tokens={one:'x'.repeat(43),two:'y'.repeat(43)};
  for(const user of ['one','two']){
    sql.prepare('INSERT INTO users (id,provider,provider_subject,name,email,created_at) VALUES (?,?,?,?,?,?)').run(user,'google','sub-'+user,'Reader '+user,user+'@example.com',now);
    sql.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(await sha256(tokens[user]),user,now+3600);
    sql.prepare('INSERT INTO preferences (user_id,topics_json,updated_at) VALUES (?,?,?)').run(user,'["Economy"]',now);
  }
  sql.prepare('INSERT INTO news (id,canonical_url,title,original_headline,summary,category,region,published_at,ingested_at,source_json,feed_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('known','https://example.com/article','A story','A story','','Economy','Asia',new Date().toISOString(),new Date().toISOString(),'{}','fixture');
  sql.prepare('INSERT INTO event_payloads (id,title,category,region,updated_at,payload_json,content_hash) VALUES (?,?,?,?,?,?,?)').run('event-one','A timeline','Economy','Asia',new Date().toISOString(),'{}','hash');
  const env={DB,APP_ORIGIN:'https://threadnews.example'};
  async function request(path,{user='one',method='GET',body,origin='https://threadnews.example'}={}){
    const headers={};if(user)headers.cookie='__Host-threadline-session='+tokens[user];
    if(origin!==null)headers.origin=origin;
    if(body!==undefined)headers['content-type']='application/json';
    const response=await handleAuth(new Request('https://threadnews.example'+path,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);
    return {response,data:await response.json()};
  }
  return {sql,env,request,get queries(){return queries;}};
}

test('account data requires a valid session and mutations require the exact app origin',async()=>{
  const f=await fixture();
  for(const path of ['/api/account','/api/account/export','/api/account/collection'])assert.equal((await f.request(path,{user:null})).response.status,401);
  for(const origin of [null,'https://attacker.example'])assert.equal((await f.request('/api/account/collection',{method:'PATCH',origin,body:{type:'article',id:'known',saved:true}})).response.status,403);
  assert.equal((await f.request('/api/account/collection',{method:'PATCH',user:null,body:{type:'article',id:'known',saved:true}})).response.status,401);
  assert.equal((await f.request('/api/account/unknown')).response.status,404);
  f.sql.close();
});

test('account collections are isolated, idempotent, reject unknown records, and retain expired article saves',async()=>{
  const f=await fixture();
  const change=(id,saved=true,type='article',user='one')=>f.request('/api/account/collection',{method:'PATCH',user,body:{type,id,saved}});
  assert.equal((await change('https://attacker.example')).response.status,400);
  assert.equal((await change('unknown')).response.status,404);
  assert.deepEqual((await change('known')).data.collection.articles,['known']);
  await change('known');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM reading_saves').get().n,1);
  assert.deepEqual((await f.request('/api/account/collection',{user:'two'})).data.collection.articles,[]);
  await change('event-one',true,'event');
  f.sql.prepare('DELETE FROM news WHERE id=?').run('known');
  assert.deepEqual((await f.request('/api/account/collection')).data.collection.articles,['known']);
  assert.deepEqual((await change('known',false)).data.collection.articles,[]);
  assert.deepEqual((await f.request('/api/account/collection')).data.collection.events,['event-one']);
  f.sql.close();
});

test('guest import validates before writing, reports unavailable IDs and uses bounded SQL rather than per-ID statements',async()=>{
  const f=await fixture(),before=f.queries;
  const invalid=await f.request('/api/account/collection/import',{method:'POST',body:{articles:['known'],events:['../../invalid']}});
  assert.equal(invalid.response.status,400);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM reading_saves').get().n,0);
  const result=await f.request('/api/account/collection/import',{method:'POST',body:{articles:['known','known','missing'],events:['event-one','missing-event']}});
  assert.deepEqual(result.data.collection.articles,['known']);assert.deepEqual(result.data.notAdded.articles,['missing']);
  assert.deepEqual(result.data.collection.events,['event-one']);assert.deepEqual(result.data.notAdded.events,['missing-event']);
  assert(f.queries-before<15);
  const body={articles:Array(COLLECTION_LIMITS.articles+1).fill('known')};
  assert.equal((await f.request('/api/account/collection/import',{method:'POST',body})).response.status,400);
  f.sql.close();
});

test('server limits cannot be bypassed by imports or repeated saves',async()=>{
  const f=await fixture(),insert=f.sql.prepare('INSERT INTO reading_saves VALUES (?,?,?,?)');
  for(let i=0;i<COLLECTION_LIMITS.articles;i++)insert.run('one','article','old-'+i,1);
  const request=()=>f.request('/api/account/collection',{method:'PATCH',body:{type:'article',id:'known',saved:true}});
  assert.equal((await request()).response.status,409);
  const result=await f.request('/api/account/collection/import',{method:'POST',body:{articles:['known']}});
  assert.equal(result.data.collection.articles.length,COLLECTION_LIMITS.articles);assert.deepEqual(result.data.notAdded.articles,['known']);
  await f.request('/api/account/collection',{method:'PATCH',body:{type:'article',id:'old-0',saved:false}});
  assert.equal((await request()).response.status,200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM reading_saves').get().n,COLLECTION_LIMITS.articles);
  f.sql.close();
});

test('export contains only the current reader data and never credentials or session hashes',async()=>{
  const f=await fixture();await f.request('/api/account/collection',{method:'PATCH',body:{type:'event',id:'event-one',saved:true}});
  for(const id of ['one','two'])f.sql.prepare('INSERT INTO membership_consents (id,user_id,terms_version,plan_key,amount,currency,first_charge_at,accepted_at) VALUES (?,?,?,?,?,?,?,?)').run('consent-'+id,id,'2026-11-v1','monthly','2.00','USD','2026-11-30T18:30:00.000Z',1793700000);
  const {response,data}=await f.request('/api/account/export');
  assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-disposition'),/attachment/);
  assert.equal(data.user.id,'one');assert.equal(data.user.providerSubject,'sub-one');assert.deepEqual(data.preferences.topics,['Economy']);assert.deepEqual(data.collection.events,['event-one']);
  assert.deepEqual(data.membershipConsents,{available:true,records:[{termsVersion:'2026-11-v1',planKey:'monthly',amount:'2.00',currency:'USD',firstChargeAt:'2026-11-30T18:30:00.000Z',billingStartChoice:'scheduled',acceptedAt:new Date(1793700000*1000).toISOString()}]});
  assert(!JSON.stringify(data).includes('sub-two'));assert(!JSON.stringify(data).includes('token_hash'));assert(!JSON.stringify(data).includes('x'.repeat(43)));
  f.sql.close();
});

test('account export reports unavailable consent history on the older schema',async()=>{
  const f=await fixture();f.sql.exec('DROP TABLE membership_consents');
  const {response,data}=await f.request('/api/account/export');
  assert.equal(response.status,200);assert.deepEqual(data.membershipConsents,{available:false,records:[]});
  f.sql.close();
});

test('account export includes only safe reader email preferences and delivery metadata',async()=>{
  const f=await fixture(),now=Math.floor(Date.now()/1000);
  f.sql.prepare('INSERT INTO reader_updates (user_id,email,status,alerts_enabled,weekly_enabled,confirmed_at,confirm_hash,feed_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('one','one@example.com','confirmed',1,1,now,'private-confirmation-hash','private-feed-version',now,now);
  f.sql.prepare('INSERT INTO reader_email_outbox (id,user_id,kind,state,payload_json,created_at,sent_at,attempts) VALUES (?,?,?,?,?,?,?,?)')
    .run('outbox-one','one','alerts','sent','{"secret":"private-queued-body"}',now,now,1);
  const {response,data}=await f.request('/api/account/export');
  assert.equal(response.status,200);assert.equal(data.readerUpdatesAvailable,true);
  assert.equal(data.readerUpdates.eventAlerts,true);assert.equal(data.readerUpdates.weeklyBrief,true);
  assert.equal(data.readerUpdates.deliveryHistory[0].kind,'alerts');
  assert.equal(data.readerUpdates.deliveryHistory[0].state,'sent');
  const serialized=JSON.stringify(data);
  for(const privateValue of ['private-confirmation-hash','private-feed-version','private-queued-body'])assert.ok(!serialized.includes(privateValue));
  f.sql.close();
});

test('account deletion confirms intent and removes all active personal records for only that reader',async()=>{
  const f=await fixture();await f.request('/api/account/collection',{method:'PATCH',body:{type:'article',id:'known',saved:true}});
  assert.equal((await f.request('/api/account',{method:'DELETE',body:{confirm:'delete'}})).response.status,400);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM users').get().n,2);
  const {response,data}=await f.request('/api/account',{method:'DELETE',body:{confirm:'DELETE'}});
  assert.equal(data.deleted,true);assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  for(const table of ['users','sessions','preferences','reading_saves','reading_collection_state']){
    const column=table==='users'?'id':'user_id';assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`).get('one').n,0);
  }
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM users WHERE id=?').get('two').n,1);
  assert.equal((await f.request('/api/account')).response.status,401);
  assert.equal((await f.request('/api/account',{user:'two'})).response.status,200);
  f.sql.close();
});

test('privacy notice uses only explicitly configured public operator/contact information',()=>{
  assert.equal(privacyNotice({}).contact,null);assert.equal(privacyNotice({}).operator,null);
  assert.equal(privacyNotice({PRIVACY_CONTACT_URL:'javascript:alert(1)'}).contact,null);
  assert.equal(privacyNotice({PRIVACY_CONTACT_URL:'https://operator.example/privacy',SITE_OPERATOR_NAME:'ThreadNews operator'}).contact,'https://operator.example/privacy');
});
