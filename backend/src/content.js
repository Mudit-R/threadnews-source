import { canonicalUrl, plainText, readLimited, sha256 } from './feed.js';
import { enabledFeedIds, canonicalPublisher } from './feeds.js';
import { CATEGORY_ALLOWLIST, isImpactNews, impactScore, normalizeCategory } from './policy.js';
import { validateTrackedEvents, syncEventTracking, linkArticlesToEvents, linkRecentArticles, handleEventCoverage } from './events.js';

const DAY = 86400000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_ARTICLES = 100;
const MAX_EVENTS = 25;
const COLS = 'id,canonical_url,title,original_headline,summary,category,region,keywords,published_at,ingested_at,source_json,official_sources_json,event_id,feed_id,data_mode,publisher,source_type,official_count,metadata_json,content_hash';
// Feed refreshes may update their own headline metadata, but must not replace a
// stronger source-backed or reviewed record. Explicit editorial imports can
// still correct/retract a prior record. All expressions here are fixed SQL.
const evidenceRankSql = column => `(CASE COALESCE(json_extract(${column},'$.digestBasis'),'') WHEN 'article-reviewed' THEN 5 WHEN 'source-summary' THEN 4 WHEN 'official-primary-source' THEN 4 WHEN 'source-extract' THEN 3 WHEN 'publisher-preview' THEN 2 WHEN 'feed-description' THEN 1 ELSE 0 END)`;
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
class ContentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new ContentError(message, status); };
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const boundedInt = (value, fallback, min, max) => {
  const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
export function contentConfig(env = {}) {
  const feedDays = boundedInt(env.NEWS_FEED_DAYS, 4, 1, 365);
  return { feedDays, retentionDays: Math.max(feedDays, boundedInt(env.NEWS_RETENTION_DAYS, 30, 1, 3650)) };
}
function text(value, name, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max) fail('Invalid ' + name);
  const result = plainText(value, max);
  if (required && !result) fail('Missing ' + name);
  return result;
}
function identity(value, name = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value)) fail('Invalid ' + name);
  return value;
}
function date(value, name, now, dateOnly = false) {
  if (typeof value !== 'string' || !(dateOnly ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/).test(value)) fail('Invalid ' + name);
  const at = new Date(value);
  const calendar = new Date(value.slice(0, 10));
  if (!Number.isFinite(at.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10) || at.getTime() > now.getTime() + 10 * 60000) fail('Invalid or future ' + name);
  return dateOnly ? at.toISOString().slice(0, 10) : at.toISOString();
}
// Links are metadata only: no ingest endpoint ever fetches a caller-supplied URL.
// Reject credentials and non-public/ambiguous hosts even though no fetch occurs.
export function contentUrl(value, env = {}) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) fail('Invalid source URL');
  const normalized = canonicalUrl(value);
  if (!normalized) fail('Invalid source URL');
  const url = new URL(normalized), host = url.hostname.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) || /\.(?:localhost|local|internal|test|invalid|example)$/.test(host) || (url.port && !['80', '443'].includes(url.port))) fail('Source URL requires a public domain');
  const allowed = String(env.INGEST_ALLOWED_DOMAINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.some(domain => host === domain || host.endsWith('.' + domain))) fail('Source domain is not allowed');
  return normalized;
}
function checkTree(value, env, now, { maxBytes = 512 * 1024 } = {}) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes) fail('Document exceeds size limit', 413);
  let nodes = 0;
  function walk(v, depth = 0, key = '') {
    if (++nodes > 30000 || depth > 18) fail('Document exceeds structural limits', 413);
    if (typeof v === 'string') {
      if (v.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail('Invalid document text');
      if (/^https?:\/\//i.test(v) || /^(?:url|discoveryUrl|publisherHome|terms|attemptedOfficialUrl)$/i.test(key)) contentUrl(v, env);
      if (/^(?:date|published|publishedAt|releaseDate|documentDate|coverageEnd|asOf|asOfDate|retrievedAt|sourceUpdated|generatedAt|updatedAt|ingestedAt)$/i.test(key)) date(v, key, now);
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('Invalid document number');
    } else if (Array.isArray(v)) {
      if (v.length > 2000) fail('Document array exceeds limit', 413);
      for (const item of v) walk(item, depth + 1, key);
    } else if (object(v)) {
      if (Object.keys(v).length > 120) fail('Document object exceeds limit', 413);
      for (const [k, item] of Object.entries(v)) {
        if (['__proto__', 'prototype', 'constructor'].includes(k)) fail('Invalid document key');
        walk(item, depth + 1, k);
      }
    } else if (v !== null && typeof v !== 'boolean') fail('Invalid document value');
  }
  walk(value);
}
function source(value, env, now) {
  if (!object(value)) fail('Missing source');
  checkTree(value, env, now, { maxBytes: 16000 });
  const normalized = { ...value, publisher: canonicalPublisher(text(value.publisher, 'publisher', 200, true)), url: contentUrl(value.url, env) };
  if (value.thumbnailUrl != null) {
    const image = contentUrl(value.thumbnailUrl, env);
    if (new URL(image).protocol !== 'https:') fail('Publisher thumbnail must use HTTPS');
    normalized.thumbnailUrl = image;
  }
  return normalized;
}
const isOfficial = value => /official|primary|government|statistical/i.test(value || '');
async function article(value, env, now, mode) {
  if (!object(value)) fail('Invalid article');
  checkTree(value, env, now, { maxBytes: 50000 });
  const src = source(value.source, env, now);
  const official = value.officialSources || [];
  if (!Array.isArray(official) || official.length > 20) fail('Invalid official sources');
  const officialSources = official.map(x => source(x, env, now));
  const rawSecondary = value.secondarySources || [];
  if (!Array.isArray(rawSecondary) || rawSecondary.length > 20) fail('Invalid secondary sources');
  const secondarySources = rawSecondary.map(item => {
    if (!object(item)) fail('Invalid secondary source');
    const url = item.url || item.articleUrl || item.publisherArticleUrl;
    const normalized = source({ ...item, url }, env, now);
    return {
      publisher: normalized.publisher,
      articleUrl: normalized.url,
      ...(item.sourceType ? { sourceType: text(item.sourceType, 'secondary source type', 200, true) } : {}),
      ...(item.title ? { title: text(item.title, 'secondary source title', 500, true) } : {}),
      ...(item.publishedAt ? { publishedAt: date(item.publishedAt, 'secondary source publication date', now) } : {})
    };
  });
  const keywords = Array.isArray(value.keywords) ? value.keywords : typeof value.keywords === 'string' ? value.keywords.split(',').map(x=>x.trim()).filter(Boolean) : [];
  if (keywords.length > 40) fail('Too many keywords');
  const rawCategory = text(value.category || '', 'category', 80);
  const category = normalizeCategory(rawCategory);
  const result = {
    id: value.id ? identity(value.id) : 'article-' + (await sha256(src.url)).slice(0, 32),
    title: text(value.title, 'title', 500, true), originalHeadline: text(value.originalHeadline || value.title, 'original headline', 600, true),
    summary: text(value.summary || '', 'summary', 2000), category: category.category,
    region: text(value.region || 'Global', 'region', 80, true), keywords: keywords.map(x => text(x, 'keyword', 100, true)),
    publishedAt: date(value.publishedAt, 'publication date', now), source: src, officialSources,
    eventId: value.eventId ? identity(value.eventId, 'event id') : null
  };
  const metadata = {};
  for (const k of ['countries', 'evidenceNote', 'rank', 'digestBasis']) if (value[k] != null) metadata[k] = value[k];
  if (secondarySources.length) metadata.secondarySources = secondarySources;
  metadata.impactScore = impactScore(result);
  const sourceType = isOfficial(src.sourceType) ? 'Official source' : 'News report';
  const hash = await sha256(JSON.stringify({ ...result, id: undefined, metadata }));
  return { ...result, categoryRejectReason: category.rejectReason, submittedCategory: rawCategory, metadata, hash, sourceType, officialCount: officialSources.length, mode };
}
function rowArticle(row) {
  let keywords = parse(row.keywords || '[]', null);
  if (!Array.isArray(keywords)) keywords = String(row.keywords || '').split(',').map(x => x.trim()).filter(Boolean);
  return { ...parse(row.metadata_json || '{}', {}), id: row.id, title: row.title, originalHeadline: row.original_headline,
    summary: row.summary, category: row.category, region: row.region, keywords, publishedAt: row.published_at,
    ingestedAt: row.ingested_at, source: parse(row.source_json, {}), officialSources: parse(row.official_sources_json, []), eventId: row.event_id || null };
}

// Compare-and-swap: an editor, retraction or feed revision can win while the source is being read.
export async function storeSourceSummary(env, { row, source: rawSource, summary, at }) {
  const src = source(rawSource, env, new Date(at));
  const short = text(summary, 'summary', 1000, true);
  const sourceJson = JSON.stringify(src);
  const hash = await sha256(JSON.stringify([row.content_hash, short, sourceJson]));
  const note = src.summaryMethod === 'original-source-excerpt' ? 'Excerpt from the linked original publication.' : 'Summary based on the linked original publication.';
  const guard = `id=? AND content_hash=? AND COALESCE(json_extract(metadata_json,'$.editorialExcluded'),0)=0
    AND ${evidenceRankSql('metadata_json')}<4`;
  const [, result] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO article_revisions(news_id,recorded_at,content_hash,payload_json,reason)
      SELECT id,?,content_hash,json_object('id',id,'title',title,'originalHeadline',original_headline,'summary',summary,
      'category',category,'region',region,'publishedAt',published_at,'source',json(source_json),'officialSources',json(official_sources_json),
      'keywords',keywords,'eventId',event_id,'metadata',json(metadata_json)),'original_source_summary' FROM news WHERE ${guard}`)
      .bind(at,row.id,row.content_hash),
    env.DB.prepare(`UPDATE news SET summary=?,source_json=?,content_hash=?,
      metadata_json=json_set(metadata_json,'$.digestBasis','source-summary','$.evidenceNote',?) WHERE ${guard}`)
      .bind(short,sourceJson,hash,note,row.id,row.content_hash)
  ]);
  return result.meta.changes === 1;
}

const RELATED_STOPWORDS = new Set('a an and are as at be been being by can could for from had has have how in into is it its may of on or our says said that the their them this to was were what when where which who why will with would'.split(' '));
const RELATED_WINDOW = 3 * DAY;
function headlineTokens(value) {
  return new Set(String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{3,}/g)?.map(token => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token).filter(token => !RELATED_STOPWORDS.has(token)) || []);
}
function relatedCoverage(article, postings) {
  const source = article.source || {}, publisher = String(source.publisher || article.publisher || '').toLowerCase();
  const at = Date.parse(article.publishedAt || '');
  const category = postings.get(article.category);
  const existing = Array.isArray(article.secondarySources) ? article.secondarySources : [];
  const tokens = category && headlineTokens(article.title);
  if (!tokens || !publisher || !Number.isFinite(at) || tokens.size < 2) {
    return existing.length > 8 ? { ...article, secondarySources: existing.slice(0, 8) } : article;
  }
  const known = new Set([source.url, ...existing.map(item => item.url || item.articleUrl)].filter(Boolean));
  const sharedTokens = new Map();
  for (const token of tokens) {
    for (const candidate of category.get(token) || []) {
      sharedTokens.set(candidate, (sharedTokens.get(candidate) || 0) + 1);
    }
  }
  const matches = [];
  for (const [candidate, shared] of sharedTokens) {
    const distance = Math.abs(at - candidate.at);
    if (shared < 2 || candidate.id === article.id || publisher === candidate.normalizedPublisher ||
        distance > RELATED_WINDOW || known.has(candidate.url)) continue;
    const smaller = Math.min(tokens.size, candidate.tokenCount);
    const union = tokens.size + candidate.tokenCount - shared;
    if (shared / smaller >= 0.75 && shared / union >= 0.42) matches.push({ candidate, distance });
  }
  matches.sort((a, b) => a.distance - b.distance || a.candidate.order - b.candidate.order);
  const additions = matches.slice(0, 6).map(({ candidate }) => ({
    publisher: candidate.publisher,
    url: candidate.url,
    title: candidate.title,
    publishedAt: candidate.publishedAt,
    sourceType: candidate.sourceType || 'News report'
  }));
  const secondarySources = [...existing, ...additions].slice(0, 8);
  return secondarySources.length ? { ...article, secondarySources } : article;
}
async function attachRelatedCoverage(env, articles) {
  if (!articles.length) return articles;
  const dates = articles.map(article => Date.parse(article.publishedAt || '')).filter(Number.isFinite);
  const publishers = new Map();
  for (const article of articles) {
    const publisher = String(article.source?.publisher || article.publisher || '').toLowerCase();
    if (!article.category || !publisher) continue;
    const existing = publishers.get(article.category);
    if (!existing) publishers.set(article.category, new Set([publisher]));
    else existing.add(publisher);
  }
  if (!dates.length || !publishers.size) return articles;
  const from = new Date(Math.min(...dates) - RELATED_WINDOW).toISOString();
  const through = new Date(Math.max(...dates) + RELATED_WINDOW).toISOString();
  const result = await env.DB.prepare(`SELECT id,title,category,published_at AS publishedAt,
      json_extract(source_json,'$.url') AS url,json_extract(source_json,'$.publisher') AS publisher,
      json_extract(source_json,'$.sourceType') AS sourceType
    FROM news
    WHERE COALESCE(json_extract(metadata_json,'$.editorialExcluded'),0)=0
      AND published_at>=? AND published_at<=? AND category IN (SELECT value FROM json_each(?))
    ORDER BY published_at DESC LIMIT 800`).bind(from, through, JSON.stringify([...publishers.keys()])).all();

  // Tokenize each candidate once for the page. Only compare stories sharing
  // headline terms within the same category.
  const postings = new Map();
  for (const [order, row] of (result.results || []).entries()) {
    const at = Date.parse(row.publishedAt);
    const normalizedPublisher = String(row.publisher || '').toLowerCase();
    const pagePublishers = publishers.get(row.category);
    if (!normalizedPublisher || !Number.isFinite(at) ||
        (pagePublishers.size === 1 && pagePublishers.has(normalizedPublisher))) continue;
    const tokens = headlineTokens(row.title);
    if (tokens.size < 2) continue;
    if (!postings.has(row.category)) postings.set(row.category, new Map());
    const category = postings.get(row.category);
    const candidate = { ...row, at, normalizedPublisher, tokenCount: tokens.size, order };
    for (const token of tokens) {
      if (!category.has(token)) category.set(token, []);
      category.get(token).push(candidate);
    }
  }
  return articles.map(article => relatedCoverage(article, postings));
}

/** Metadata-only upsert. Existing attribution is never reassigned to another publisher. */
export async function storeArticles(env, articles, feedId = 'manual', mode = 'manual', { now = new Date() } = {}) {
  if (!env.DB) fail('Database is not configured', 503);
  identity(feedId, 'feed id');
  if (!['automatic', 'manual', 'seed', 'curated'].includes(mode)) fail('Invalid import mode');
  if (!Array.isArray(articles) || articles.length > MAX_ARTICLES) fail('At most 100 articles are accepted');
  // Normalize every record before the first database mutation.
  const normalized = await Promise.all(articles.map(a => article(a, env, now, mode)));
  const categoryAllowed = normalized.filter(a => !a.categoryRejectReason);
  const allowedUrls = new Set(categoryAllowed.map(a => a.source.url));
  const categoryRejected = normalized.filter(a => a.categoryRejectReason && !allowedUrls.has(a.source.url));
  const prepared = categoryAllowed.filter(isImpactNews);
  const seen = new Set(), values = [];
  let attributionConflicts = 0;
  const existing = prepared.length ? await env.DB.prepare(`SELECT ${COLS} FROM news WHERE canonical_url IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(prepared.map(a => a.source.url)), JSON.stringify(prepared.map(a => a.id))).all() : { results: [] };
  const existingRows = existing.results || [];
  for (const a of prepared) {
    if (seen.has(a.source.url)) {
      if (values.find(row => row.url === a.source.url)?.publisher !== a.source.publisher) fail('Duplicate URL has conflicting publisher attribution', 409);
      continue;
    }
    if (existingRows.some(row => row.id === a.id && row.canonical_url !== a.source.url) || values.some(row => row.id === a.id && row.url !== a.source.url)) fail('Article id already belongs to a different URL', 409);
    const before = existingRows.find(row => row.canonical_url === a.source.url);
    const publisher = before?.publisher || parse(before?.source_json || '{}', {}).publisher;
    if (publisher && publisher !== a.source.publisher) {
      if (mode !== 'automatic') fail('Canonical URL already belongs to a different publisher', 409);
      // Two automated feeds may list one joint announcement. Keep the existing
      // attribution while allowing the other records to proceed.
      attributionConflicts++;
      continue;
    }
    seen.add(a.source.url);
    const id = before?.id || a.id;
    values.push({ ...a, id, url: a.source.url, publisher: a.source.publisher, at: now.toISOString(), feedId, sourceJson: JSON.stringify(a.source), officialJson: JSON.stringify(a.officialSources), keywordsJson: JSON.stringify(a.keywords), metadataJson: JSON.stringify(a.metadata) });
  }
  const statements = [];
  if (values.length) {
    const payload = JSON.stringify(values);
    if (new TextEncoder().encode(payload).length > MAX_BODY) fail('Normalized article batch exceeds size limit', 413);
    // Three bulk statements keep the write count bounded even for 100 articles.
    // D1 batch is atomic: prior snapshots, latest metadata and lineage commit together.
    statements.push(
      env.DB.prepare(`INSERT INTO article_revisions (news_id,recorded_at,content_hash,payload_json)
        SELECT n.id,json_extract(j.value,'$.at'),n.content_hash,json_object('id',n.id,'title',n.title,'originalHeadline',n.original_headline,'summary',n.summary,'category',n.category,'region',n.region,'publishedAt',n.published_at,'source',json(n.source_json),'officialSources',json(n.official_sources_json),'keywords',n.keywords,'eventId',n.event_id,'metadata',json(n.metadata_json))
        FROM news n JOIN json_each(?) j ON n.canonical_url=json_extract(j.value,'$.url')
        WHERE n.content_hash<>json_extract(j.value,'$.hash') AND (n.publisher='' OR n.publisher=json_extract(j.value,'$.publisher'))
          AND NOT (json_extract(j.value,'$.mode')='automatic' AND ${evidenceRankSql('n.metadata_json')}>${evidenceRankSql("json_extract(j.value,'$.metadataJson')")})`).bind(payload),
      env.DB.prepare(`INSERT INTO news (id,canonical_url,title,original_headline,summary,category,region,keywords,published_at,ingested_at,source_json,official_sources_json,event_id,feed_id,data_mode,publisher,source_type,official_count,content_hash,metadata_json)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.url'),json_extract(value,'$.title'),json_extract(value,'$.originalHeadline'),json_extract(value,'$.summary'),json_extract(value,'$.category'),json_extract(value,'$.region'),json_extract(value,'$.keywordsJson'),json_extract(value,'$.publishedAt'),json_extract(value,'$.at'),json_extract(value,'$.sourceJson'),json_extract(value,'$.officialJson'),json_extract(value,'$.eventId'),json_extract(value,'$.feedId'),json_extract(value,'$.mode'),json_extract(value,'$.publisher'),json_extract(value,'$.sourceType'),json_extract(value,'$.officialCount'),json_extract(value,'$.hash'),json_extract(value,'$.metadataJson') FROM json_each(?) WHERE true
        ON CONFLICT(canonical_url) DO UPDATE SET title=excluded.title,original_headline=excluded.original_headline,summary=excluded.summary,category=excluded.category,region=excluded.region,keywords=excluded.keywords,published_at=excluded.published_at,ingested_at=excluded.ingested_at,source_json=excluded.source_json,official_sources_json=excluded.official_sources_json,event_id=CASE WHEN excluded.data_mode='automatic' THEN COALESCE(excluded.event_id,news.event_id) ELSE excluded.event_id END,publisher=excluded.publisher,source_type=excluded.source_type,official_count=excluded.official_count,content_hash=excluded.content_hash,metadata_json=CASE WHEN excluded.data_mode='automatic' AND COALESCE(json_extract(news.metadata_json,'$.editorialExcluded'),0)=1 THEN json_set(excluded.metadata_json,'$.editorialExcluded',1,'$.exclusionReason',json_extract(news.metadata_json,'$.exclusionReason'),'$.excludedAt',json_extract(news.metadata_json,'$.excludedAt')) ELSE excluded.metadata_json END
        WHERE (news.publisher='' OR news.publisher=excluded.publisher)
          AND NOT (excluded.data_mode='automatic' AND ${evidenceRankSql('news.metadata_json')}>${evidenceRankSql('excluded.metadata_json')})`).bind(payload),
      env.DB.prepare(`INSERT INTO article_source_lineage (news_id,feed_id,source_url,source_json,first_seen_at,last_seen_at)
        SELECT n.id,json_extract(j.value,'$.feedId'),n.canonical_url,json_extract(j.value,'$.sourceJson'),json_extract(j.value,'$.at'),json_extract(j.value,'$.at') FROM news n JOIN json_each(?) j ON n.canonical_url=json_extract(j.value,'$.url') WHERE n.publisher=json_extract(j.value,'$.publisher')
        ON CONFLICT(news_id,feed_id,source_url) DO UPDATE SET source_json=excluded.source_json,last_seen_at=excluded.last_seen_at`).bind(payload)
    );
  }
  if (categoryAllowed.length) {
    const urls = JSON.stringify(categoryAllowed.map(a => a.source.url));
    statements.push(env.DB.prepare(`DELETE FROM article_category_rejections WHERE canonical_url IN (SELECT value FROM json_each(?))`).bind(urls));
  }
  if (categoryRejected.length) {
    const rejections = JSON.stringify(categoryRejected.map(a => ({ url: a.source.url, title: a.title, category: a.submittedCategory, publisher: a.source.publisher, reason: a.categoryRejectReason, feedId, mode, at: now.toISOString() })));
    if (new TextEncoder().encode(rejections).length > MAX_BODY) fail('Rejected article batch exceeds size limit', 413);
    statements.push(env.DB.prepare(`INSERT INTO article_category_rejections (canonical_url,title,submitted_category,publisher,reject_reason,feed_id,data_mode,first_seen_at,last_seen_at,seen_count)
      SELECT json_extract(value,'$.url'),json_extract(value,'$.title'),json_extract(value,'$.category'),json_extract(value,'$.publisher'),json_extract(value,'$.reason'),json_extract(value,'$.feedId'),json_extract(value,'$.mode'),json_extract(value,'$.at'),json_extract(value,'$.at'),1 FROM json_each(?) WHERE true
      ON CONFLICT(canonical_url) DO UPDATE SET title=excluded.title,submitted_category=excluded.submitted_category,publisher=excluded.publisher,reject_reason=excluded.reject_reason,feed_id=excluded.feed_id,data_mode=excluded.data_mode,last_seen_at=excluded.last_seen_at,seen_count=article_category_rejections.seen_count+1`).bind(rejections));
  }
  if (statements.length) await env.DB.batch(statements);
  const linked = values.length ? await linkArticlesToEvents(env, values, { now }) : null;
  return { accepted: values.length, duplicatesInRequest: prepared.length - values.length - attributionConflicts,
    ...(attributionConflicts ? { attributionConflicts } : {}), excludedByPolicy: categoryAllowed.length-prepared.length,
    rejectedByCategory: categoryRejected.length, ...(linked?{eventCoverage:linked}:{}) };
}

