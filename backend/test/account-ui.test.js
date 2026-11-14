import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../web/account.js',import.meta.url),'utf8');
function ui({failFirst=false}={}){
  const values=new Map(),requests=[],messages=[];
  let session={user:{id:'reader-one',name:'Reader'}},local={articles:['guest-article'],events:['guest-event']},fail=failFirst,remote={articles:['account-article'],events:[]};
  const context=vm.createContext({console,URL,Blob,AbortSignal,crypto,setTimeout,location:{hash:'#/'},localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},window:{addEventListener(){}},document:{visibilityState:'visible',getElementById(){return null;}},async fetch(url,options){
    requests.push({url,options});if(fail){fail=false;throw new Error('offline');}
    const body=options.body?JSON.parse(options.body):null;
    if(url.endsWith('/api/account/collection/import'))remote={articles:[...new Set([...remote.articles,...body.articles])],events:[...new Set([...remote.events,...body.events])]};
    else if(url.endsWith('/api/account/collection')&&options.method==='PATCH'){
      const key=body.type==='article'?'articles':'events',set=new Set(remote[key]);if(body.saved)set.add(body.id);else set.delete(body.id);remote={...remote,[key]:[...set]};
    }
    return Response.json({user:session.user,collection:remote,notAdded:{articles:[],events:[]}});
  }});
  vm.runInContext(source,context);
  const account=context.createAccountView({connected:true,apiBase:'',esc:String,toast:message=>messages.push(message),getSession:()=>session,readLocal:()=>local,applyLocal:value=>{local=JSON.parse(JSON.stringify(value));}});
  return {account,requests,values,messages,get local(){return local;},setSession(value){session=value;},get remote(){return remote;}};
}

test('sign-in keeps guest saves separate; importing them requires an explicit action',async()=>{
  const f=ui();await f.account.load();
  assert.deepEqual(f.local,{articles:['account-article'],events:[]});
  assert.equal(f.requests.length,1);assert(!f.requests.some(r=>r.url.includes('/import')));
  await f.account.importGuest();
  assert.deepEqual(f.local,{articles:['account-article','guest-article'],events:['guest-event']});
  f.account.signedOut();
  assert.deepEqual(f.local,{articles:['guest-article'],events:['guest-event']});
});

test('failed initial account load and retries cannot overwrite the saved guest collection',async()=>{
  const f=ui({failFirst:true});await f.account.load();assert.deepEqual(f.local,{articles:[],events:[]});
  await f.account.load();assert.deepEqual(f.local,{articles:['account-article'],events:[]});
  f.account.signedOut();assert.deepEqual(f.local,{articles:['guest-article'],events:['guest-event']});
});

test('saved identifiers sync through authenticated account endpoints and disappear from pending queue after success',async()=>{
  const f=ui();await f.account.load();await f.account.syncSave('event','new-event',true);
  assert.deepEqual(f.local,{articles:['account-article'],events:['new-event']});
  assert.equal(JSON.parse(f.values.get('threadnews-save-queue:reader-one')).length,0);
  const request=f.requests.at(-1);assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.method,'PATCH');
  assert.deepEqual(JSON.parse(request.options.body),{type:'event',id:'new-event',saved:true});
  await f.account.syncSave('event','new-event',false);assert.deepEqual(f.local.events,[]);
});

test('guest changes never make account requests',async()=>{
  const f=ui();f.setSession({user:null});await f.account.syncSave('article','another-guest',true);
  assert.equal(f.requests.length,0);assert.equal(f.values.size,0);
});
