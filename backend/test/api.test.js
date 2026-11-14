import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { newsQuery } from '../src/worker.js';
import { appOrigin, providerConfig, readCookie, sameOriginMutation } from '../src/auth.js';

test('OAuth providers are disabled without credentials and a fixed HTTPS origin',async()=>{
  const response=await worker.fetch(new Request('https://example.com/api/auth/providers'),{},{}),data=await response.json();
  assert.equal(data.guestReading,true);assert(data.providers.every(p=>!p.enabled&&p.startUrl===null));
  assert.equal(providerConfig({DB:{},APP_ORIGIN:'https://example.com',GOOGLE_CLIENT_ID:'id',GOOGLE_CLIENT_SECRET:'secret'}).providers[0].enabled,true);
  assert.equal(appOrigin({APP_ORIGIN:'https://example.com/a'}),null);assert.equal(appOrigin({APP_ORIGIN:'http://example.com'}),null);
});
test('unauthenticated readers get a guest session and cannot mutate preferences',async()=>{
  const session=await worker.fetch(new Request('https://example.com/api/auth/session'),{},{});assert.deepEqual(await session.json(),{user:null,preferences:{topics:[]}});
  const response=await worker.fetch(new Request('https://example.com/api/preferences',{method:'PUT',headers:{'origin':'https://example.com','content-type':'application/json'},body:'{"topics":["Technology"]}'}),{},{});assert.equal(response.status,401);
});
test('mutating API endpoints reject cross-origin requests',async()=>{
  const response=await worker.fetch(new Request('https://example.com/api/auth/logout',{method:'POST',headers:{origin:'https://attacker.example'}}),{},{});assert.equal(response.status,403);
  assert(!sameOriginMutation(new Request('https://example.com/api/preferences',{method:'PUT'}),{}));
  assert.equal(readCookie(new Request('https://example.com',{headers:{cookie:'other=a; __Host-threadline-session=abc=def'}}),'__Host-threadline-session'),'abc=def');
});
test('news filtering is parameterized and literal LIKE wildcards are escaped',()=>{
  const query=newsQuery(new URLSearchParams({q:"x%' OR 1=1 --",topic:'World affairs',limit:'999999'}));
  assert.equal(query.limit,100);assert(!query.where.includes('1=1'));assert.equal(query.args[0],'World');assert.match(query.args[1],/\\%/);
});
test('static news filtering maps the World affairs alias to canonical World coverage',async()=>{
  const articles=[
    {id:'world-story',title:'World update',category:'World',region:'Everywhere',publishedAt:'2026-11-04T08:00:00Z',source:{publisher:'Example',url:'https://example.com/world'}},
    {id:'economy-story',title:'Economy update',category:'Economy',region:'Everywhere',publishedAt:'2026-11-04T07:00:00Z',source:{publisher:'Example',url:'https://example.com/economy'}}
  ];
  const env={NEWS_STORAGE:'static',ASSETS:{fetch:async()=>Response.json({articles,meta:{mode:'snapshot'}})}};
  const response=await worker.fetch(new Request('https://example.com/api/news?topic=World%20affairs'),env,{});
  const data=await response.json();
  assert.equal(response.status,200);assert.deepEqual(data.articles.map(article=>article.id),['world-story']);
});
test('production API reports a missing database without substituting bundled articles',async()=>{
  const sample={id:'s',title:'A snapshot',category:'Technology',region:'Global',publishedAt:'2026-11-02T12:00:00Z',source:{publisher:'Example News',url:'https://example.com/a',basis:'headline'}};
  const env={ASSETS:{fetch:async()=>Response.json({articles:[sample],meta:{generatedAt:'2026-11-03'}})}};
  const response=await worker.fetch(new Request('https://example.com/api/news?limit=50'),env,{}),data=await response.json();
  assert.equal(response.status,503);assert.equal(data.error,'Database is not configured');assert.equal(data.articles,undefined);
});
test('Cloudflare deployment advertises same-origin API configuration',async()=>{
  const response=await worker.fetch(new Request('https://example.com/app-config.js'),{},{});assert.match(await response.text(),/"apiBase":"","mode":"production"/);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('runner-generated static editions remain automatic and keep the real collector timestamp',async()=>{
  const stamp='2026-11-03T08:00:00Z';const env={NEWS_STORAGE:'static',ASSETS:{fetch:async()=>Response.json({articles:[],meta:{mode:'automatic',lastIngestedAt:stamp}})}};
  const response=await worker.fetch(new Request('https://example.com/api/news'),env,{}),data=await response.json();assert.equal(data.meta.mode,'automatic');assert.equal(data.meta.lastIngestedAt,stamp);
});
test('OAuth start binds state to a secure cookie, uses PKCE and ignores arbitrary return URLs',async()=>{
  const statements=[];
  const env={APP_ORIGIN:'https://example.com',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',DB:{prepare(sql){return{bind(...args){statements.push({sql,args});return{}}};},async batch(){return[];}}};
  const response=await worker.fetch(new Request('https://example.com/api/auth/google/start?redirect=https://attacker.example'),env,{});
  assert.equal(response.status,302);const destination=new URL(response.headers.get('location'));
  assert.equal(destination.origin,'https://accounts.google.com');assert.equal(destination.searchParams.get('redirect_uri'),'https://example.com/api/auth/google/callback');assert.equal(destination.searchParams.get('code_challenge_method'),'S256');assert.match(destination.searchParams.get('state'),/^[\w-]{43}$/);assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);assert.equal(statements.length,2);
});
test('a callback without its browser-bound OAuth attempt never establishes a session',async()=>{
  const statements=[];const env={APP_ORIGIN:'https://example.com',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',DB:{prepare(sql){statements.push(sql);return{bind(){return{async first(){return null;}};}}}}};
  const request=new Request('https://example.com/api/auth/google/callback?code=unused&state='+'a'.repeat(43),{headers:{cookie:'__Host-threadline-oauth='+'b'.repeat(43)}});
  const response=await worker.fetch(request,env,{});assert.equal(response.status,303);assert.match(response.headers.get('location'),/auth_error=sign_in_failed/);assert(!response.headers.get('set-cookie').includes('__Host-threadline-session'));assert(statements.every(s=>!s.includes('INSERT INTO sessions')));
});
test('authenticated preferences accept the frontend Sport topic',async()=>{
  let stored;
  const env={DB:{prepare(sql){return{bind(...args){return{async first(){return{id:'test-user',name:'Reader',topics_json:'[]'};},async run(){stored={sql,args};return{success:true};}};}}}}};
  const request=new Request('https://example.com/api/preferences',{method:'PUT',headers:{origin:'https://example.com','content-type':'application/json',cookie:'__Host-threadline-session='+'x'.repeat(43)},body:JSON.stringify({topics:['Sport']})});
  const response=await worker.fetch(request,env,{});assert.equal(response.status,200);assert.deepEqual(await response.json(),{preferences:{topics:['Sport']}});assert.equal(stored.args[1],'["Sport"]');
});
