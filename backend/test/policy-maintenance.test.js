import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readdir,readFile,rm,rmdir } from 'node:fs/promises';
import { relative,resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { applyEditorialPolicy } from '../scripts/apply-editorial-policy.mjs';

const env={APP_ORIGIN:'https://threadnews.example.com',INGEST_SECRET:'fake-test-ingest-secret-longer-than-24'};
const source={url:'https://news.example.com/story',publisher:'A publisher'},event={id:'timeline',title:'Retained timeline',milestones:[{title:'A sourced milestone'}]},economy={countries:Array.from({length:19},(_,i)=>({iso3:'c'+i}))};
async function directory(){const root=resolve(process.cwd(),'.build');await mkdir(root,{recursive:true});return mkdtemp(resolve(root,'editorial-policy-test-'));}
async function cleanup(path){assert(!relative(resolve(process.cwd(),'.build'),path).startsWith('..'));for(const file of await readdir(path))await rm(resolve(path,file));await rmdir(path);}
function mock(articles,{directory,failEvents=false}={}){
  const posts=[];
  return {posts,async fetchImpl(url,options){
    assert.equal(url.origin,env.APP_ORIGIN);assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer '+env.INGEST_SECRET);
    if(options.method==='POST'){
      const files=await readdir(directory);assert(files.some(file=>file.endsWith('.json.gz')));assert(files.some(file=>file.endsWith('.manifest.json')));assert(files.some(file=>file.endsWith('.editorial-plan.json')));
      assert.equal(url.pathname,'/api/admin/retract');posts.push(JSON.parse(options.body));return Response.json({ok:true});
    }
    assert.equal(url.pathname,'/api/admin/content-backup');const kind=url.searchParams.get('kind');
    if(kind==='events'&&failEvents)return new Response('',{status:503});
    if(kind==='news'){const start=url.searchParams.has('cursor')?100:0,records=articles.slice(start,start+100);return Response.json({records,nextCursor:articles.length>100&&start===0?'second-page':null});}
    return Response.json({records:kind==='events'?[event]:[economy],nextCursor:null});
  }};
}
test('editorial cleanup is a dry run by default, preserves full backup, and proposes only current exclusions',async()=>{
  const dir=await directory();
  try{
    const articles=[{id:'promo',title:'Warhammer gameplay trailer',category:'Technology',source},{id:'important',title:'Gaming privacy breach exposes personal data',category:'Technology',source},{id:'previous',title:'Official gameplay trailer',category:'Technology',source,editorialExcluded:true}];
    const fixture=mock(articles,{directory:dir}),result=await applyEditorialPolicy({env,fetchImpl:fixture.fetchImpl,directory:dir});
    assert.equal(result.mode,'dry-run');assert.equal(result.proposedRetractions,1);assert.equal(result.alreadyExcluded,1);assert.equal(fixture.posts.length,0);
    const plan=JSON.parse(await readFile(resolve(dir,result.planFile),'utf8')),backup=JSON.parse(gunzipSync(await readFile(resolve(dir,result.backupFile))));
    assert.deepEqual(plan.proposed.map(row=>row.id),['promo']);assert.equal(plan.proposed[0].impactScore,0);assert.equal(backup.articles.length,3);assert.deepEqual(backup.events,[event]);
    assert(!JSON.stringify(plan).includes(env.INGEST_SECRET));assert(!JSON.stringify(backup).includes(env.INGEST_SECRET));
  }finally{await cleanup(dir);}
});
test('optional soft retractions use bounded dynamic ID batches only after a completed backup and plan',async()=>{
  const dir=await directory();
  try{
    const articles=Array.from({length:105},(_,i)=>({id:'promo-'+i,title:'A new gameplay trailer',category:'Technology',source}));
    const fixture=mock(articles,{directory:dir}),result=await applyEditorialPolicy({env,fetchImpl:fixture.fetchImpl,directory:dir,apply:true});
    assert.equal(result.mode,'apply');assert.equal(result.batches,2);assert.equal(result.acknowledgedIds,105);
    assert.deepEqual(fixture.posts.map(body=>body.ids.length),[100,5]);assert.deepEqual(fixture.posts.flatMap(body=>body.ids),articles.map(article=>article.id));
    assert(fixture.posts.every(body=>Object.keys(body).join(',')==='ids'));
  }finally{await cleanup(dir);}
});
test('an incomplete backup prevents plans and all visibility changes',async()=>{
  const dir=await directory();
  try{
    const fixture=mock([{id:'promo',title:'A gameplay trailer',source}],{directory:dir,failEvents:true});
    await assert.rejects(()=>applyEditorialPolicy({env,fetchImpl:fixture.fetchImpl,directory:dir,apply:true}),/backup_http_503/);
    assert.equal(fixture.posts.length,0);assert.deepEqual(await readdir(dir),[]);
  }finally{await cleanup(dir);}
});
