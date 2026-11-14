import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupContent } from './backup-content.mjs';
import { collectorConfig,CollectorError } from './collect-news.mjs';
import { readLimited } from '../src/feed.js';
import { exclusionReason,impactScore,POLICY_VERSION } from '../src/policy.js';

/** Dry-run by default. A full, completed local backup precedes every plan and
 * every optional soft retraction. No article, source history or timeline is
 * deleted: the admin endpoint hides excluded IDs from the public news view. */
export async function applyEditorialPolicy({env=process.env,fetchImpl=fetch,now=new Date(),apply=false,directory=resolve(process.cwd(),env.BACKUP_DIR||'backups')}={}){
  const {origin,secret}=collectorConfig(env),proposed=[],alreadyExcluded=[];
  const backup=await backupContent({env,fetchImpl,now,directory,onRecord(kind,article){
    if(kind!=='news')return;
    if(article.editorialExcluded===true){alreadyExcluded.push(article.id);return;}
    const reason=exclusionReason(article);
    if(reason)proposed.push({id:article.id,reason,impactScore:impactScore(article),title:article.title,sourceUrl:article.source.url});
  }});
  // The backup completed, its checksum was calculated, and only its exact
  // backed-up records can appear in this plan. Later arrivals are untouched.
  const plan={format:'threadnews-editorial-policy-plan',version:1,policyVersion:POLICY_VERSION,createdAt:now.toISOString(),origin:origin.origin,backup:{file:backup.file,sha256:backup.sha256},alreadyExcluded:alreadyExcluded.length,proposed};
  const planFile=backup.file.replace(/\.json\.gz$/,'.editorial-plan.json');
  await writeFile(resolve(directory,planFile),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
  let batches=0,acknowledged=0;
  if(apply){
    for(let offset=0;offset<proposed.length;offset+=100){
      const ids=proposed.slice(offset,offset+100).map(record=>record.id);
      let response;try{response=await fetchImpl(new URL('/api/admin/retract',origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json',authorization:'Bearer '+secret},body:JSON.stringify({ids})});}catch{throw new CollectorError('editorial_retraction_service_unreachable');}
      if(!response.ok)throw new CollectorError('editorial_retraction_http_'+response.status);
      let data;try{data=JSON.parse(await readLimited(response,64*1024));}catch{throw new CollectorError('invalid_editorial_retraction_acknowledgement');}
      if(data?.ok!==true)throw new CollectorError('invalid_editorial_retraction_acknowledgement');
      batches++;acknowledged+=ids.length;
    }
  }
  return {ok:true,mode:apply?'apply':'dry-run',policyVersion:POLICY_VERSION,backupFile:backup.file,backupSha256:backup.sha256,planFile,reviewedArticles:backup.counts.news,proposedRetractions:proposed.length,alreadyExcluded:alreadyExcluded.length,batches,acknowledgedIds:acknowledged,note:apply?'The server re-checks current metadata before applying reversible editorial exclusions. Source history and timeline coverage remain retained.':'No public visibility was changed. Review the backup and plan before running with --apply.'};
}
export async function main(){
  if(process.argv.slice(2).some(arg=>arg!=='--apply')){console.error('Use no flag for a dry run, or --apply for backed-up soft retractions.');process.exitCode=1;return;}
  try{console.log(JSON.stringify(await applyEditorialPolicy({apply:process.argv.includes('--apply')})));}
  catch(error){console.error(error instanceof CollectorError?error.code:'editorial_policy_apply_failed');process.exitCode=1;}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main();
