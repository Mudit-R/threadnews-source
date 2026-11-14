import { canonicalUrl, sha256 } from './feed.js';

const MAX_BATCH = 100;
const MAX_DEFINITIONS = 2000;
const NOTE = 'These are automatically linked source headlines, not reviewed timeline milestones or independently verified claims. Open each original source for its reporting.';
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const generic = new Set(['news', 'world', 'india', 'report', 'reports', 'update', 'updates', 'latest', 'war', 'crisis', 'economy', 'economic', 'government', 'official']);

export function normalizeTrackingText(value) {
  return String(value || '').slice(0, 10000).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function phrases(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid tracking ' + name);
  const result = value.map(phrase => {
    if (typeof phrase !== 'string' || phrase.length > 120) throw new Error('Invalid tracking phrase');
    const normalized = normalizeTrackingText(phrase);
    if (normalized.length < 3 || normalized.length > 120) throw new Error('Invalid tracking phrase');
    return normalized;
  });
  return [...new Set(result)];
}

/** A deliberately small data format, with no executable expressions or regex.
 * Each rule has mandatory anchors, optional contextual phrases and exclusions.
 * Definitions are persisted with an event rather than hardcoded in the app. */
export function validateEventTracking(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'rules', 'version'].includes(key))) throw new Error('Invalid event tracking');
  if (value.version != null && value.version !== 1) throw new Error('Unsupported tracking version');
  if (value.enabled != null && typeof value.enabled !== 'boolean') throw new Error('Invalid tracking enabled state');
  if (!Array.isArray(value.rules) || !value.rules.length || value.rules.length > 8) throw new Error('Tracking requires one to eight rules');
  const rules = value.rules.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some(key => !['all', 'any', 'none'].includes(key))) throw new Error('Invalid tracking rule');
    const all = phrases(rule.all, 'all'), any = phrases(rule.any, 'any'), none = phrases(rule.none, 'none');
    if (!all.length || !all.some(phrase => !generic.has(phrase) && (phrase.includes(' ') || phrase.length >= 5))) throw new Error('Tracking requires a specific event anchor');
    if (all.some(phrase => none.includes(phrase))) throw new Error('Contradictory tracking rule');
    return { all, any, none };
  });
  if (JSON.stringify(rules).length > 6000) throw new Error('Tracking rules exceed size limit');
  return { version: 1, enabled: value.enabled !== false, rules };
}

const contains = (text, phrase) => (' ' + text + ' ').includes(' ' + phrase + ' ');
function articleText(article) {
  let keywords = article.keywords;
  if (typeof keywords === 'string') keywords = parse(keywords, keywords);
  if (Array.isArray(keywords)) keywords = keywords.filter(x => typeof x === 'string').slice(0, 40).join(' ');
  return normalizeTrackingText(String(article.title || '').slice(0, 600) + ' ' + String(keywords || '').slice(0, 4000));
}

export function matchEventTracking(article, definition) {
  const tracking = validateEventTracking(definition);
  if (!tracking?.enabled) return null;
  const text = articleText(article);
  for (let index = 0; index < tracking.rules.length; index++) {
    const rule = tracking.rules[index];
    if (rule.all.every(phrase => contains(text, phrase)) && (!rule.any.length || rule.any.some(phrase => contains(text, phrase))) && !rule.none.some(phrase => contains(text, phrase))) {
      return { type: 'rule-match', rule: index, phrases: [...rule.all, ...rule.any.filter(phrase => contains(text, phrase))] };
    }
  }
  return null;
}

/** Call validation before any parent import writes rows. */
export function validateTrackedEvents(events) {
  if (!Array.isArray(events) || events.length > 25) throw new Error('At most 25 tracked events are accepted');
  for (const event of events) { if (!validId(event.id)) throw new Error('Invalid tracked event id'); validateEventTracking(event.tracking); }
}

/** Call after event_payloads have been imported. Omitting tracking removes its
 * previous rules, so an editor can disable automation by publishing a revision. */
export async function syncEventTracking(env, events, { now = new Date() } = {}) {
  if (!env.DB) throw new Error('Database is not configured');
  validateTrackedEvents(events);
  const timestamp = now.toISOString(), statements = events.map(event => {
    const definition = validateEventTracking(event.tracking);
    return definition ? env.DB.prepare(`INSERT INTO event_tracking (event_id,enabled,rules_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET enabled=excluded.enabled,rules_json=excluded.rules_json,updated_at=excluded.updated_at`).bind(event.id, definition.enabled ? 1 : 0, JSON.stringify(definition), timestamp) : env.DB.prepare('DELETE FROM event_tracking WHERE event_id=?').bind(event.id);
  });
  if (statements.length) await env.DB.batch(statements);
  return { definitions: events.filter(event => event.tracking?.enabled !== false && event.tracking).length };
}

