import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { handleAuth } from '../src/auth.js';
import { sha256 } from '../src/feed.js';
import { decryptAppleRefreshToken, encryptAppleRefreshToken } from '../src/apple-tokens.js';

const signing = await generateKeyPair('ES256', { extractable: true });
const identity = await generateKeyPair('RS256', { extractable: true });
const identityJwk = { ...await exportJWK(identity.publicKey), kid: 'apple-fixture-key', use: 'sig', alg: 'RS256' };
const configuration = { APP_ORIGIN: 'https://threadnews.online', APPLE_SIGN_IN_ENABLED: 'true', APPLE_CLIENT_ID: 'online.threadnews.web',
  APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: await exportPKCS8(signing.privateKey),
  APPLE_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
const providerToken = 'apple-refresh-token-fixture-private';

test('signed Apple revocations invalidate only that account, deduplicate and reject wrong audience',async()=>{
  const f=await existingAccount(), original=globalThis.fetch;
  const now=Math.floor(Date.now()/1000);
  const payload={events:{type:'consent-revoked',sub:'apple-sub',event_time:now},jti:crypto.randomUUID()};
  const token=await new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:identityJwk.kid}).setIssuer('https://appleid.apple.com').setAudience(configuration.APPLE_CLIENT_ID).setIssuedAt().setExpirationTime('5m').sign(identity.privateKey);
  const wrong=await new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:identityJwk.kid}).setIssuer('https://appleid.apple.com').setAudience('another.application').setIssuedAt().setExpirationTime('5m').sign(identity.privateKey);
  globalThis.fetch=async()=>Response.json({keys:[identityJwk]});
  const req=value=>new Request(configuration.APP_ORIGIN+'/api/auth/apple/notifications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload:value})});
  try{
    assert.equal((await handleAuth(req(wrong),f.env)).status,401);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);
    assert.equal((await handleAuth(req(token),f.env)).status,200);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM apple_tokens').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n,1,'notification does not silently delete the user account');
    assert.equal((await (await handleAuth(req(token),f.env)).json()).duplicate,true);
  }finally{globalThis.fetch=original;}
});

