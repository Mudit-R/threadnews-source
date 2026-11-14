import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleBillingTest, sandboxImmediateBilling, PAYPAL_TEST_ORIGIN } from '../src/billing-test.js';
import { sha256 } from '../src/feed.js';
import { testAdminSecret } from '../scripts/paypal-test-admin.mjs';
import {hasPaidAccess} from '../src/paypal.js';

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE users(id TEXT PRIMARY KEY,provider TEXT,provider_subject TEXT,name TEXT,email TEXT,picture TEXT,created_at INTEGER);CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);CREATE TABLE preferences(user_id TEXT,topics_json TEXT);');
  const DB={prepare(sql){return {bind(...args){return {first:async()=>sqlite.prepare(sql).get(...args),run:async()=>sqlite.prepare(sql).run(...args)};},first:async()=>sqlite.prepare(sql).get()};},batch:async statements=>Promise.all(statements.map(s=>s.run()))};
  return {sqlite,env:{DB,PAYPAL_ENV:'sandbox',TEST_ENVIRONMENT:'paypal-e2e',APP_ORIGIN:PAYPAL_TEST_ORIGIN,TEST_DATABASE_ID:'00000000-0000-4000-8000-000000000001',PAYPAL_TEST_START_IMMEDIATELY:'true'}};
}
test('production rejects sandbox identity routes despite attacker-controlled URL and body',async()=>{
  const f=fixture();
  for(const extra of [{APP_ORIGIN:'https://threadnews.online'},{PAYPAL_ENV:'live'},{TEST_DATABASE_ID:'00000000-0000-4000-8000-000000000002'},{TEST_ENVIRONMENT:''}]){
    const env={...f.env,...extra};
    const r=await handleBillingTest(new Request(PAYPAL_TEST_ORIGIN+'/api/sandbox/session',{method:'POST',headers:{origin:PAYPAL_TEST_ORIGIN},body:'{}'}),env);
    assert.equal(r.status,404);assert.equal(sandboxImmediateBilling(env),false);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count,0);
});
test('sandbox session requires exact origin and stores only a hash of a short-lived cookie',async()=>{
  const f=fixture(),url=PAYPAL_TEST_ORIGIN+'/api/sandbox/session';
  assert.equal((await handleBillingTest(new Request(url,{method:'POST',headers:{origin:'https://attacker.invalid'}}),f.env)).status,403);
  const response=await handleBillingTest(new Request(url,{method:'POST',headers:{origin:PAYPAL_TEST_ORIGIN}}),f.env);
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie');assert.match(cookie,/HttpOnly; Secure; SameSite=Lax; Max-Age=3600/);
  const token=cookie.split(';')[0].split('=')[1];
  const row=f.sqlite.prepare('SELECT token_hash,expires_at FROM sessions').get();
  assert.equal(row.token_hash,await sha256(token));assert.ok(row.expires_at<=Date.now()/1000+3601);
  assert.ok(!(await response.text()).includes(token));
  assert.equal(f.sqlite.prepare('SELECT provider,email FROM users').get().provider,'sandbox-test');
});
test('sandbox page clearly identifies fictitious funds and excludes search indexing',async()=>{
  const f=fixture();const r=await handleBillingTest(new Request(PAYPAL_TEST_ORIGIN+'/sandbox'),f.env);
  assert.match(r.headers.get('x-robots-tag'),/noindex/);
  assert.match(await r.text(),/fictitious sandbox funds/);
  assert.equal(sandboxImmediateBilling(f.env),true);
});
test('test administrator key is scoped, deterministic and cannot equal the production key',()=>{
  const root='fixture-production-administrator-secret-long-enough';
  assert.equal(testAdminSecret(root),testAdminSecret(root));assert.notEqual(testAdminSecret(root),root);
  assert.notEqual(testAdminSecret(root),testAdminSecret(root+'new'));
  assert.throws(()=>testAdminSecret('short'));
});
test('only the isolated sandbox can bypass the free-window clock for entitlement tests',async()=>{
  const f=fixture();
  f.sqlite.exec('CREATE TABLE billing_subscriptions(user_id TEXT,status TEXT,checkout_kind TEXT,plan_key TEXT,last_payment_at INTEGER,access_until INTEGER,grace_until INTEGER)');
  const ready={...f.env,BILLING_ENABLED:'true',PAYPAL_CLIENT_ID:'fixture',PAYPAL_CLIENT_SECRET:'fixture',PAYPAL_WEBHOOK_ID:'WH-FIXTURE',PAYPAL_SUBSCRIPTIONS_ACCESS:'true',PAYPAL_PLAN_MONTHLY_ID:'P-MONTH',PAYPAL_PLAN_ANNUAL_ID:'P-YEAR'};
  const now=Math.floor(Date.parse('2026-11-15T00:00:00Z')/1000);
  assert.equal(await hasPaidAccess(ready,'test-reader',now),false);
  assert.equal(await hasPaidAccess({...ready,APP_ORIGIN:'https://threadnews.online'},'test-reader',now),true);
});
