import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8, jwtVerify } from 'jose';
import { appleClientSecret, handleAuth, providerConfig } from '../src/auth.js';

const pair = await generateKeyPair('ES256', { extractable: true });
const pem = await exportPKCS8(pair.privateKey);
const appleEnv = { APP_ORIGIN: 'https://threadnews.online', APPLE_SIGN_IN_ENABLED: 'true', APPLE_CLIENT_ID: 'online.threadnews.web',
  APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: pem,
  APPLE_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', DB: {} };

test('Apple stays unavailable when identifiers or a private key are missing or malformed', () => {
  const provider = env => providerConfig(env).providers.find(item => item.id === 'apple');
  assert.equal(provider(appleEnv).enabled, true);
  for (const replacement of [{ APPLE_PRIVATE_KEY: 'AuthKey.p8' }, { APPLE_KEY_ID: 'wrong' }, { APPLE_TEAM_ID: '' }, { APPLE_CLIENT_ID: 'https://example.com' }, { APPLE_TOKEN_ENCRYPTION_KEY: '' }, { APPLE_SIGN_IN_ENABLED: 'false' }]) {
    const result = provider({ ...appleEnv, ...replacement });
    assert.equal(result.enabled, false);
    assert.equal(result.startUrl, null);
    assert.ok(!result.reason.includes('PRIVATE_KEY'));
  }
  assert.equal(provider({ ...appleEnv, APPLE_PRIVATE_KEY: pem.replace(/\n/g, '\\n') }).enabled, true);
});

test('Apple client assertion has the Services ID audience contract and short expiry', async () => {
  const token = await appleClientSecret(appleEnv);
  const { payload, protectedHeader } = await jwtVerify(token, pair.publicKey, {
    issuer: appleEnv.APPLE_TEAM_ID, audience: 'https://appleid.apple.com', subject: appleEnv.APPLE_CLIENT_ID,
    algorithms: ['ES256']
  });
  assert.equal(protectedHeader.kid, appleEnv.APPLE_KEY_ID);
  assert.equal(payload.exp - payload.iat, 300);
  assert.ok(!Object.hasOwn(payload, 'private_key'));
});

test('Apple start uses the exact HTTPS callback, form_post and a cross-site secure binding cookie', async () => {
  const statements = [];
  const env = { ...appleEnv, DB: { prepare(sql) { return { bind(...values) { statements.push({ sql, values }); return {}; } }; }, async batch() {} } };
  const response = await handleAuth(new Request('https://threadnews.online/api/auth/apple/start'), env);
  const destination = new URL(response.headers.get('location'));
  assert.equal(destination.origin, 'https://appleid.apple.com');
  assert.equal(destination.searchParams.get('redirect_uri'), 'https://threadnews.online/api/auth/apple/callback');
  assert.equal(destination.searchParams.get('response_mode'), 'form_post');
  assert.equal(destination.searchParams.get('client_id'), appleEnv.APPLE_CLIENT_ID);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=None/);
  assert.equal(statements.length, 2);
  assert.ok(!response.headers.get('location').includes(pem));
});

test('Apple callback cancels a streamed oversized body before buffering the whole request', async () => {
  let chunks = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new TextEncoder().encode('a'.repeat(3000))); if (chunks === 100) controller.close(); },
    cancel() { cancelled = true; }
  });
  const request = new Request('https://threadnews.online/api/auth/apple/callback', {
    method: 'POST', duplex: 'half', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
  });
  const response = await handleAuth(request, appleEnv);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, 'callback_too_large');
  assert.ok(chunks < 10);
  assert.equal(cancelled, true);
});

test('a provider exchange failure returns the safe retry page and never creates a session', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('private provider failure details'); };
  try {
    const queries = [];
    const env = { APP_ORIGIN: appleEnv.APP_ORIGIN, GOOGLE_CLIENT_ID: 'fixture', GOOGLE_CLIENT_SECRET: 'fixture-secret',
      DB: { prepare(sql) { queries.push(sql); return { bind() { return { async first() { return { verifier: 'fixture', nonce: 'fixture-nonce' }; } }; } }; } } };
    const response = await handleAuth(new Request('https://threadnews.online/api/auth/google/callback?state=' + 'a'.repeat(43) + '&code=fixture', {
      headers: { cookie: '__Host-threadline-oauth=' + 'b'.repeat(43) }
    }), env);
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /auth_error=sign_in_failed/);
    assert.ok(!response.headers.get('set-cookie').includes('__Host-threadline-session'));
    assert.ok(queries.every(query => !query.includes('INSERT INTO sessions')));
  } finally { globalThis.fetch = original; }
});