function database() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const DB = {
    prepare(sql) { return { sql, args: [], bind(...args) { return { ...this, args }; },
      async first() { return sqlite.prepare(sql).get(...this.args) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...this.args) }; },
      async run() { return { success: true, meta: { changes: sqlite.prepare(sql).run(...this.args).changes } }; }
    }; },
    async batch(statements) {
      sqlite.exec('BEGIN'); try { const rows = []; for (const statement of statements) rows.push(await statement.run()); sqlite.exec('COMMIT'); return rows; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return { sqlite, env: { ...configuration, DB } };
}
async function existingAccount(withToken = true) {
  const fixture = database(), now = Math.floor(Date.now() / 1000), session = 's'.repeat(43);
  fixture.sqlite.prepare('INSERT INTO users (id,provider,provider_subject,name,email,created_at) VALUES (?,?,?,?,?,?)')
    .run('apple-reader', 'apple', 'apple-sub', 'Apple reader', 'reader@privaterelay.appleid.com', now);
  fixture.sqlite.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(await sha256(session), 'apple-reader', now + 3600);
  if (withToken) fixture.sqlite.prepare('INSERT INTO apple_tokens VALUES (?,?,?)').run('apple-reader', await encryptAppleRefreshToken(fixture.env, 'apple-reader', providerToken), now);
  return { ...fixture, session, request(path = '/api/account', method = 'DELETE') {
    return new Request(configuration.APP_ORIGIN + path, { method, headers: { cookie: '__Host-threadline-session=' + session,
      origin: configuration.APP_ORIGIN, ...(method === 'DELETE' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'DELETE' ? { body: JSON.stringify({ confirm: 'DELETE' }) } : {}) });
  } };
}

test('Apple refresh credentials use randomized authenticated encryption bound to the account', async () => {
  const first = await encryptAppleRefreshToken(configuration, 'one', providerToken), second = await encryptAppleRefreshToken(configuration, 'one', providerToken);
  assert.notEqual(first, second); assert.ok(!first.includes(providerToken));
  assert.equal(await decryptAppleRefreshToken(configuration, 'one', first), providerToken);
  await assert.rejects(decryptAppleRefreshToken(configuration, 'two', first));
  await assert.rejects(decryptAppleRefreshToken({ ...configuration, APPLE_TOKEN_ENCRYPTION_KEY: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }, 'one', first));
  const corrupt = JSON.parse(first); corrupt.ciphertext = (corrupt.ciphertext[0] === 'A' ? 'B' : 'A') + corrupt.ciphertext.slice(1);
  await assert.rejects(decryptAppleRefreshToken(configuration, 'one', JSON.stringify(corrupt)));
});

test('Apple callback verifies the identity token and stores only an encrypted refresh credential', async () => {
  const fixture = database(), original = globalThis.fetch;
  const start = await handleAuth(new Request(configuration.APP_ORIGIN + '/api/auth/apple/start'), fixture.env);
  const redirect = new URL(start.headers.get('location')), state = redirect.searchParams.get('state'), nonce = redirect.searchParams.get('nonce');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const idToken = await new SignJWT({ nonce, email: 'reader@privaterelay.appleid.com', email_verified: 'true' })
    .setProtectedHeader({ alg: 'RS256', kid: identityJwk.kid }).setIssuer('https://appleid.apple.com')
    .setAudience(configuration.APPLE_CLIENT_ID).setSubject('apple-subject-fixture').setIssuedAt().setExpirationTime('5m').sign(identity.privateKey);
  globalThis.fetch = async input => {
    const path = new URL(input).pathname;
    if (path === '/auth/token') return Response.json({ id_token: idToken, access_token: 'not-retained', refresh_token: providerToken });
    if (path === '/auth/keys') return Response.json({ keys: [identityJwk] });
    throw new Error('Unexpected identity fixture request');
  };
  try {
    const response = await handleAuth(new Request(configuration.APP_ORIGIN + '/api/auth/apple/callback', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ state, code: 'fixture-authorization-code', user: JSON.stringify({ name: { firstName: 'Reader', lastName: 'Example' } }) }) }), fixture.env);
    assert.equal(response.status, 303); assert.ok(!response.headers.get('location').includes('auth_error'));
    const user = fixture.sqlite.prepare('SELECT * FROM users').get();
    assert.equal(user.name, 'Reader Example'); assert.equal(user.provider, 'apple');
    const stored = fixture.sqlite.prepare('SELECT encrypted_token FROM apple_tokens WHERE user_id=?').get(user.id);
    assert.ok(!stored.encrypted_token.includes(providerToken));
    assert.equal(await decryptAppleRefreshToken(fixture.env, user.id, stored.encrypted_token), providerToken);
    assert.ok(!JSON.stringify(fixture.sqlite.prepare('SELECT * FROM users').all()).includes('not-retained'));
  } finally { globalThis.fetch = original; fixture.sqlite.close(); }
});

test('account exports exclude encrypted and plaintext Apple credentials', async () => {
  const fixture = await existingAccount();
  const response = await handleAuth(fixture.request('/api/account/export', 'GET'), fixture.env), text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes('encrypted_token')); assert.ok(!text.includes(providerToken)); assert.ok(!text.includes('ciphertext'));
  fixture.sqlite.close();
});

test('Apple account deletion preserves data when provider revocation fails', async () => {
  const fixture = await existingAccount(), original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  try {
    const response = await handleAuth(fixture.request(), fixture.env);
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'apple_revocation_unavailable');
    assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM apple_tokens').get().n, 1);
  } finally { globalThis.fetch = original; fixture.sqlite.close(); }
});

test('Apple authorization is revoked before account records and encrypted credentials are deleted', async () => {
  const fixture = await existingAccount(), original = globalThis.fetch; let revoked = false;
  globalThis.fetch = async (input, options) => {
    assert.equal(input, 'https://appleid.apple.com/auth/revoke'); assert.equal(options.redirect, 'manual');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('token'), providerToken); assert.equal(form.get('token_type_hint'), 'refresh_token');
    assert.equal(form.get('client_id'), configuration.APPLE_CLIENT_ID);
    assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    revoked = true; return new Response('', { status: 200 });
  };
  try {
    const response = await handleAuth(fixture.request(), fixture.env);
    assert.equal(response.status, 200); assert.equal(revoked, true);
    for (const table of ['users', 'sessions', 'apple_tokens']) assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n, 0);
  } finally { globalThis.fetch = original; fixture.sqlite.close(); }
});

test('a legacy Apple account without a revocation credential requires reauthentication', async () => {
  const fixture = await existingAccount(false);
  const response = await handleAuth(fixture.request(), fixture.env);
  assert.equal(response.status, 409); assert.equal((await response.json()).error, 'apple_reauthentication_required');
  assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  fixture.sqlite.close();
});