function snapshot(row, eventId, matchedBy) {
  return { articleId: row.id, eventId, title: row.title, originalHeadline: row.original_headline || row.title,
    publishedAt: row.published_at, category: row.category, region: row.region,
    source: parse(row.source_json, {}), officialSources: parse(row.official_sources_json, []),
    basis: 'source-headline', verification: 'not-reviewed', matchedBy,
    note: NOTE };
}

async function linkRows(env, rows, now) {
  const definitions = await env.DB.prepare('SELECT event_id,rules_json FROM event_tracking WHERE enabled=1 ORDER BY event_id LIMIT ?').bind(MAX_DEFINITIONS + 1).all();
  const records = definitions.results || [];
  // Never claim that all events were checked after silently truncating a registry.
  if (records.length > MAX_DEFINITIONS) throw new Error('Event registry exceeds this matcher batch; shard tracking before expanding');
  const known = new Set((await env.DB.prepare('SELECT id FROM event_payloads WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(rows.map(row => row.event_id).filter(Boolean))).all()).results?.map(row => row.id) || []);
  const at = now.toISOString(), values = [], assigned = [], stats = { checked: rows.length, linked: 0, ambiguous: 0, unmatched: 0, definitions: records.length };
  for (const row of rows) {
    const explicit = row.event_id && known.has(row.event_id) && row.data_mode !== 'automatic';
    const matches = explicit ? [{ eventId: row.event_id, matchedBy: { type: 'editor-linked', rule: null, phrases: [] } }] : records.flatMap(definition => {
      const match = matchEventTracking({ title: row.title, keywords: row.keywords }, parse(definition.rules_json, null));
      return match ? [{ eventId: definition.event_id, matchedBy: match }] : [];
    });
    if (matches.length !== 1) { stats[matches.length ? 'ambiguous' : 'unmatched']++; continue; }
    const { eventId, matchedBy } = matches[0], payload = JSON.stringify(snapshot(row, eventId, matchedBy));
    const id = 'coverage-' + (await sha256(eventId + '\0' + row.canonical_url)).slice(0, 40);
    values.push({ id, eventId, url: row.canonical_url, newsId: row.id, publishedAt: row.published_at, at, payload, hash: await sha256(payload) });
    // An editor's existing assignment must not be replaced by an inferred one.
    if (!row.event_id || row.data_mode === 'automatic') assigned.push({ newsId: row.id, eventId });
    stats.linked++;
  }
  if (values.length) {
    const payload = JSON.stringify(values);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO event_coverage_revisions (coverage_id,recorded_at,content_hash,payload_json) SELECT c.id,json_extract(j.value,'$.at'),c.content_hash,c.payload_json FROM event_coverage c JOIN json_each(?) j ON c.id=json_extract(j.value,'$.id') WHERE c.content_hash<>json_extract(j.value,'$.hash')`).bind(payload),
      env.DB.prepare(`INSERT INTO event_coverage (id,event_id,source_url,news_id,published_at,first_seen_at,last_seen_at,payload_json,content_hash) SELECT json_extract(value,'$.id'),json_extract(value,'$.eventId'),json_extract(value,'$.url'),json_extract(value,'$.newsId'),json_extract(value,'$.publishedAt'),json_extract(value,'$.at'),json_extract(value,'$.at'),json_extract(value,'$.payload'),json_extract(value,'$.hash') FROM json_each(?) WHERE true ON CONFLICT(event_id,source_url) DO UPDATE SET news_id=excluded.news_id,published_at=excluded.published_at,last_seen_at=excluded.last_seen_at,payload_json=excluded.payload_json,content_hash=excluded.content_hash`).bind(payload),
      env.DB.prepare(`UPDATE news SET event_id=(SELECT json_extract(j.value,'$.eventId') FROM json_each(?) j WHERE json_extract(j.value,'$.newsId')=news.id) WHERE id IN (SELECT json_extract(value,'$.newsId') FROM json_each(?))`).bind(JSON.stringify(assigned), JSON.stringify(assigned))
    ]);
  }
  await env.DB.prepare(`INSERT INTO app_state (key,value) VALUES ('event_link_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify({ ...stats, checkedAt: at, note: NOTE })).run();
  return stats;
}

/** Invoke after the article upsert. Attribution comes from persisted validated
 * rows, not from the raw import argument. Empty batches perform no extra work. */
export async function linkArticlesToEvents(env, articles, { now = new Date() } = {}) {
  if (!env.DB) throw new Error('Database is not configured');
  if (!Array.isArray(articles) || articles.length > MAX_BATCH) throw new Error('At most 100 articles may be linked');
  const urls = [...new Set(articles.map(article => canonicalUrl(article?.source?.url)).filter(Boolean))];
  if (!urls.length) return { checked: 0, linked: 0, ambiguous: 0, unmatched: 0 };
  const rows = await env.DB.prepare('SELECT id,canonical_url,title,original_headline,category,region,keywords,published_at,source_json,official_sources_json,event_id,data_mode FROM news WHERE canonical_url IN (SELECT value FROM json_each(?))').bind(JSON.stringify(urls)).all();
  return linkRows(env, rows.results || [], now);
}

/** A bounded reconciliation covers stories imported before event definitions.
 * It never derives event dates or causal claims from a headline. */
export async function linkRecentArticles(env, { now = new Date(), limit = 100 } = {}) {
  if (!env.DB) throw new Error('Database is not configured');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new Error('Invalid linking batch size');
  const rows = await env.DB.prepare('SELECT id,canonical_url,title,original_headline,category,region,keywords,published_at,source_json,official_sources_json,event_id,data_mode FROM news ORDER BY published_at DESC,id DESC LIMIT ?').bind(limit).all();
  return linkRows(env, rows.results || [], now);
}

function cursor(value) {
  try {
    if (!value || value.length > 800 || !/^[\w-]+$/.test(value)) throw new Error();
    const decoded = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
    if (decoded.v !== 1 || !validId(decoded.event) || !/^coverage-[a-f0-9]{40}$/.test(decoded.id) || typeof decoded.at !== 'string' || new Date(decoded.at).toISOString() !== decoded.at || typeof decoded.since !== 'string') throw new Error();
    return decoded;
  } catch { throw new Error('Invalid event coverage cursor'); }
}
const encode = value => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** Route before the generic /api/events/:id handler. Returns null otherwise. */
export async function handleEventCoverage(request, env) {
  const url = new URL(request.url), match = url.pathname.match(/^\/api\/events\/([^/]+)\/coverage(?:\/(coverage-[a-f0-9]{40})\/revisions)?$/);
  if (!match) return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  if (!env.DB) return json({ error: 'database_not_configured' }, 503);
  let eventId; try { eventId = decodeURIComponent(match[1]); } catch { return json({ error: 'invalid_event_id' }, 400); }
  if (!validId(eventId)) return json({ error: 'invalid_event_id' }, 400);
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: 'Limit must be between 1 and 100' }, 400);
  try {
    if (!await env.DB.prepare('SELECT id FROM event_payloads WHERE id=?').bind(eventId).first()) return json({ error: 'event_not_found' }, 404);
    if (match[2]) {
      if (!await env.DB.prepare('SELECT id FROM event_coverage WHERE id=? AND event_id=?').bind(match[2], eventId).first()) return json({ error: 'coverage_not_found' }, 404);
      const after = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null;
      if (after != null && (!Number.isSafeInteger(after) || after < 1)) return json({ error: 'invalid_revision_cursor' }, 400);
      const rows = (await env.DB.prepare(`SELECT id,recorded_at,payload_json FROM event_coverage_revisions WHERE coverage_id=?${after ? ' AND id<?' : ''} ORDER BY id DESC LIMIT ?`).bind(match[2], ...(after ? [after] : []), limit + 1).all()).results || [];
      const hasMore = rows.length > limit, page = rows.slice(0, limit);
      return json({ revisions: page.map(row => ({ id: row.id, recordedAt: row.recorded_at, coverage: parse(row.payload_json, {}) })), meta: { hasMore, nextBefore: hasMore ? page.at(-1).id : null, note: 'Prior headline metadata, not archived publisher articles.' } });
    }
    const since = url.searchParams.get('since') || '';
    if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since || since > new Date().toISOString().slice(0, 10))) return json({ error: 'invalid_coverage_start_date' }, 400);
    let after; try { if (url.searchParams.has('cursor')) { after = cursor(url.searchParams.get('cursor')); if (after.event !== eventId || after.since !== since) throw new Error(); } } catch { return json({ error: 'invalid_event_coverage_cursor' }, 400); }
    const cutoff = since ? ' AND published_at>=?' : '', cutoffArgs = since ? [since + 'T00:00:00.000Z'] : [];
    const [result, count] = await Promise.all([
      env.DB.prepare(`SELECT id,published_at,first_seen_at,last_seen_at,payload_json,(SELECT COUNT(*) FROM event_coverage_revisions r WHERE r.coverage_id=c.id) AS revision_count FROM event_coverage c WHERE event_id=?${cutoff}${after ? ' AND (published_at<? OR (published_at=? AND id<?))' : ''} ORDER BY published_at DESC,id DESC LIMIT ?`).bind(eventId, ...cutoffArgs, ...(after ? [after.at, after.at, after.id] : []), limit + 1).all(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM event_coverage WHERE event_id=?' + cutoff).bind(eventId, ...cutoffArgs).first()
    ]);
    const rows = result.results || [], hasMore = rows.length > limit, page = rows.slice(0, limit), last = page.at(-1);
    return json({ coverage: page.map(row => ({ ...parse(row.payload_json, {}), id: row.id, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, revisionCount: row.revision_count })), meta: { total: count?.n || 0, since: since || null, hasMore, nextCursor: hasMore ? encode({ v: 1, event: eventId, at: last.published_at, id: last.id, since }) : null, note: NOTE } });
  } catch { return json({ error: 'event_coverage_unavailable' }, 503); }
}