function encodeCursor(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decodeCursor(value) {
  try {
    if (!value || value.length > 3000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(parsed) || parsed.v !== 1) throw new Error();
    return parsed;
  } catch { fail('Invalid pagination cursor'); }
}
export function buildContentQuery(params, env = {}, { canAccessArchive = false, now = new Date(), cursor = true } = {}) {
  const config = contentConfig(env), archive = params.get('archive') === '1';
  if (archive && !canAccessArchive) fail('Archive access is required', 403);
  const older = params.get('older') === '1';
  if (older && !archive) fail('Choose the archive to browse earlier stories');
  const allowedPriorities = CATEGORY_ALLOWLIST;
  const rawPriorities = params.get('priorities') || '';
  if (params.getAll('priorities').length > 1 || rawPriorities.length > 200) fail('Invalid topic priorities');
  const selectedPriorities = rawPriorities ? rawPriorities.split(',').map(value => normalizeCategory(value.trim())) : [];
  if (selectedPriorities.length > 8 || selectedPriorities.some(value => value.rejectReason)) fail('Invalid topic priorities');
  const selectedPrioritySet = new Set(selectedPriorities.map(value => value.category));
  // Interests are an unordered set. Canonical ordering keeps cursors stable
  // when a reader saves the same choices in a different selection order.
  const priorities = allowedPriorities.filter(value => selectedPrioritySet.has(value)), personalized = priorities.length > 0;
  const priorityJson = JSON.stringify(priorities), priorityExpression = 'CASE WHEN category IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END';
  const filter = name => text(params.get(name) || '', name, name === 'q' ? 160 : 200);
  let topic = filter('topic') || filter('category'), region = filter('region'), publisher = filter('publisher');
  const q = filter('q'), evidence = filter('evidence') || 'all';
  if (['All news', 'All events', 'All topics', 'all'].includes(topic)) topic = '';
  if (['Everywhere', 'All regions', 'all'].includes(region)) region = '';
  if (['All sources', 'All publishers', 'all'].includes(publisher)) publisher = '';
  if (topic) {
    const normalizedTopic = normalizeCategory(topic);
    if (normalizedTopic.rejectReason) fail('Invalid topic category');
    topic = normalizedTopic.category;
  }
  if (!['all', 'official', 'with-official', 'reporting', 'headline', 'article', 'brief'].includes(evidence)) fail('Invalid evidence filter');
  const scope = JSON.stringify({ archive, ...(older ? { older } : {}), topic, region, publisher, q, evidence, ...(personalized ? { priorities } : {}) });
  const hardCutoff = new Date(now.getTime() - config.retentionDays * DAY).toISOString();
  let cutoff = new Date(now.getTime() - (archive ? config.retentionDays : config.feedDays) * DAY).toISOString();
  let until = new Date(now.getTime() - (older ? config.feedDays * DAY + 1 : 0)).toISOString(), after = null;
  if (cursor && params.get('cursor')) {
    after = decodeCursor(params.get('cursor'));
    if (after.scope !== scope || typeof after.cutoff !== 'string' || typeof after.until !== 'string' || typeof after.at !== 'string') fail('Cursor does not match this query');
    if (date(after.at, 'cursor publication date', now) !== after.at || date(after.cutoff, 'cursor cutoff', now) !== after.cutoff || date(after.until, 'cursor bound', now) !== after.until) fail('Invalid cursor dates');
    identity(after.id, 'cursor article id');
    if (personalized ? !Number.isInteger(after.rank) || after.rank < 0 || after.rank > 1 : after.rank != null) fail('Invalid cursor priority rank');
    const earliest = new Date(now.getTime() - (archive ? config.retentionDays : config.feedDays) * DAY - DAY).toISOString();
    if (after.cutoff < earliest || after.at < after.cutoff || after.at > after.until || after.cutoff > after.until) fail('Expired or invalid cursor');
    // An opaque cursor is not an authorization token. Never let its timestamps
    // widen the current feed or retention window, even if someone crafts one.
    cutoff = cutoff > after.cutoff ? cutoff : after.cutoff;
    until = until < after.until ? until : after.until;
  }
  const where = ['category IN (SELECT value FROM json_each(?))', "COALESCE(json_extract(metadata_json,'$.editorialExcluded'),0)=0", 'published_at>=?', 'published_at>=?', 'published_at<=?'], args = [JSON.stringify(CATEGORY_ALLOWLIST), cutoff, hardCutoff, until];
  if (topic) { where.push('category=?'); args.push(topic); }
  if (region) { where.push('region=?'); args.push(region); }
  if (publisher) { where.push('publisher=?'); args.push(publisher); }
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, x => '\\' + x) + '%';
    if (new TextEncoder().encode(like).length > 50) fail('Search phrase is too long. Use a shorter phrase.', 400);
    where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')"); args.push(like, like, like);
  }
  if (evidence === 'official') where.push("source_type='Official source'");
  if (evidence === 'with-official') where.push("(official_count>0 OR source_type='Official source')");
  if (evidence === 'reporting') where.push("source_type='News report'");
  if (evidence === 'brief') where.push(`summary<>'' AND (${evidenceRankSql('metadata_json')}>=3 OR json_extract(metadata_json,'$.digestBasis') IN ('full_text','abstract'))`);
  if (['headline', 'article'].includes(evidence)) { where.push("json_extract(source_json,'$.basis')=?"); args.push(evidence); }
  const baseWhere = ' WHERE ' + where.join(' AND '), baseArgs = [...args];
  if (after) {
    if (personalized) {
      where.push(`(${priorityExpression}>? OR (${priorityExpression}=? AND (published_at<? OR (published_at=? AND id<?))))`);
      args.push(priorityJson, after.rank, priorityJson, after.rank, after.at, after.at, after.id);
    } else { where.push('(published_at<? OR (published_at=? AND id<?))'); args.push(after.at, after.at, after.id); }
  }
  const limit = params.has('limit') ? Number(params.get('limit')) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('Limit must be between 1 and 100');
  const useTimeIndex = !personalized && !topic && !region && !publisher;
  return { ...config, archive, older, scope, cutoff, until, limit, where: ' WHERE ' + where.join(' AND '), args, baseWhere, baseArgs, personalized, priorities, priorityJson, priorityExpression, after, useTimeIndex };
}
async function news(request, env, options) {
  const params = new URL(request.url).searchParams;
  const query = buildContentQuery(params, env, options);
  if (query.personalized && query.after) {
    // The rank in a cursor is not trusted input. Resolve its boundary against
    // the same current filters/window before using it in a ranked seek query.
    const boundary = await env.DB.prepare(`SELECT ${query.priorityExpression} AS priority_rank FROM news${query.baseWhere} AND id=? AND published_at=?`).bind(query.priorityJson, ...query.baseArgs, query.after.id, query.after.at).first();
    if (!boundary || boundary.priority_rank !== query.after.rank) fail('Pagination cursor no longer matches this feed. Start from the first page.');
  }
  const index = query.useTimeIndex ? ' INDEXED BY news_page' : '';
  const [records, count, state, ingestion] = await Promise.all([
    env.DB.prepare(`SELECT ${COLS}${query.personalized ? ',' + query.priorityExpression + ' AS priority_rank' : ''} FROM news${index}${query.where} ORDER BY ${query.personalized ? 'priority_rank ASC,' : ''}published_at DESC,id DESC LIMIT ?`).bind(...(query.personalized ? [query.priorityJson] : []), ...query.args, query.limit + 1).all(),
    params.get('count') === '0' ? null : env.DB.prepare(`SELECT COUNT(*) AS total FROM news${query.baseWhere}`).bind(...query.baseArgs).first(),
    env.DB.prepare('SELECT MAX(last_success_at) AS at FROM feed_state').first(),
    env.DB.prepare('SELECT MAX(ingested_at) AS at FROM news').first()
  ]);
  const rows = records.results || [], hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit), last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ v: 1, at: last.published_at, id: last.id, cutoff: query.cutoff, until: query.until, scope: query.scope, ...(query.personalized ? { rank: last.priority_rank } : {}) }) : null;
  const listed = page.map(rowArticle);
  const articles = params.get('related') === '0' ? listed : await attachRelatedCoverage(env, listed);
  return json({ articles, meta: { mode: 'database', total: count?.total ?? null, limit: query.limit, nextCursor, hasMore, archive: query.archive, older: query.older, personalized: query.personalized, priorities: query.priorities, feedDays: query.feedDays, retentionDays: query.retentionDays, cutoff: query.cutoff, lastIngestedAt: ingestion?.at || null, lastCheckedAt: state?.at || null, coverageNote: 'Related links are grouped by similar headlines, category and publication time. Similar headlines may still describe different developments; source counts do not establish independent corroboration.' } });
}
async function impactCandidates(env) {
  const query = buildContentQuery(new URLSearchParams(), env, { cursor: false });
  const { results } = await env.DB.prepare(`SELECT id,title,category,region,published_at,keywords,publisher,source_type,official_count,
      json_extract(source_json,'$.basis') AS basis,
      json_extract(metadata_json,'$.digestBasis') AS digest_basis,
      json_extract(metadata_json,'$.countries') AS countries,
      json_extract(metadata_json,'$.impactScore') AS impact_score,
      CASE WHEN json_extract(source_json,'$.basis')='article' THEN substr(summary,1,500) ELSE '' END AS summary
    FROM news${query.baseWhere}
    ORDER BY ROW_NUMBER() OVER (PARTITION BY category,region ORDER BY published_at DESC,id DESC),published_at DESC,id DESC
    LIMIT 160`).bind(...query.baseArgs).all();
  const articles = (results || []).map(row => ({
    id: row.id, title: row.title, category: row.category, region: row.region, publishedAt: row.published_at,
    keywords: parse(row.keywords, []), countries: parse(row.countries, []), summary: row.summary,
    digestBasis: row.digest_basis, impactScore: row.impact_score, officialCount: row.official_count,
    source: { publisher: row.publisher, sourceType: row.source_type, basis: row.basis }
  }));
  return json({ articles, meta: { cutoff: query.cutoff, maxCandidates: 160 } });
}

