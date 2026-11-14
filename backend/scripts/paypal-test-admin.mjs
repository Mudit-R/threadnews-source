import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLimited } from '../src/feed.js';
const origin='https://threadnews-paypal-test.example.com';
export function testAdminSecret(root) {
  if(typeof root!=='string'||root.length<24)throw new Error('A configured INGEST_SECRET is required.');
  return createHmac('sha256',root).update('ThreadNews PayPal sandbox administrator v1\n'+origin).digest('base64url');
}
export async function run(action,env=process.env){
  const secret=testAdminSecret(env.INGEST_SECRET);
  if(action==='deploy-secret'){
    const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
    const result=spawnSync(process.execPath,[cli,'secret','put','INGEST_SECRET','--config','wrangler.paypal-test.jsonc'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,input:secret+'\n',encoding:'utf8'});
    if(result.status!==0)throw new Error('The isolated test administrator secret could not be deployed.');
    return {ok:true,administratorSecretDeployed:true};
  }
  const setup=action==='setup';
  if(!setup&&action!=='report')throw new Error('Choose setup, report or deploy-secret.');
  const response=await fetch(origin+(setup?'/api/admin/billing/setup':'/api/admin/billing/test-report'),{
    method:setup?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(180000),
    headers:{authorization:'Bearer '+secret,...(setup?{'content-type':'application/json'}:{})},
    ...(setup?{body:JSON.stringify({environment:'sandbox',confirm:'CREATE_PLANS_AND_WEBHOOK'})}:{})
  });
  const data=JSON.parse(await readLimited(response,64*1024));
  if(!response.ok||!data.ok)throw new Error(`sandbox_${response.status}_${/^[a-z0-9_]+$/.test(data.error||'')?data.error:'request_failed'}`);
  return data;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await run(process.argv[2])));}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
}
