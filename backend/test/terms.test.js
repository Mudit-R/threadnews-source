import test from 'node:test';
import assert from 'node:assert/strict';
import { membershipTerms,termsReady,termsMarkup } from '../src/terms.js';
const ready={TERMS_PUBLISHED:'true',TERMS_VERSION:'2026-11-04',LEGAL_SELLER_NAME:'Fixture Seller',LEGAL_SELLER_TYPE:'individual',LEGAL_SELLER_ADDRESS:'Fixture correspondence address',LEGAL_SELLER_COUNTRY:'India',REFUND_WINDOW_DAYS:'14'};
test('published terms require actual seller details and an explicitly approved refund policy',()=>{
  assert.equal(termsReady({TERMS_PUBLISHED:'true'}),false);
  assert.equal(termsReady(ready),true);
  for(const key of Object.keys(ready))assert.equal(termsReady({...ready,[key]:''}),false,key);
  assert.equal(termsReady({...ready,REFUND_WINDOW_DAYS:'-1'}),false);
});
test('terms retain the advertised free period and preserve statutory rights',()=>{
  const body=termsMarkup(ready)[2];
  assert.match(body,/\$2 USD per month and \$20 USD per year/);
  assert.match(body,/free for everyone through 30 November 2026/);
  assert.match(body,/1 December 2026 at 00:00 India Standard Time/);
  assert.match(body,/within 14 days/);assert.match(body,/Nothing here waives mandatory rights/);
  assert.doesNotMatch(body,/Draft — operator review/);
});
test('seller-provided text is escaped and drafts never claim publication',()=>{
  assert.match(termsMarkup({})[2],/Draft — operator review/);
  const body=termsMarkup({...ready,LEGAL_SELLER_NAME:'<img src=x onerror=alert(1)>'})[2];
  assert.ok(!body.includes('<img'));assert.ok(body.includes('&lt;img'));
  assert.equal(membershipTerms({}).published,false);
});