const STORY_COUNTRY_ALIASES = {
  US:['united states','u s','american'], CN:['china','chinese'], DE:['germany','german'],
  JP:['japan','japanese'], GB:['united kingdom','u k','britain','british'], IN:['india','indian'],
  FR:['france','french'], IT:['italy','italian'], CA:['canada','canadian'], RU:['russia','russian'],
  BR:['brazil','brazilian'], AU:['australia','australian'], KR:['south korea','south korean'],
  MX:['mexico','mexican'], ES:['spain','spanish'], ID:['indonesia','indonesian'], TR:['turkey','turkiye','turkish']
};
const regionName = new Intl.DisplayNames('en', { type:'region', fallback:'none' });

async function topStories(request, env) {
  const country = new URL(request.url).searchParams.get('country') || '';
  if (country && !/^[A-Z]{2}$/.test(country)) fail('Invalid country filter');
  const { feedDays, retentionDays } = contentConfig(env);
  const days = country ? Math.min(retentionDays, Math.max(feedDays,14)) : feedDays;
  const query = buildContentQuery(new URLSearchParams(), { ...env, NEWS_FEED_DAYS:days }, { cursor:false });
  const name = country && regionName.of(country);
  const aliases = [...new Set([...(STORY_COUNTRY_ALIASES[country] || []), name?.toLowerCase()].filter(Boolean))];
  const scope = country
    ? ` AND (EXISTS (SELECT 1 FROM json_each(json_extract(metadata_json,'$.countries')) AS countries WHERE upper(countries.value)=?)
      OR instr(' ' || title || ' ', ' ' || ? || ' ')>0
      OR EXISTS (SELECT 1 FROM json_each(?) AS places WHERE
        lower(region)=places.value OR instr(
          ' ' || lower(replace(replace(replace(replace(replace(replace(replace(title,'.',' '),',',' '),'–',' '),'(',' '),')',' '),char(8217),' '),char(39),' ')) || ' ',
          ' ' || places.value || ' ')>0))`
    : '';
  const args = country ? [...query.baseArgs,country,country,JSON.stringify(aliases)] : query.baseArgs;
  const boundary = new Date(Date.now() - DAY).toISOString();
  const candidates = isRecent => env.DB.prepare(`SELECT id,title,published_at AS publishedAt,publisher,event_id AS eventId
    FROM news${query.baseWhere}${scope} AND published_at ${isRecent ? '>=' : '<'} ?
    ORDER BY COALESCE(json_extract(metadata_json,'$.impactScore'),0) DESC,published_at DESC,id DESC
    LIMIT 20`).bind(...args,boundary).all();
  const seen = new Set(), stories = [];
  function append(results) {
    for (const row of results || []) {
      const title = row.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
      if (seen.has(title)) continue;
      seen.add(title);
      stories.push(row);
      if (stories.length === 5) break;
    }
  }
  append((await candidates(true)).results);
  if (stories.length < 5) append((await candidates(false)).results);
  return json({ country, stories, days },200,{'cache-control':'public, max-age=120'});
}

