import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectorError, fetchJSON } from '../src/upstream.js';

test('JSON upstream uses Worker-supported manual redirects and bounds response bytes', async () => {
  let requested;
  const result = await fetchJSON('https://stats.example.org/series', {
    fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return Response.json({ ok: true });
    },
    redirect: 'follow'
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requested.url, 'https://stats.example.org/series');
  assert.equal(requested.options.redirect, 'manual');
  assert.ok(requested.options.signal);
});

test('JSON upstream rejects invalid URLs, oversized bodies and HTTP failures with fixed codes', async () => {
  await assert.rejects(fetchJSON('file:///etc/passwd', { fetchImpl: async () => { throw new Error('must not fetch'); } }), error => error instanceof CollectorError && error.code === 'invalid_upstream_url');
  await assert.rejects(fetchJSON('https://stats.example.org/large', { maxBytes: 10, fetchImpl: async () => new Response('x'.repeat(20), { headers: { 'content-length': '20' } }) }), error => error.code === 'invalid_or_oversized_upstream_json');
  await assert.rejects(fetchJSON('https://stats.example.org/offline', { fetchImpl: async () => new Response('', { status: 503 }) }), error => error.code === 'upstream_http_503');
});

test('a redirect response is rejected without asking Workers for redirect:error', async () => {
  let redirectMode = null;
  await assert.rejects(fetchJSON('https://stats.example.org/moved', {
    fetchImpl: async (_url, options) => {
      redirectMode = options.redirect;
      if (options.redirect === 'error') throw new TypeError('Worker does not implement redirect:error');
      return new Response('', { status: 302, headers: { location: 'https://other.example.org/moved' } });
    }
  }), error => error.code === 'upstream_http_302');
  assert.equal(redirectMode, 'manual');
});
