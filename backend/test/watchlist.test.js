import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleWatchlist, readWatchlist } from '../src/watchlist.js';
import { sha256 } from '../src/feed.js';

test('watchlist checkpoints isolate readers and keep reports added after the checked snapshot', async t => {
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  sqlite.exec('PRAGMA foreign_keys=ON');
  const migrations=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(migrations).filter(file=>file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file,migrations),'utf8'));
  const DB={
    prepare(sql) {
      const statement=sqlite.prepare(sql);
      const bind=(...args)=>({bind,async first(){return statement.get(...args);},async all(){return {results:statement.all(...args)};},async run(){return statement.run(...args);}});
      return bind();
    },
    async batch(statements){return Promise.all(statements.map(statement=>statement.all()));}
  };
  const now=new Date(), earlier=new Date(+now-1000), firstAt=new Date(+now-2000), addedLater=new Date(+now-500);
  const app='https://threadnews.online';
  const sessionToken='watchlist-fixture-session'.padEnd(43,'_');
  const env={ DB,APP_ORIGIN:app };
  const createUser=sqlite.prepare("INSERT INTO users(id,provider,provider_subject,created_at) VALUES (?,'google',?,?)");
  for(const id of ['alice','bob'])createUser.run(id,id,Math.floor(+now/1000));
  sqlite.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(await sha256(sessionToken),'alice',Math.floor(+now/1000)+3600);
  for(const id of ['rail','fuel'])sqlite.prepare("INSERT INTO event_payloads(id,title,category,region,updated_at,payload_json,content_hash) VALUES (?,?,'Economy','Europe',?,'{}','fixture')").run(id,id,now.toISOString());
  const follow=sqlite.prepare("INSERT INTO reading_saves VALUES (?,'event',?,?)");
  follow.run('alice','rail',0); follow.run('bob','fuel',0);
  const insert=sqlite.prepare(`INSERT INTO news(id,canonical_url,title,original_headline,summary,category,region,published_at,ingested_at,source_json,event_id,feed_id)
    VALUES (?,?,?,?,'','Economy','Europe',?,?,'{}',?,'fixture')`);
  const report=(id,time,event)=>insert.run(id,app+'/news/'+id,id,id,time.toISOString(),time.toISOString(),event);
  report('rail-first',firstAt,'rail'); report('fuel-first',firstAt,'fuel');
  const snapshot=await readWatchlist(env,'alice',earlier);
  assert.deepEqual(snapshot.events.map(item=>item.id),['rail']);
  report('rail-next',addedLater,'rail');
  const headers={cookie:`__Host-threadline-session=${sessionToken}`,'content-type':'application/json',origin:app};
  const mark=(eventId,through)=>handleWatchlist(new Request(app+'/api/watchlist/ack',{method:'POST',headers,body:JSON.stringify({eventId,through})}),env);
  assert.equal((await handleWatchlist(new Request(app+'/api/watchlist'),env)).status,401);
  assert.equal((await mark('rail',snapshot.through)).status,200);
  assert.equal((await mark('rail',firstAt.toISOString())).status,200);
  assert.equal((await mark('fuel',snapshot.through)).status,200);
  assert.deepEqual((await readWatchlist(env,'alice',now)).events[0].reports.map(item=>item.id),['rail-next']);
  assert.deepEqual((await readWatchlist(env,'bob',now)).events.map(item=>item.id),['fuel']);
  sqlite.prepare("DELETE FROM reading_saves WHERE user_id='alice'").run();
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM watchlist_checkpoints WHERE user_id='alice'").get().n,0);
});