async function singleArticle(request, env, options, id) {
  identity(id, 'article id');
  const publicLink = env.PUBLIC_ARTICLE_LINKS === 'true';
  const params = new URLSearchParams();
  if (publicLink || new URL(request.url).searchParams.get('archive') === '1') params.set('archive', '1');
  const query = buildContentQuery(params, env, { ...options, canAccessArchive:publicLink || options.canAccessArchive });
  const row = await env.DB.prepare(`SELECT ${COLS} FROM news${query.baseWhere} AND id=?`).bind(...query.baseArgs, id).first();
  // Outside-window records use the same result as an unknown identity. Archive
  // authorization is checked before this query, not inferred from a cursor/id.
  if (!row) return json({ error: 'article_not_found' }, 404);
  const article = rowArticle(row);
  if (new URL(request.url).searchParams.get('related') === '0') return json({ article });
  const related = await attachRelatedCoverage(env, [article]);
  return json({ article: related[0] });
}
async function facets(request, env, options) {
  const query = buildContentQuery(new URL(request.url).searchParams, env, { ...options, cursor: false });
  const { results } = await env.DB.prepare(`SELECT category,region,publisher,source_type,COUNT(*) AS count FROM news${query.baseWhere}
    GROUP BY category,region,publisher,source_type`).bind(...query.baseArgs).all();
  const columns = Object.entries({ topics:'category', regions:'region', publishers:'publisher', evidence:'source_type' });
  const counts = Object.fromEntries(columns.map(([key]) => [key,new Map()]));
  let total = 0;
  for (const row of results || []) {
    total += row.count;
    for (const [key,column] of columns) {
      const table=counts[key], value=row[column];
      table.set(value,(table.get(value) || 0)+row.count);
    }
  }
  const order = (a,b) => b.count-a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
  const buckets = Object.fromEntries(Object.entries(counts).map(([key,table]) =>
    [key,[...table].map(([value,count])=>({value,count})).sort(order)]));
  return json({ ...buckets, total, meta: { archive: query.archive, older: query.older, cutoff: query.cutoff, feedDays: query.feedDays, retentionDays: query.retentionDays } });
}
function eventPayload(value, env, now) {
  if (!object(value)) fail('Invalid event');
  checkTree(value, env, now);
  identity(value.id, 'event id'); text(value.title, 'event title', 500, true);
  text(value.category || '', 'event category', 80); text(value.region || '', 'event region', 80);
  if (!Array.isArray(value.milestones) || !value.milestones.length || value.milestones.length > 1000) fail('Invalid event milestones');
  for (const milestone of value.milestones) {
    if (!object(milestone)) fail('Invalid event milestone');
    date(milestone.date, 'milestone date', now, true);
    if (!['event', 'publication'].includes(milestone.dateType)) fail('Invalid milestone date type');
    text(milestone.title, 'milestone title', 600, true);
    if (!Array.isArray(milestone.sources) || !milestone.sources.length || milestone.sources.length > 30) fail('Each milestone requires bounded source attribution');
    milestone.sources.forEach(s => source(s, env, now));
  }
  if (value.coverageEnd) date(value.coverageEnd, 'event coverage end', now, true);
  return value;
}
export async function importEvents(env, events, { now = new Date() } = {}) {
  if (!env.DB) fail('Database is not configured', 503);
  if (!Array.isArray(events) || events.length > MAX_EVENTS) fail('At most 25 events are accepted');
  try { validateTrackedEvents(events); } catch { fail('Invalid event tracking definition'); }
  const values = events.map(e => eventPayload(e, env, now)), statements = [];
  for (const e of values) {
    const payload = JSON.stringify(e), hash = await sha256(payload);
    statements.push(env.DB.prepare(`INSERT INTO event_payloads (id,title,category,region,coverage_end,updated_at,payload_json,content_hash) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,category=excluded.category,region=excluded.region,coverage_end=excluded.coverage_end,updated_at=excluded.updated_at,payload_json=excluded.payload_json,content_hash=excluded.content_hash
      WHERE event_payloads.content_hash<>excluded.content_hash`).bind(e.id, e.title, text(e.category || '', 'event category', 80), text(e.region || '', 'event region', 80), e.coverageEnd || null, now.toISOString(), payload, hash));
  }
  if (statements.length) await env.DB.batch(statements);
  if (values.length) { await syncEventTracking(env, values, { now }); await linkRecentArticles(env, { now, limit: 100 }); }
  return { accepted: values.length };
}
function economyPayload(value, env, now) {
  if (!object(value) || !Array.isArray(value.countries) || value.countries.length > 250) fail('Invalid economy document');
  checkTree(value, env, now, { maxBytes: 1024 * 1024 });
  return value;
}
export async function importEconomy(env, economy, { now = new Date(), expectedEconomyHash } = {}) {
  if (!env.DB) fail('Database is not configured', 503);
  economyPayload(economy, env, now);
  if (expectedEconomyHash !== undefined && expectedEconomyHash !== null && (typeof expectedEconomyHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(expectedEconomyHash))) fail('Invalid expected economy version');
  const payload = JSON.stringify(economy), hash = await sha256(payload);
  if (expectedEconomyHash === undefined) {
    await env.DB.prepare(`INSERT INTO content_documents (id,updated_at,payload_json,content_hash) VALUES ('economy',?,?,?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json,content_hash=excluded.content_hash`).bind(now.toISOString(), payload, hash).run();
  } else if (expectedEconomyHash === null) {
    const inserted = await env.DB.prepare(`INSERT INTO content_documents (id,updated_at,payload_json,content_hash) VALUES ('economy',?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`).bind(now.toISOString(), payload, hash).first();
    if (!inserted) fail('Economy document changed during refresh; retry with the latest version.', 409);
  } else {
    const updated = await env.DB.prepare("UPDATE content_documents SET updated_at=?,payload_json=?,content_hash=? WHERE id='economy' AND content_hash=? RETURNING id").bind(now.toISOString(), payload, hash, expectedEconomyHash.toLowerCase()).first();
    if (!updated) fail('Economy document changed during refresh; retry with the latest version.', 409);
  }
  return { accepted: 1 };
}
export async function cleanupContent(env, { now = new Date() } = {}) {
  if (!env.DB) return { ok: false, reason: 'database_not_configured' };
  const { feedDays, retentionDays } = contentConfig(env);
  const feedCutoff = new Date(now.getTime() - feedDays * DAY).toISOString(), retentionCutoff = new Date(now.getTime() - retentionDays * DAY).toISOString();
  const deleted = await env.DB.prepare('DELETE FROM news WHERE published_at<?').bind(retentionCutoff).run();
  const archived = await env.DB.prepare('SELECT COUNT(*) AS count FROM news WHERE published_at<?').bind(feedCutoff).first();
  const result = { ok: true, deleted: deleted.meta?.changes || 0, archived: archived?.count || 0, feedCutoff, retentionCutoff, cleanedAt: now.toISOString() };
  await env.DB.prepare("INSERT INTO app_state (key,value) VALUES ('content_cleanup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(result)).run();
  return result;
}
async function pipeline(env) {
  const [result, summary, cleanup, states, economy] = await Promise.all([
    env.DB.prepare('SELECT id,last_attempt_at,last_success_at,error,item_count FROM feed_state ORDER BY id').all(),
    env.DB.prepare('SELECT COUNT(*) AS total,MAX(published_at) AS newestPublishedAt,MAX(ingested_at) AS lastStoredAt FROM news').first(),
    env.DB.prepare("SELECT value FROM app_state WHERE key='content_cleanup'").first(),
    env.DB.prepare("SELECT key,value FROM app_state WHERE key IN ('economy_refresh_status','economy_source_refresh_status','event_link_status','scheduled_news','scheduled_source_summaries','scheduled_reader_updates','scheduled_economy_source','scheduled_annual_economy','scheduled_paypal_reconciliation')").all(),
    env.DB.prepare("SELECT updated_at,json_extract(payload_json,'$.meta.monthlyRefresh') AS monthly,json_extract(payload_json,'$.meta.annualRefresh') AS annual FROM content_documents WHERE id='economy'").first()
  ]);
  const enabled = new Set(enabledFeedIds(env));
  if (env.PUBLIC_RECORDS_SYNC === 'true') enabled.add('federal-register');
  const feeds = (result.results || []).map(row => ({ id: row.id, enabled: enabled.has(row.id), lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, error: row.error ? 'The last feed refresh failed.' : null, itemCount: row.item_count }));
  for (const id of enabled) if (!feeds.some(f => f.id === id)) feeds.push({ id, enabled: true, lastAttemptAt: null, lastSuccessAt: null, error: null, itemCount: 0 });
  return json({ feeds, economy: economy?{storedAt:economy.updated_at,monthly:parse(economy.monthly,null),annual:parse(economy.annual,null)}:null, tracking: Object.fromEntries((states.results||[]).map(row=>[row.key,parse(row.value,null)])), meta: { ...contentConfig(env), total: summary?.total || 0, newestPublishedAt: summary?.newestPublishedAt || null, lastStoredAt: summary?.lastStoredAt || null, cleanup: parse(cleanup?.value || 'null', null), note: 'Feed status reflects persisted attempts and successes; a configured feed is not evidence of a successful fetch.' } });
}

async function contentBackup(request,env) {
  await authorized(request,env);
  if(!env.DB)fail('Database is not configured',503);
  const params=new URL(request.url).searchParams,kind=params.get('kind');
  if(!['news','events','economy'].includes(kind))fail('Choose news, events or economy');
  let after='';
  if(params.has('cursor')){const cursor=decodeCursor(params.get('cursor'));if(cursor.scope!=='backup:'+kind)fail('Invalid backup cursor');after=identity(cursor.id);}
  if(kind==='economy'){
    if(after)fail('Economy has no next page');
    const row=await env.DB.prepare("SELECT payload_json FROM content_documents WHERE id='economy'").first();
    return json({records:row?[JSON.parse(row.payload_json)]:[],nextCursor:null});
  }
  const rows=kind==='news'?await env.DB.prepare(`SELECT ${COLS} FROM news WHERE id>? ORDER BY id LIMIT 101`).bind(after).all():await env.DB.prepare('SELECT id,payload_json FROM event_payloads WHERE id>? ORDER BY id LIMIT 101').bind(after).all();
  const all=rows.results||[],page=all.slice(0,100);
  return json({records:kind==='news'?page.map(rowArticle):page.map(row=>JSON.parse(row.payload_json)),nextCursor:all.length>100?encodeCursor({v:1,scope:'backup:'+kind,id:page.at(-1).id}):null});
}
async function retract(request,env){
  await authorized(request,env);if(!env.DB)fail('Database is not configured',503);
  if(!request.headers.get('content-type')?.startsWith('application/json'))fail('JSON content type is required',415);
  let body;try{body=JSON.parse(await readLimited(request,16000));}catch{fail('Invalid or oversized retraction request');}
  if(!object(body)||Object.keys(body).some(key=>key!=='ids')||!Array.isArray(body.ids)||!body.ids.length||body.ids.length>100)fail('Supply one to 100 article ids');
  const ids=[...new Set(body.ids.map(id=>identity(id)))];
  const current=await env.DB.prepare(`SELECT ${COLS} FROM news WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all();
  const eligible=(current.results||[]).filter(row=>!isImpactNews(rowArticle(row))).map(row=>({id:row.id,hash:row.content_hash}));
  const result=await env.DB.prepare("UPDATE news SET metadata_json=json_set(metadata_json,'$.editorialExcluded',1,'$.exclusionReason','outside_editorial_scope','$.excludedAt',?) WHERE EXISTS (SELECT 1 FROM json_each(?) j WHERE news.id=json_extract(j.value,'$.id') AND news.content_hash=json_extract(j.value,'$.hash')) AND COALESCE(json_extract(metadata_json,'$.editorialExcluded'),0)=0").bind(new Date().toISOString(),JSON.stringify(eligible)).run();
  return json({ok:true,retracted:result.meta?.changes||0,note:'Records are retained in the private content backup and can be restored by reviewed re-import.'});
}
export async function authorized(request, env) {
  if (typeof env.INGEST_SECRET !== 'string' || env.INGEST_SECRET.length < 24) fail('Ingestion is not configured', 503);
  const bearer = request.headers.get('authorization') || '', supplied = bearer.startsWith('Bearer ') ? bearer.slice(7) : request.headers.get('x-ingest-secret') || '';
  // Hash both values to fixed-size buffers before comparison. Never log either value.
  const digest = async v => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
  const [expected, actual] = await Promise.all([digest(env.INGEST_SECRET), digest(supplied.length <= 4096 ? supplied : '')]);
  let difference = 0; for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
  if (difference !== 0) fail('Unauthorized', 401);
}
function feedState(value, now) {
  if (!object(value) || Object.keys(value).some(k => !['lastAttemptAt', 'lastSuccessAt', 'itemCount', 'error'].includes(k))) fail('Invalid feed state');
  const attempt = date(value.lastAttemptAt, 'feed attempt date', now);
  const success = value.lastSuccessAt == null ? null : date(value.lastSuccessAt, 'feed success date', now);
  if (attempt > now.toISOString() || (success && success > now.toISOString())) fail('Future feed state is not accepted');
  const error = value.error == null ? null : text(value.error, 'feed error', 160, true);
  if (success && error) fail('A failed attempt cannot record a new success');
  const count = value.itemCount == null ? 0 : value.itemCount;
  if (!Number.isInteger(count) || count < 0 || count > MAX_ARTICLES) fail('Invalid feed item count');
  return { attempt, success, error, count };
}
async function recordFeedState(env, id, state) {
  await env.DB.prepare(`INSERT INTO feed_state (id,last_attempt_at,last_success_at,error,item_count) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
    last_success_at=CASE WHEN excluded.last_success_at IS NOT NULL AND (feed_state.last_success_at IS NULL OR excluded.last_success_at>feed_state.last_success_at) THEN excluded.last_success_at ELSE feed_state.last_success_at END,
    error=excluded.error,item_count=CASE WHEN excluded.last_success_at IS NOT NULL THEN excluded.item_count ELSE feed_state.item_count END
    WHERE feed_state.last_attempt_at IS NULL OR feed_state.last_attempt_at<=excluded.last_attempt_at`).bind(id, state.attempt, state.success, state.error, state.count).run();
}
async function ingest(request, env) {
  await authorized(request, env);
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) fail('JSON content type is required', 415);
  let raw;
  try { raw = await readLimited(request, MAX_BODY); } catch { fail('Request exceeds size limit', 413); }
  let body; try { body = JSON.parse(raw); } catch { fail('Invalid JSON'); }
  if (!object(body) || Object.keys(body).some(k => !['articles', 'events', 'economy', 'feedId', 'mode', 'feedState', 'expectedEconomyHash'].includes(k)) || !['articles', 'events', 'economy'].some(k => k in body)) fail('Expected articles, events or economy metadata');
  const now = new Date(), feedId = identity(body.feedId || 'manual', 'feed id'), mode = body.mode || 'manual';
  if ('expectedEconomyHash' in body && (body.economy == null || body.articles != null || body.events != null || body.feedState != null || (body.expectedEconomyHash !== null && (typeof body.expectedEconomyHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(body.expectedEconomyHash))))) fail('Invalid expected economy version');
  const state = body.feedState == null ? null : feedState(body.feedState, now);
  if (!['automatic', 'manual', 'seed', 'curated'].includes(mode)) fail('Invalid import mode');
  // Validate the complete request before any subsystem writes rows.
  if (body.articles != null) {
    if (!Array.isArray(body.articles) || body.articles.length > MAX_ARTICLES) fail('At most 100 articles are accepted');
    await Promise.all(body.articles.map(a => article(a, env, now, mode)));
  }
  if (body.events != null) {
    if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS) fail('At most 25 events are accepted');
    body.events.forEach(e => eventPayload(e, env, now));
    try { validateTrackedEvents(body.events); } catch { fail('Invalid event tracking definition'); }
  }
  if (body.economy != null) economyPayload(body.economy, env, now);
  const result = {};
  if (body.articles != null) result.articles = await storeArticles(env, body.articles, feedId, mode, { now });
  if (body.events != null) result.events = await importEvents(env, body.events, { now });
  if (body.economy != null) result.economy = await importEconomy(env, body.economy, { now, expectedEconomyHash: body.expectedEconomyHash });
  if (state) { await recordFeedState(env, feedId, state); result.feedStateRecorded = true; }
  return json({ ok: true, storedAt: now.toISOString(), ...result });
}

/** Returns null for routes owned by authentication, billing, assets or other modules. */
export function publicTimeline(event) {
  const milestones = Array.isArray(event.milestones) ? event.milestones : [];
  if (milestones.length <= 10) return event;
  const preview = [...milestones].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 10);
  return { ...event, milestones: preview, previewTruncated: true, originalMilestoneCount: milestones.length, previewCutoff: preview.at(-1)?.date || null, previewLimit: 10 };
}

export async function handleContent(request, env, ctx, { canAccessArchive = false, canAccessFullTimelines = false } = {}) {
  const path = new URL(request.url).pathname;
  const handled = ['/api/news', '/api/facets', '/api/events', '/api/economy', '/api/pipeline/status', '/api/ingest','/api/admin/content-backup','/api/admin/retract'].includes(path) || path.startsWith('/api/events/') || path.startsWith('/api/news/');
  if (!handled) return null;
  try {
    const method = ['/api/ingest','/api/admin/retract'].includes(path) ? 'POST' : 'GET';
    if (request.method !== method) return json({ error: 'method_not_allowed' }, 405, { allow: method });
    if (path==='/api/admin/content-backup')return await contentBackup(request,env);
    if (path==='/api/admin/retract')return await retract(request,env);
    if (path === '/api/ingest') {
      // Authenticate even when a database binding is missing.
      if (!env.DB) { await authorized(request, env); fail('Database is not configured', 503); }
      return await ingest(request, env);
    }
    if (new URL(request.url).searchParams.get('archive') === '1' && !canAccessArchive) fail('Archive access is required', 403);
    if (!env.DB) fail('Database is not configured', 503);
    const coverage = await handleEventCoverage(request, env);
    if (coverage) return coverage;
    if (path === '/api/news') return await news(request, env, { canAccessArchive });
    if (path === '/api/news/top' && request.method === 'GET') return await topStories(request,env);
    if (path === '/api/news/impact') {
      if (new URL(request.url).search) fail('This endpoint does not accept parameters');
      return await impactCandidates(env);
    }
    if (path.startsWith('/api/news/')) return await singleArticle(request, env, { canAccessArchive }, decodeURIComponent(path.slice('/api/news/'.length)));
    if (path === '/api/facets') return await facets(request, env, { canAccessArchive });
    if (path === '/api/pipeline/status') return await pipeline(env);
    if (path === '/api/economy') {
      const row = await env.DB.prepare("SELECT payload_json,content_hash FROM content_documents WHERE id='economy'").first();
      return row ? json(JSON.parse(row.payload_json), 200, { etag: '"' + row.content_hash + '"' }) : json({ error: 'economy_not_imported' }, 404);
    }
    if (path === '/api/events') {
      const params=new URL(request.url).searchParams,limit=params.has('limit')?Number(params.get('limit')):20;
      if(!Number.isInteger(limit)||limit<1||limit>100)fail('Limit must be between 1 and 100');
      const q=text(params.get('q')||'','timeline search',160), kind=params.get('kind')||'';
      if (!['','editorial','record'].includes(kind)) fail('Invalid timeline kind');
      const scope=q||kind ? JSON.stringify(['events',q,kind]) : 'events';
      const filters=[],filterArgs=[];
      if (kind === 'record') filters.push("json_extract(payload_json,'$.recordType') IS NOT NULL");
      if (kind === 'editorial') filters.push("json_extract(payload_json,'$.recordType') IS NULL");
      if (q) {
        filters.push("(instr(lower(title),?)>0 OR instr(lower(json_extract(payload_json,'$.keywords')),?)>0)");
        filterArgs.push(q.toLowerCase(),q.toLowerCase());
      }
      const toWhere=clauses=>clauses.length?' WHERE '+clauses.join(' AND '):'';
      const countWhere=toWhere(filters),args=[...filterArgs];
      if(params.has('cursor')){const cursor=decodeCursor(params.get('cursor'));if(cursor.scope!==scope||date(cursor.at,'cursor date',new Date())!==cursor.at)fail('Invalid event cursor');identity(cursor.id);filters.push('(updated_at<? OR (updated_at=? AND id>?))');args.push(cursor.at,cursor.at,cursor.id);}
      const [result,count]=await Promise.all([env.DB.prepare(`SELECT id,title,category,region,coverage_end,updated_at,
        json_extract(payload_json,'$.shortTitle') AS short_title,
        json_extract(payload_json,'$.description') AS description,
        json_extract(payload_json,'$.keywords') AS keywords,
        json_extract(payload_json,'$.recordType') AS record_type,
        json_array_length(payload_json,'$.milestones') AS milestone_count
        FROM event_payloads${toWhere(filters)} ORDER BY updated_at DESC,id LIMIT ?`).bind(...args,limit+1).all(),env.DB.prepare('SELECT COUNT(*) AS total FROM event_payloads'+countWhere).bind(...filterArgs).first()]);
      const records=result.results||[],hasMore=records.length>limit,page=records.slice(0,limit),last=page.at(-1);
      return json({ events: page.map(r => ({ id: r.id, title: r.title, shortTitle: r.short_title || r.title,
        description: plainText(r.description, 500), keywords: parse(r.keywords, []), category: r.category, region: r.region,
        coverageEnd: r.coverage_end, updatedAt: r.updated_at, milestoneCount: r.milestone_count, ...(r.record_type?{recordType:r.record_type}:{}) })), meta: { total: count?.total||0, mode: 'database',hasMore,nextCursor:hasMore&&last?encodeCursor({v:1,scope,at:last.updated_at,id:last.id}):null } });
    }
    const id = identity(decodeURIComponent(path.slice('/api/events/'.length)), 'event id');
    const row = await env.DB.prepare('SELECT payload_json FROM event_payloads WHERE id=?').bind(id).first();
    if (!row) return json({ error: 'event_not_found' }, 404);
    const event = JSON.parse(row.payload_json);
    return json({ event: canAccessFullTimelines ? event : publicTimeline(event) });
  } catch (error) {
    if (error instanceof ContentError) return json({ error: error.message }, error.status);
    if (error instanceof URIError) return json({ error: 'Invalid event id' }, 400);
    return json({ error: 'content_store_unavailable' }, 503);
  }
}
