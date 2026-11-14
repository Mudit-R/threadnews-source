import { createHash,randomUUID } from 'node:crypto';
import { createReadStream,createWriteStream } from 'node:fs';
import { mkdir,rename,rm,stat,writeFile } from 'node:fs/promises';
import { isAbsolute,relative,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { collectorConfig,CollectorError } from './collect-news.mjs';
import { readLimited } from '../src/feed.js';

const MAX_BYTES=256*1024*1024,MAX_RECORDS={news:100000,events:10000,economy:1};
export async function* backupPages(kind,{origin,secret,fetchImpl=fetch}={}){
  if(!Object.hasOwn(MAX_RECORDS,kind))throw new CollectorError('invalid_backup_kind');
  const cursors=new Set(),ids=new Set();let cursor=null,count=0;
  for(let page=0;page<2000;page++){
    const url=new URL('/api/admin/content-backup',origin);url.searchParams.set('kind',kind);url.searchParams.set('limit','100');if(cursor)url.searchParams.set('cursor',cursor);
    let response;try{response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{accept:'application/json',authorization:'Bearer '+secret}});}catch{throw new CollectorError('backup_service_unreachable');}
    if(!response.ok)throw new CollectorError('backup_http_'+response.status);
    let data;try{data=JSON.parse(await readLimited(response,2*1024*1024));}catch{throw new CollectorError('invalid_or_oversized_backup_page');}
    if(!Array.isArray(data.records)||data.records.length>100||!(data.nextCursor===null||typeof data.nextCursor==='string'&&data.nextCursor.length>0&&data.nextCursor.length<=2048))throw new CollectorError('invalid_backup_page');
    for(const record of data.records){
      const valid=kind==='news'?typeof record?.id==='string'&&typeof record.title==='string'&&typeof record.source?.url==='string'
        :kind==='events'?typeof record?.id==='string'&&typeof record.title==='string'&&Array.isArray(record.milestones)
          :Array.isArray(record?.countries)&&record.countries.length===19;
      if(!valid)throw new CollectorError('invalid_backup_record');
      const id=kind==='economy'?'economy':record.id;
      if(ids.has(id))throw new CollectorError('duplicate_backup_record');ids.add(id);
      if(++count>MAX_RECORDS[kind])throw new CollectorError('backup_record_limit_exceeded');
      yield record;
    }
    if(data.nextCursor===null)return;
    if(!data.records.length||cursors.has(data.nextCursor))throw new CollectorError('backup_cursor_did_not_advance');
    cursor=data.nextCursor;cursors.add(cursor);
  }
  throw new CollectorError('backup_page_limit_exceeded');
}
export async function backupContent({env=process.env,fetchImpl=fetch,now=new Date(),directory=resolve(process.cwd(),env.BACKUP_DIR||'backups'),onRecord}={}){
  const {origin,secret}=collectorConfig(env),rel=relative(process.cwd(),directory);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/')))throw new CollectorError('backup_directory_must_be_inside_workspace');
  await mkdir(directory,{recursive:true});
  const stamp=now.toISOString().replace(/[:.]/g,'-'),name='threadnews-content-'+stamp+'-'+randomUUID().slice(0,8),temporary=resolve(directory,name+'.json.gz.partial'),destination=resolve(directory,name+'.json.gz');
  const counts={news:0,events:0,economy:0};let bytes=0;
  async function* document(){
    const prefix=JSON.stringify({format:'threadnews-content-backup',version:1,createdAt:now.toISOString(),origin:origin.origin}).slice(0,-1);
    const chunk=value=>{bytes+=Buffer.byteLength(value);if(bytes>MAX_BYTES)throw new CollectorError('backup_byte_limit_exceeded');return value;};
    yield chunk(prefix);
    for(const [kind,key] of [['news','articles'],['events','events'],['economy','economy']]){
      yield chunk(',"'+key+'":'+(kind==='economy'?'':'['));let first=true;
      for await(const record of backupPages(kind,{origin,secret,fetchImpl})){
        if(onRecord)await onRecord(kind,record);
        if(!first)yield chunk(',');first=false;counts[kind]++;yield chunk(JSON.stringify(record));
      }
      if(!counts[kind])throw new CollectorError('backup_source_empty_'+kind);
      if(kind!=='economy')yield chunk(']');
    }
    yield chunk('}');
  }
  try{
    await pipeline(Readable.from(document()),createGzip({level:6}),createWriteStream(temporary,{flags:'wx',mode:0o600}));
    await rename(temporary,destination);
    const hash=createHash('sha256');for await(const chunk of createReadStream(destination))hash.update(chunk);
    const manifest={format:'threadnews-content-backup',version:1,createdAt:now.toISOString(),origin:origin.origin,file:name+'.json.gz',sha256:hash.digest('hex'),compressedBytes:(await stat(destination)).size,uncompressedBytes:bytes,counts,containsAccountData:false};
    await writeFile(resolve(directory,name+'.manifest.json'),JSON.stringify(manifest,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    return {ok:true,file:manifest.file,sha256:manifest.sha256,compressedBytes:manifest.compressedBytes,counts};
  }catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error;}
}
export async function main(){try{console.log(JSON.stringify(await backupContent()));}catch(error){console.error(error instanceof CollectorError?error.code:'content_backup_failed');process.exitCode=1;}}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main();
