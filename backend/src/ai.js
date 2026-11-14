import { sameOriginMutation } from './auth.js';
import { isDailyEvidencePublic, retrieveDailyEvidence, retrieveEvidence, retrieveStoryChanges } from './ai-evidence.js';
import { generateClaims } from './ai-provider.js';

const LIMIT = 60;
const MAX_BODY = 2048;
const CACHE_VERSION = '2';
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

async function rateLimit(request, env) {
  const client = request.headers.get('cf-connecting-ip');
  if (client && env.ASK_RATE_LIMIT) {
    const { success } = await env.ASK_RATE_LIMIT.limit({ key: await digest(client) });
    if (!success) return reply({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
  }
  return null;
}

async function checkedRequest(request, env) {
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  if (!sameOriginMutation(request, env)) return reply({ error: 'origin_not_allowed' }, 403);
  if (!env.DB || env.NEWS_STORAGE === 'static') return reply({ error: 'evidence_unavailable' }, 503);
  return rateLimit(request, env);
}

export async function handleAsk(request, env, ctx) {
  const blocked = await checkedRequest(request, env);
  if (blocked) return blocked;
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

const CHANGE_QUESTION = 'Explain what changed in this story within the selected window. Use the baseline only for context and cite a newer milestone or report in every claim. A linked report must be attributed to its publisher. A report date describes publication; do not present it as the date something happened. Do not use the number of links as evidence of corroboration.';

export async function handleStoryChanges(request, env, ctx) {
  const blocked = await checkedRequest(request, env);
  if (blocked) return blocked;
  const params = new URL(request.url).searchParams;
  const id = params.get('event') || '', days = params.get('days') || '90';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(id) || !['30', '90', '365'].includes(days)) {
    return reply({ error: 'invalid_window' }, 400);
  }
  const snapshot = await retrieveStoryChanges(env, id, Number(days), new Date());
  if (!snapshot) return reply({ error: 'event_not_found' }, 404);
  const { evidence, counts } = snapshot;
  const output = { ...snapshot, status: 'sources', claims: [] };
  if (!evidence.some(item => item.role !== 'baseline')) {
    return reply({ ...output, status: 'no_changes', message: 'No dated updates were found in this range of ThreadNews coverage.' });
  }
  if (!env.GEMINI_API_KEY && !env.AI) return reply(output);
  const cache = globalThis.caches?.default;
  const cacheKey = cache ? new Request(new URL('/api/ai/cache/' + await digest(JSON.stringify([
    CACHE_VERSION, 'story-changes', id, snapshot.since, counts, evidence, Boolean(env.GEMINI_API_KEY)
  ])), request.url)) : null;
  const cached = cache && await cache.match(cacheKey);
  if (cached) return reply({ ...output, ...await cached.json(), status: 'answered' });
  if (!await reserve(env.DB)) return reply(output);
  const answer = await generateClaims(env, CHANGE_QUESTION, evidence, { expectChange: true });
  if (!answer) return reply(output);
  if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, Response.json(answer, {
    headers: { 'cache-control': 'public, max-age=3600' }
  })).catch(() => {}));
  return reply({ ...output, ...answer, status: 'answered' });
}

const BRIEF_KEY = 'daily_ai_brief_v1';
const DAILY_QUESTION = 'Brief readers on the most consequential developments in this 24-hour edition. Choose up to four distinct stories. Lead with effects on households or public policy where the evidence states them. Attribute each item, keep each to one tight sentence, and do not speculate.';

export async function handleDailyBrief(request, env) {
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  if (!env.DB || env.NEWS_STORAGE === 'static') return reply({ error: 'evidence_unavailable' }, 503);
  const db = env.DB, now = new Date(), timestamp = now.getTime();
  const stored = await db.prepare('SELECT value FROM app_state WHERE key=?').bind(BRIEF_KEY).first();
  const entry = stored ? JSON.parse(stored.value) : null;
  if (entry?.expiresAt > timestamp) {
    if (!entry.brief) return reply({ status: 'preparing' }, 202, { 'retry-after': '3' });
    if (await isDailyEvidencePublic(env, entry.brief.evidence, now)) return reply(entry.brief);
  }
  const lease = JSON.stringify({ expiresAt: timestamp + 30000 });
  const lock = await db.prepare(`INSERT INTO app_state(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE app_state.value=?
    RETURNING key`).bind(BRIEF_KEY, lease, stored?.value || '').first();
  if (!lock) return reply({ status: 'preparing' }, 202, { 'retry-after': '3' });

  const evidence = await retrieveDailyEvidence(env, now);
  const brief = { status: evidence.length ? 'sources' : 'insufficient', asOf: now.toISOString(), claims: [], evidence };
  if (evidence.length && (env.GEMINI_API_KEY || env.AI) && await reserve(db)) {
    const answer = await generateClaims(env, DAILY_QUESTION, evidence);
    if (answer) Object.assign(brief, answer, { status: 'answered' });
  }
  const ttl = brief.status === 'answered' ? 3600000 : 600000;
  await db.prepare('UPDATE app_state SET value=? WHERE key=? AND value=?')
    .bind(JSON.stringify({ expiresAt: timestamp + ttl, brief }), BRIEF_KEY, lease).run();
  return reply(brief);
}
