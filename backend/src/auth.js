import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';
import { plainText, readLimited, sha256 } from './feed.js';
import { appleEncryptionKeyBytes, encryptAppleRefreshToken, decryptAppleRefreshToken } from './apple-tokens.js';
import { readerUpdatesExport } from './reader-updates.js';

const SESSION_COOKIE='__Host-threadline-session';
const OAUTH_COOKIE='__Host-threadline-oauth';
const SESSION_AGE=7*86400;
const ATTEMPT_AGE=600;
export const COLLECTION_LIMITS=Object.freeze({articles:500,events:200});
const RECORD_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const GOOGLE_KEYS=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const APPLE_KEYS=createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
export const TOPICS=['World affairs','India','Politics','Business','Economy','Technology','Climate','Environment','Health','Science','Space & science','Infrastructure','Sport','Sports','Culture'];
const json=(body,status=200,headers={})=>Response.json(body,{status,headers:{'cache-control':'no-store',...headers}});
const random=()=>{const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const cookie=(name,value,age,sameSite='Lax')=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${age}`;
export function readCookie(request,name){for(const part of(request.headers.get('cookie')||'').split(';')){const at=part.indexOf('=');if(part.slice(0,at).trim()===name)return part.slice(at+1).trim();}return '';}
export function appOrigin(env){try{const u=new URL(env.APP_ORIGIN);if(u.protocol==='https:'&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password)return u.origin;}catch{}return null;}
export function providerConfig(env){
  const common=!!env.DB&&!!appOrigin(env);
  const google=common&&!!env.GOOGLE_CLIENT_ID&&!!env.GOOGLE_CLIENT_SECRET;
  const apple=common&&env.APPLE_SIGN_IN_ENABLED==='true'&&/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/.test(env.APPLE_CLIENT_ID||'')
    &&/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID||'')&&/^[A-Z0-9]{10}$/.test(env.APPLE_KEY_ID||'')
    &&/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+\s+-----END PRIVATE KEY-----\s*$/.test(String(env.APPLE_PRIVATE_KEY||'').replace(/\\n/g,'\n'))
    &&!!appleEncryptionKeyBytes(env.APPLE_TOKEN_ENCRYPTION_KEY);
  return {guestReading:true,providers:[
    {id:'google',label:'Continue with Google',enabled:google,startUrl:google?'/api/auth/google/start':null,reason:google?null:'Google sign-in is not available right now. You can keep reading without an account.'},
    {id:'apple',label:'Continue with Apple',enabled:apple,startUrl:apple?'/api/auth/apple/start':null,reason:apple?null:'Apple sign-in is not available yet. Use an available option above or keep reading without an account.'}
  ]};
}
export function sameOriginMutation(request,env){return request.headers.get('origin')===(appOrigin(env)||new URL(request.url).origin);}
async function sessionRecord(request,env){
  const token=readCookie(request,SESSION_COOKIE);if(!env.DB||!/^[A-Za-z0-9_-]{40,60}$/.test(token))return null;
  return await env.DB.prepare('SELECT u.id,u.provider,u.name,u.email,u.picture,p.topics_json,p.news_country FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN preferences p ON p.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').bind(await sha256(token),Math.floor(Date.now()/1000)).first();
}
function savedPreferences(row) {
  let topics = [];
  try { topics = JSON.parse(row.topics_json || '[]'); } catch {}
  return { topics: Array.isArray(topics) ? topics : [], ...(row.news_country ? { newsCountry: row.news_country } : {}) };
}
export async function currentSession(request,env){
  const row=await sessionRecord(request,env);
  if(!row)return {user:null,preferences:{topics:[]}};
  return {user:{id:row.id,name:row.name,email:row.email,picture:row.picture},preferences:savedPreferences(row)};
}
function callbackUrl(provider,env){return `${appOrigin(env)}/api/auth/${provider}/callback`;}
async function start(provider,env){
  const config=providerConfig(env).providers.find(x=>x.id===provider);
  if(!config?.enabled)return json({error:'provider_not_configured',message:config?.reason||'Unknown provider'},503);
  const state=random(),binding=random(),verifier=random(),nonce=random(),expires=Math.floor(Date.now()/1000)+ATTEMPT_AGE;
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  const challenge=btoa(String.fromCharCode(...digest)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_attempts WHERE expires_at<?').bind(Math.floor(Date.now()/1000)),
    env.DB.prepare('INSERT INTO oauth_attempts (state_hash,binding_hash,provider,verifier,nonce,expires_at) VALUES (?,?,?,?,?,?)').bind(await sha256(state),await sha256(binding),provider,verifier,nonce,expires)
  ]);
  const url=new URL(provider==='google'?'https://accounts.google.com/o/oauth2/v2/auth':'https://appleid.apple.com/auth/authorize');
  url.searchParams.set('client_id',provider==='google'?env.GOOGLE_CLIENT_ID:env.APPLE_CLIENT_ID);
  url.searchParams.set('redirect_uri',callbackUrl(provider,env));url.searchParams.set('response_type','code');url.searchParams.set('state',state);url.searchParams.set('nonce',nonce);
  if(provider==='google'){url.searchParams.set('scope','openid email profile');url.searchParams.set('code_challenge',challenge);url.searchParams.set('code_challenge_method','S256');}
  else{url.searchParams.set('scope','name email');url.searchParams.set('response_mode','form_post');}
  return new Response(null,{status:302,headers:{location:url.href,'set-cookie':cookie(OAUTH_COOKIE,binding,ATTEMPT_AGE,provider==='apple'?'None':'Lax'),'cache-control':'no-store','referrer-policy':'no-referrer'}});
}
export async function appleClientSecret(env){
  const key=await importPKCS8(env.APPLE_PRIVATE_KEY.replace(/\\n/g,'\n'),'ES256');
  return new SignJWT({}).setProtectedHeader({alg:'ES256',kid:env.APPLE_KEY_ID}).setIssuer(env.APPLE_TEAM_ID).setAudience('https://appleid.apple.com').setSubject(env.APPLE_CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(key);
}
async function callback(request,provider,env){
  const config=providerConfig(env).providers.find(x=>x.id===provider);
  if(!config?.enabled)return json({error:'provider_not_configured'},503);
  let params;
  if(provider==='apple'){
    if(request.method!=='POST'||!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return json({error:'invalid_callback'},400);
    if(Number(request.headers.get('content-length'))>16384)return json({error:'callback_too_large'},413);
    let body;try{body=await readLimited(request,16384);}catch{return json({error:'callback_too_large'},413);}params=new URLSearchParams(body);
  }else{if(request.method!=='GET')return json({error:'invalid_callback'},405);params=new URL(request.url).searchParams;}
  const state=params.get('state')||'',code=params.get('code')||'',binding=readCookie(request,OAUTH_COOKIE);
  if(!/^[A-Za-z0-9_-]{40,60}$/.test(state)||!/^[A-Za-z0-9_-]{40,60}$/.test(binding)||!code||code.length>4096)return authFailure(env);
  // DELETE RETURNING makes a valid state one-use even if callbacks race.
  const attempt=await env.DB.prepare('DELETE FROM oauth_attempts WHERE state_hash=? AND binding_hash=? AND provider=? AND expires_at>? RETURNING verifier,nonce').bind(await sha256(state),await sha256(binding),provider,Math.floor(Date.now()/1000)).first();
  if(!attempt)return authFailure(env);
  let payload,appleRefreshToken=null;
  try{
    const form=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:callbackUrl(provider,env),client_id:provider==='google'?env.GOOGLE_CLIENT_ID:env.APPLE_CLIENT_ID,client_secret:provider==='google'?env.GOOGLE_CLIENT_SECRET:await appleClientSecret(env)});
    if(provider==='google')form.set('code_verifier',attempt.verifier);
    const result=await fetch(provider==='google'?'https://oauth2.googleapis.com/token':'https://appleid.apple.com/auth/token',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body:form,signal:AbortSignal.timeout(10000)});
    if(!result.ok)return authFailure(env);
    let tokens;try{tokens=JSON.parse(await readLimited(result,64*1024));}catch{return authFailure(env);}
    if(typeof tokens.id_token!=='string'||tokens.id_token.length>16384)return authFailure(env);
    ({payload}=await jwtVerify(tokens.id_token,provider==='google'?GOOGLE_KEYS:APPLE_KEYS,{issuer:provider==='google'?['https://accounts.google.com','accounts.google.com']:'https://appleid.apple.com',audience:provider==='google'?env.GOOGLE_CLIENT_ID:env.APPLE_CLIENT_ID,algorithms:['RS256'],requiredClaims:['sub','iss','aud','exp','iat','nonce'],maxTokenAge:'10m',clockTolerance:10}));
    if(provider==='apple'&&typeof tokens.refresh_token==='string'&&tokens.refresh_token.length<=8192)appleRefreshToken=tokens.refresh_token;
  }catch{return authFailure(env);}
  if(payload.nonce!==attempt.nonce||typeof payload.sub!=='string')return authFailure(env);
  const now=Math.floor(Date.now()/1000),id=provider+'-'+(await sha256(payload.sub)).slice(0,40);
  let encryptedAppleToken=null;
  if(provider==='apple'){
    try{
      if(appleRefreshToken)encryptedAppleToken=await encryptAppleRefreshToken(env,id,appleRefreshToken);
      else if(!await env.DB.prepare('SELECT user_id FROM apple_tokens WHERE user_id=?').bind(id).first())return authFailure(env);
    }catch{return authFailure(env);}
  }
  let name=plainText(payload.name||'',100);
  if(provider==='apple'&&!name&&params.get('user')){try{const u=JSON.parse(params.get('user'));name=plainText([u.name?.firstName,u.name?.lastName].filter(Boolean).join(' '),100);}catch{}}
  const email=(payload.email_verified===true||payload.email_verified==='true')&&typeof payload.email==='string'?payload.email.slice(0,320):null;
  let picture=null;try{if(provider==='google'&&new URL(payload.picture).protocol==='https:')picture=payload.picture;}catch{}
  const token=random();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id,provider,provider_subject,name,email,picture,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,provider_subject) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE users.name END,email=COALESCE(excluded.email,users.email),picture=COALESCE(excluded.picture,users.picture)").bind(id,provider,payload.sub,name,email,picture,now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').bind(await sha256(token),id,now+SESSION_AGE),
    ...(encryptedAppleToken?[env.DB.prepare('INSERT INTO apple_tokens (user_id,encrypted_token,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted_token=excluded.encrypted_token,updated_at=excluded.updated_at').bind(id,encryptedAppleToken,now)]:[])
  ]);
  // Apple refresh tokens are retained only as encrypted revocation credentials.
  // Google provider tokens and Apple access tokens are not retained.
  const headers=new Headers({'location':appOrigin(env)+'/#/','cache-control':'no-store','referrer-policy':'no-referrer'});
  headers.append('set-cookie',cookie(SESSION_COOKIE,token,SESSION_AGE));headers.append('set-cookie',cookie(OAUTH_COOKIE,'',0,provider==='apple'?'None':'Lax'));
  return new Response(null,{status:303,headers});
}
function authFailure(env){return new Response(null,{status:303,headers:{'location':appOrigin(env)+'/?auth_error=sign_in_failed#/','set-cookie':cookie(OAUTH_COOKIE,'',0,'None'),'cache-control':'no-store'}});}

class AccountError extends Error { constructor(code,status=400){super(code);this.status=status;} }
async function revokeAppleForDeletion(env,userId){
  const record=await env.DB.prepare('SELECT encrypted_token FROM apple_tokens WHERE user_id=?').bind(userId).first();
  if(!record?.encrypted_token)throw new AccountError('apple_reauthentication_required',409);
  try{
    const token=await decryptAppleRefreshToken(env,userId,record.encrypted_token);
    const form=new URLSearchParams({client_id:env.APPLE_CLIENT_ID,client_secret:await appleClientSecret(env),token,token_type_hint:'refresh_token'});
    const response=await fetch('https://appleid.apple.com/auth/revoke',{method:'POST',redirect:'manual',
      headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body:form,signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('revocation_unconfirmed');
    await readLimited(response,16384);
  }catch{throw new AccountError('apple_revocation_unavailable',503);}
}
async function bodyJSON(request,limit=96*1024){
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AccountError('json_required',415);
  if(Number(request.headers.get('content-length'))>limit)throw new AccountError('request_too_large',413);
  let body;try{body=await readLimited(request,limit);}catch{throw new AccountError('request_too_large',413);}
  let data;try{data=JSON.parse(body);}catch{throw new AccountError('invalid_json');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new AccountError('json_object_required');
  return data;
}
function identifiers(value,limit){
  if(!Array.isArray(value)||value.length>limit||value.some(id=>typeof id!=='string'||!RECORD_ID.test(id)))throw new AccountError('invalid_collection_ids');
  return [...new Set(value)];
}
async function readingCollection(env,userId){
  const [saved,state]=await Promise.all([
    env.DB.prepare('SELECT record_type,record_id,saved_at FROM reading_saves WHERE user_id=? ORDER BY saved_at DESC,record_id').bind(userId).all(),
    env.DB.prepare('SELECT updated_at FROM reading_collection_state WHERE user_id=?').bind(userId).first()
  ]);
  const rows=saved.results||[];
  return {articles:rows.filter(row=>row.record_type==='article').map(row=>row.record_id),events:rows.filter(row=>row.record_type==='event').map(row=>row.record_id),updatedAt:state?.updated_at?new Date(state.updated_at*1000).toISOString():null,limits:COLLECTION_LIMITS};
}
function collectionInsert(env,userId,type,ids,now){
  // The fixed table and limit are selected by code, not supplied by a reader.
  const table=type==='article'?'news':'event_payloads',limit=type==='article'?COLLECTION_LIMITS.articles:COLLECTION_LIMITS.events;
  // One statement per list stays within D1 query limits even for a large guest
  // import. NOT EXISTS prevents existing saves consuming the remaining slots.
  return env.DB.prepare(`INSERT INTO reading_saves (user_id,record_type,record_id,saved_at)
    SELECT ?,?,incoming.value,? FROM json_each(?) incoming
    WHERE EXISTS (SELECT 1 FROM ${table} WHERE id=incoming.value)
      AND NOT EXISTS (SELECT 1 FROM reading_saves WHERE user_id=? AND record_type=? AND record_id=incoming.value)
    ORDER BY CAST(incoming.key AS INTEGER)
    LIMIT MAX(0,?-(SELECT COUNT(*) FROM reading_saves WHERE user_id=? AND record_type=?))
    ON CONFLICT(user_id,record_type,record_id) DO NOTHING`).bind(userId,type,now,JSON.stringify(ids),userId,type,limit,userId,type);
}
function collectionStamp(env,userId,now){return env.DB.prepare('INSERT INTO reading_collection_state (user_id,updated_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET updated_at=excluded.updated_at').bind(userId,now);}
export function privacyNotice(env={}){
  let contact=null;
  try{const candidate=new URL(env.PRIVACY_CONTACT_URL);if(['https:','mailto:'].includes(candidate.protocol)&&!candidate.username&&!candidate.password)contact=candidate.href;}catch{}
  return {updatedAt:'2026-11-19',operator:plainText(env.SITE_OPERATOR_NAME||'',120)||null,contact,
    title:'Your data at ThreadNews',
    sections:[
      {title:'Reading as a guest',text:'You can read without an account. This browser can store your topic choices, saved article identifiers and followed timeline identifiers. You can clear them in browser settings. Signing in does not silently copy guest saves into an account; you can choose to import them.'},
      {title:'What could affect you',text:'Your optional region, life stage and issue choices stay in this browser. We fetch the same public article list for everyone and rank it on your device. If you choose to remember your choices, they are stored on that browser until you clear them or clear site data. They are not sent to an AI provider or linked to your account.'},
      {title:'Headline recommendations and followed stories',text:'Recommendation feedback is trained on your device. If you opt to remember it, the browser stores your votes, article identifiers and the model features derived from those public headlines. You can reset them in the recommendations panel. For signed-in followed story updates, ThreadNews stores when you marked a story checked. Unfollowing a story or deleting your account removes its checkpoint.'},
      {title:'Ask ThreadNews',text:'When you request an answer, ThreadNews sends your question and relevant evidence to Google Gemini or Cloudflare Workers AI. Evidence can include the archive report you opened if you have access. Do not include personal information in a question. ThreadNews does not send your account details. It may cache answers that use public records for up to an hour. Browse sources runs without an AI provider.'},
      {title:'When you sign in',text:'ThreadNews stores your provider identifier, display name, verified email address when provided, optional profile image URL, account creation time, chosen topics, your selected news country and saved article or timeline identifiers. Google or Apple handles provider authentication. ThreadNews does not store your provider password or access tokens. Google refresh tokens are not stored. For Apple accounts, a refresh token is encrypted with a separate server-only key so ThreadNews can revoke Apple authorization when you delete the account. The encrypted credential is excluded from account exports and removed with the account.'},
      {title:'Sessions and storage',text:'A secure HTTP-only cookie identifies your session. Only a hash of its random token is stored in the database. Sessions expire after seven days; expired session rows are cleaned during later sign-ins. Temporary sign-in attempts expire after ten minutes. Cloudflare Workers and D1 host the service and its account database.'},
      {title:'Subscriptions and payment',text:'If you choose a paid plan, ThreadNews stores the selected plan, PayPal subscription or order identifier, billing status, payment timestamps and the period through which access is available. It also records the membership terms version, plan amount and currency, first charge time and when you accepted the recurring terms. These consent records are included in your account export and do not store an IP address. PayPal processes checkout and stores payment instruments. ThreadNews does not store your card number, bank details, PayPal password or payment credentials. PayPal handles recurring billing and cancellation requests; ThreadNews uses verified PayPal notifications to update access.'},
      {title:'Your controls',text:'Your account page lets you download your profile, preferences, saved identifiers and ThreadNews billing status, remove saves, sign out, or delete the account. Before deleting an account linked to a recurring plan, ThreadNews asks PayPal to cancel that subscription; paid access may continue through the paid period. Account deletion removes the active profile, topic choices, reading saves, billing record and sessions. Infrastructure logs and recovery copies may have separate retention controlled by the hosting provider.'},
      {title:'Sources and external links',text:'News metadata keeps its original publication date and source link. Publisher links open external services governed by their own policies. Topic preferences and saved identifiers are used for your reading space, not sent to news publishers by these account features. A saved identifier can outlive an expired or removed article; saving it does not create a copy of the article.'}
      ,{title:'Optional email updates',text:'Event alerts and the weekly brief require your explicit opt-in and email confirmation. ThreadNews uses your verified account email, stores the requested update types and confirmation/unsubscribe dates, and sends messages through Resend when email delivery is enabled. The recipient address and message contents are shared with Resend to deliver those messages. Confirmation links expire after 24 hours. Queued message bodies are retained until delivery; successful delivery erases those bodies. Sent or failed delivery metadata is removed after seven days. Your account export includes update preferences and recent delivery status, not confirmation secrets or queued message contents. Account deletion removes active email preferences and delivery records.'}
    ],providers:[{name:'Resend (optional email)',url:'https://resend.com/legal/privacy-policy'},{name:'Cloudflare',url:'https://www.cloudflare.com/privacypolicy/'},{name:'Google',url:'https://policies.google.com/privacy'},{name:'Apple',url:'https://www.apple.com/legal/privacy/'},{name:'PayPal',url:'https://www.paypal.com/in/legalhub/paypal/privacy-full?locale.x=en_IN'}]};
}
async function accountRoutes(request,env,path){
  if(path==='/api/privacy')return request.method==='GET'?json(privacyNotice(env)):json({error:'method_not_allowed'},405,{allow:'GET'});
  if(!path.startsWith('/api/account'))return null;
  const methods={ '/api/account':['GET','DELETE'], '/api/account/export':['GET'], '/api/account/collection':['GET','PATCH'], '/api/account/collection/import':['POST'] };
  if(!methods[path])return json({error:'not_found'},404);
  if(!methods[path].includes(request.method))return json({error:'method_not_allowed'},405,{allow:methods[path].join(', ')});
  if(['PATCH','POST','DELETE'].includes(request.method)&&!sameOriginMutation(request,env))return json({error:'cross_origin_request'},403);
  const session=await sessionRecord(request,env);
  if(!session)return json({error:'sign_in_required'},401);
  const now=Math.floor(Date.now()/1000);
  if(path==='/api/account'&&request.method==='DELETE'){
    const data=await bodyJSON(request,1024);
    if(data.confirm!=='DELETE')return json({error:'deletion_confirmation_required'},400);
    if(session.provider==='apple')await revokeAppleForDeletion(env,session.id);
    // Explicitly scoped deletes also make the intended account boundary clear.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM reading_saves WHERE user_id=?').bind(session.id),
      env.DB.prepare('DELETE FROM reading_collection_state WHERE user_id=?').bind(session.id),
      env.DB.prepare('DELETE FROM preferences WHERE user_id=?').bind(session.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(session.id),
      env.DB.prepare('DELETE FROM users WHERE id=?').bind(session.id)
    ]);
    return json({ok:true,deleted:true},200,{'set-cookie':cookie(SESSION_COOKIE,'',0)});
  }
  if(path==='/api/account/collection/import'){
    const data=await bodyJSON(request),articles=identifiers(data.articles??[],COLLECTION_LIMITS.articles),events=identifiers(data.events??[],COLLECTION_LIMITS.events);
    await env.DB.batch([collectionInsert(env,session.id,'article',articles,now),collectionInsert(env,session.id,'event',events,now),collectionStamp(env,session.id,now)]);
    const collection=await readingCollection(env,session.id);
    return json({collection,notAdded:{articles:articles.filter(id=>!collection.articles.includes(id)),events:events.filter(id=>!collection.events.includes(id))}});
  }
  if(path==='/api/account/collection'&&request.method==='PATCH'){
    const data=await bodyJSON(request,1024);
    if(!['article','event'].includes(data.type)||typeof data.id!=='string'||!RECORD_ID.test(data.id)||typeof data.saved!=='boolean')return json({error:'invalid_collection_change'},400);
    if(data.saved){
      const table=data.type==='article'?'news':'event_payloads';
      if(!await env.DB.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(data.id).first())return json({error:'record_not_found'},404);
      await env.DB.batch([collectionInsert(env,session.id,data.type,[data.id],now),collectionStamp(env,session.id,now)]);
    }else await env.DB.batch([env.DB.prepare('DELETE FROM reading_saves WHERE user_id=? AND record_type=? AND record_id=?').bind(session.id,data.type,data.id),collectionStamp(env,session.id,now)]);
    const collection=await readingCollection(env,session.id),key=data.type==='article'?'articles':'events';
    return data.saved&&!collection[key].includes(data.id)?json({error:'collection_limit_reached',collection},409):json({collection});
  }
  const collection=await readingCollection(env,session.id);
  if(path==='/api/account/collection')return json({collection});
  const profile=await env.DB.prepare('SELECT id,provider,provider_subject,name,email,picture,created_at FROM users WHERE id=?').bind(session.id).first();
  if(!profile)return json({error:'sign_in_required'},401);
  const user={id:profile.id,provider:profile.provider,providerSubject:profile.provider_subject,name:profile.name,email:profile.email,picture:profile.picture,createdAt:new Date(profile.created_at*1000).toISOString()};

  const billingRow=await env.DB.prepare('SELECT checkout_kind,plan_key,subscription_id,order_id,status,last_payment_at,next_billing_time,access_until,created_at,updated_at FROM billing_subscriptions WHERE user_id=?').bind(session.id).first();
  const billing=billingRow?{checkoutKind:billingRow.checkout_kind,planKey:billingRow.plan_key,subscriptionId:billingRow.subscription_id,orderId:billingRow.order_id,status:billingRow.status,lastPaymentAt:billingRow.last_payment_at?new Date(billingRow.last_payment_at*1000).toISOString():null,nextBillingTime:billingRow.next_billing_time||null,accessUntil:billingRow.access_until?new Date(billingRow.access_until*1000).toISOString():null,createdAt:new Date(billingRow.created_at*1000).toISOString(),updatedAt:new Date(billingRow.updated_at*1000).toISOString()}:null;
  const data={user,preferences:savedPreferences(session),collection,billing};
  if(path==='/api/account/export'){
    let consentRecords=[],consentHistoryAvailable=true;
    try{
      const rows=(await env.DB.prepare('SELECT * FROM membership_consents WHERE user_id=? ORDER BY accepted_at DESC LIMIT 1000').bind(session.id).all()).results||[];
      consentRecords=rows.map(row=>({termsVersion:row.terms_version,planKey:row.plan_key,amount:row.amount,currency:row.currency,firstChargeAt:row.first_charge_at||null,billingStartChoice:row.billing_start_choice||'scheduled',acceptedAt:new Date(row.accepted_at*1000).toISOString()}));
    }catch(error){
      if(!/no such table[^\n]*membership_consents/i.test(error?.message||''))throw error;
      consentHistoryAvailable=false;
    }
    let readerUpdates=null,readerUpdatesAvailable=true;
    try{readerUpdates=await readerUpdatesExport(env,session.id);}
    catch(error){if(!/no such table[^\n]*reader_(?:updates|email_outbox)/i.test(error?.message||''))throw error;readerUpdatesAvailable=false;}
    let followedStoryCheckpoints=[];
    try{const {results}=await env.DB.prepare('SELECT event_id,checked_through FROM watchlist_checkpoints WHERE user_id=? ORDER BY event_id').bind(session.id).all();followedStoryCheckpoints=(results||[]).map(row=>({eventId:row.event_id,checkedThrough:row.checked_through}));}
    catch(error){if(!/no such table[^\n]*watchlist_checkpoints/i.test(error?.message||''))throw error;}
    return json({exportedAt:new Date().toISOString(),...data,membershipConsents:{available:consentHistoryAvailable,records:consentRecords},readerUpdates,readerUpdatesAvailable,followedStoryCheckpoints},200,{'content-disposition':'attachment; filename="threadnews-account.json"','x-content-type-options':'nosniff'});
  }
  return json(data);
}

export async function handleAuth(request,env){
  const path=new URL(request.url).pathname;
  if(path==='/api/auth/apple/notifications'){
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    if(!providerConfig(env).providers.find(p=>p.id==='apple')?.enabled)return json({error:'provider_not_configured'},503);
    let payload;
    try{
      const body=await bodyJSON(request,32768);
      if(typeof body.payload!=='string'||body.payload.length>24000)return json({error:'invalid_notification'},400);
      ({payload}=await jwtVerify(body.payload,APPLE_KEYS,{issuer:'https://appleid.apple.com',audience:env.APPLE_CLIENT_ID,algorithms:['RS256'],maxTokenAge:'24h',clockTolerance:60}));
    }catch{return json({error:'invalid_notification'},401);}
    let event=payload.events;
    if(typeof event==='string'){try{event=JSON.parse(event);}catch{return json({error:'invalid_notification'},400);}}
    if(!event||typeof event.sub!=='string'||event.sub.length>255||typeof event.type!=='string')return json({error:'invalid_notification'},400);
    if(!['consent-revoked','account-deleted','email-disabled','email-enabled'].includes(event.type))return json({ok:true,ignored:true});
    const eventHash=await sha256(String(payload.jti||'')+':'+event.type+':'+event.sub+':'+String(event.event_time||payload.iat));
    if(await env.DB.prepare('SELECT event_hash FROM apple_notification_events WHERE event_hash=?').bind(eventHash).first())return json({ok:true,duplicate:true});
    const user=await env.DB.prepare("SELECT id FROM users WHERE provider='apple' AND provider_subject=?").bind(event.sub).first(), now=Math.floor(Date.now()/1000);
    const statements=[];
    if(user&&['consent-revoked','account-deleted'].includes(event.type)){
      statements.push(env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),env.DB.prepare('DELETE FROM apple_tokens WHERE user_id=?').bind(user.id));
    }
    if(user&&event.type!=='email-enabled')statements.push(env.DB.prepare("UPDATE reader_updates SET status='unsubscribed',alerts_enabled=0,weekly_enabled=0,updated_at=? WHERE user_id=?").bind(now,user.id));
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO apple_notification_events (event_hash,event_type,processed_at) VALUES (?,?,?)').bind(eventHash,event.type,now),env.DB.prepare('DELETE FROM apple_notification_events WHERE processed_at<?').bind(now-30*86400));
    await env.DB.batch(statements);
    return json({ok:true});
  }
  if(path==='/api/privacy'||path.startsWith('/api/account')){
    try{return await accountRoutes(request,env,path);}catch(error){if(error instanceof AccountError)return json({error:error.message},error.status);throw error;}
  }
  if(path==='/api/auth/providers'&&request.method==='GET')return json(providerConfig(env));
  if(path==='/api/auth/session'&&request.method==='GET')return json(await currentSession(request,env));
  const match=path.match(/^\/api\/auth\/(google|apple)\/(start|callback)$/);
  if(match){if(match[2]==='start')return request.method==='GET'?start(match[1],env):json({error:'method_not_allowed'},405);return callback(request,match[1],env);}
  if(path==='/api/auth/logout'&&request.method==='POST'){
    if(!sameOriginMutation(request,env))return json({error:'cross_origin_request'},403);
    const token=readCookie(request,SESSION_COOKIE);if(env.DB&&token)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
    return json({ok:true},200,{'set-cookie':cookie(SESSION_COOKIE,'',0)});
  }
  if(path==='/api/preferences'&&request.method==='PUT'){
    if(!sameOriginMutation(request,env))return json({error:'cross_origin_request'},403);
    const session=await sessionRecord(request,env);if(!session)return json({error:'sign_in_required'},401);
    if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'json_required'},415);
    const body=await request.text();if(body.length>4096)return json({error:'request_too_large'},413);
    let data;try{data=JSON.parse(body);}catch{return json({error:'invalid_json'},400);}
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!['topics','newsCountry'].includes(key)))return json({error:'invalid_preferences'},400);
    const hasTopics=Object.hasOwn(data,'topics'), hasCountry=Object.hasOwn(data,'newsCountry');
    if(!hasTopics&&!hasCountry)return json({error:'invalid_preferences'},400);
    if(hasTopics&&(!Array.isArray(data.topics)||data.topics.length>TOPICS.length||data.topics.some(t=>!TOPICS.includes(t))))return json({error:'invalid_topics',allowed:TOPICS},400);
    if(hasCountry&&(typeof data.newsCountry!=='string'||!/^(?:[A-Z]{2})?$/.test(data.newsCountry)))return json({error:'invalid_country'},400);
    const topics=hasTopics?JSON.stringify([...new Set(data.topics)]):null;
    const saved=await env.DB.prepare(`INSERT INTO preferences (user_id,topics_json,updated_at,news_country) VALUES (?,COALESCE(?,'[]'),?,?)
      ON CONFLICT(user_id) DO UPDATE SET topics_json=COALESCE(?,preferences.topics_json),news_country=CASE WHEN ? THEN excluded.news_country ELSE preferences.news_country END,
        updated_at=excluded.updated_at RETURNING topics_json,news_country`).bind(session.id,topics,Math.floor(Date.now()/1000),data.newsCountry||'',topics,hasCountry?1:0).first();
    return json({preferences:savedPreferences(saved)});
  }
  return json({error:'not_found'},404);
}
