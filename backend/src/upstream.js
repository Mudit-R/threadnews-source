import { readLimited } from './feed.js';

/** Small, non-sensitive error codes shared by scheduled collectors. */
export class CollectorError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Fetch bounded JSON from a registry-owned upstream URL.
 * Redirects are rejected so a trusted endpoint cannot redirect the Worker to
 * an unrelated host. The response body is consumed through the same byte cap
 * used by the RSS collector. */
export async function fetchJSON(url, { fetchImpl = fetch, maxBytes = 2 * 1024 * 1024, timeoutMs = 20000, ...options } = {}) {
  let target;
  try { target = new URL(url); } catch { throw new CollectorError('invalid_upstream_url'); }
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new CollectorError('invalid_upstream_url');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) throw new CollectorError('invalid_upstream_size_limit');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new CollectorError('invalid_upstream_timeout');
  let response;
  try {
    const signal = options.signal || AbortSignal.timeout(timeoutMs);
    // Cloudflare Workers do not implement redirect:'error'. Use manual mode
    // and reject every redirect response before reading its body.
    response = await fetchImpl(target, { ...options, redirect: 'manual', signal });
  } catch {
    throw new CollectorError('upstream_fetch_failed');
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    throw new CollectorError('upstream_http_' + response.status);
  }
  try { return JSON.parse(await readLimited(response, maxBytes)); }
  catch { throw new CollectorError('invalid_or_oversized_upstream_json'); }
}
