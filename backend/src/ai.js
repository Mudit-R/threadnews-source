import { sameOriginMutation } from './auth.js';
import { retrieveEvidence } from './ai-evidence.js';
import { generateClaims } from './ai-provider.js';

const LIMIT = 60;
const MAX_BODY = 2048;
const CACHE_VERSION = '1';
const REASONS = {
  no_evidence: 'No closely matching public sources were found.',
  no_provider: 'AI is unavailable. Here are the sources retrieved for your question.',
  daily_budget: 'Today’s AI allowance has been used. You can still browse the matching sources.',
  incomplete_answer: 'An answer could not be verified against the retrieved sources.'
};
const reply = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
});
const fallback = (reason, evidence) => reply({
  status: evidence.length ? 'sources' : 'insufficient', reason, message: REASONS[reason], claims: [], evidence
});

async function readInput(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return null;
  if (Number(request.headers.get('content-length')) > MAX_BODY || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, raw = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) { await reader.cancel(); return null; }
      raw += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(raw + decoder.decode());
    if (typeof value?.question !== 'string') return null;
    const question = value.question.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (question.length < 8 || question.length > 240 || /[\p{Cc}\p{Cf}]/u.test(question)) return null;
    if (value.eventId != null && (typeof value.eventId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value.eventId))) return null;
    if (value.countryCode != null && (typeof value.countryCode !== 'string' || !/^[A-Z]{2}$/.test(value.countryCode))) return null;
    if (value.eventId && value.countryCode) return null;
    return { question, eventId: value.eventId || null, countryCode: value.countryCode || null };
  } catch { return null; }
  finally { reader.releaseLock(); }
}

async function digest(data) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

async function reserve(db) {
  const day = new Date().toISOString().slice(0, 10);
  return db.prepare(`INSERT INTO ai_budget(id,day,used) VALUES (1,?,1)
    ON CONFLICT(id) DO UPDATE SET day=excluded.day,
    used=CASE WHEN ai_budget.day=excluded.day THEN ai_budget.used+1 ELSE 1 END
    WHERE ai_budget.day<>excluded.day OR ai_budget.used<?
    RETURNING used`).bind(day, LIMIT).first();
}

export async function handleAsk(request, env, ctx) {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  if (!sameOriginMutation(request, env)) return reply({ error: 'origin_not_allowed' }, 403);
  if (!env.DB || env.NEWS_STORAGE === 'static') return reply({ error: 'evidence_unavailable' }, 503);
  const client = request.headers.get('cf-connecting-ip');
  if (client && env.ASK_RATE_LIMIT) {
    const { success } = await env.ASK_RATE_LIMIT.limit({ key: await digest(client) });
    if (!success) return reply({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
  }
  const input = await readInput(request);
  if (!input) return reply({ error: 'invalid_question' }, 400);
  const evidence = await retrieveEvidence(env, input);
  if (!evidence.length) return fallback('no_evidence', []);
  if (!env.GEMINI_API_KEY && !env.AI) return fallback('no_provider', evidence);
  const cache = globalThis.caches?.default;
  const cacheKey = cache ? new Request(new URL('/api/ai/cache/' + await digest(JSON.stringify([
    CACHE_VERSION, Boolean(env.GEMINI_API_KEY), input, evidence
  ])), request.url)) : null;
  const cached = cache && await cache.match(cacheKey);
  if (cached) return reply(await cached.json());
  if (!await reserve(env.DB)) return fallback('daily_budget', evidence);
  const answer = await generateClaims(env, input.question, evidence);
  if (!answer) return fallback('incomplete_answer', evidence);
  const output = { status: 'answered', ...answer, evidence };
  if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, Response.json(output, {
    headers: { 'cache-control': 'public, max-age=3600' }
  })).catch(() => {}));
  return reply(output);
}
