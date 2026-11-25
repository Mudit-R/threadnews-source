import { canonicalUrl } from './feed.js';
import { COVERAGE_HOURS, HOUR, coverageFeatures, coverageHeadline } from './coverage-features.js';
import model from './coverage-model.json' with { type: 'json' };

const SIDE_LIMIT = 80;
const RESULT_LIMIT = 6;

function publisherKey(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function sourceUrl(source) {
  const links = [source.publisherArticleUrl, source.articleUrl, source.url]
    .map(canonicalUrl).filter(url => url?.startsWith('https://'));
  return links.find(url => new URL(url).hostname !== 'news.google.com') || links[0];
}

function parseSource(value) {
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

export function rankCoverage(anchor, rows) {
  const origin = coverageHeadline(anchor.title);
  const published = Date.parse(anchor.publishedAt);
  const anchorPublisher = publisherKey(anchor.source?.publisher || '');
  if (origin.terms.size < 2 || !Number.isFinite(published) || !anchorPublisher) return [];
  const anchorUrl = sourceUrl(anchor.source);
  const ranked = [];
  for (const row of rows) {
    if (row.id === anchor.id) continue;
    const source = parseSource(row.source_json);
    const publisher = String(row.publisher || source.publisher || '').trim();
    const key = publisherKey(publisher);
    const hours = Math.abs(published - Date.parse(row.published_at)) / HOUR;
    if (!key || key === anchorPublisher || !Number.isFinite(hours) || hours > COVERAGE_HOURS) continue;
    const match = coverageFeatures(origin, coverageHeadline(row.title), hours);
    if (!match) continue;
    let logit = model.bias;
    for (const [feature, weight] of Object.entries(model.weights)) logit += match.features[feature] * weight;
    const score = 1 / (1 + Math.exp(-logit));
    if (score < model.threshold) continue;
    const url = sourceUrl(source);
    if (!url || url === anchorUrl) continue;
    ranked.push({ score, hours, key, match, row, publisher, source, url });
  }
  ranked.sort((a, b) => b.score - a.score || a.hours - b.hours || a.row.id.localeCompare(b.row.id));

  const publishers = new Set();
  const urls = new Set();
  const matches = [];
  for (const { key, match, row, publisher, source, url } of ranked) {
    if (publishers.has(key) || urls.has(url)) continue;
    publishers.add(key);
    urls.add(url);
    matches.push({
      id: row.id, title: row.title, publisher, url,
      viaGoogleNews: new URL(url).hostname === 'news.google.com',
      publishedAt: row.published_at, dateBasis: source.dateBasis || 'published',
      official: row.source_type === 'Official source',
      similarWording: match.similarWording,
      matchedTerms: match.terms.slice(0, 6)
    });
    if (matches.length === RESULT_LIMIT) break;
  }
  return matches;
}

export async function compareCoverage(db, anchor, visibility) {
  const at = Date.parse(anchor.publishedAt);
  const payload = { articleId: anchor.id, windowHours: COVERAGE_HOURS, matches: [] };
  if (!Number.isFinite(at)) return payload;
  const windowMs = COVERAGE_HOURS * HOUR;
  const from = new Date(at - windowMs).toISOString();
  const through = new Date(at + windowMs).toISOString();
  if (through < visibility.cutoff || from > visibility.until) return payload;
  const cols = 'id,title,published_at,publisher,source_json,source_type,metadata_json,category';
  // Two index seeks cap the candidate scan before publication and policy filters.
  // Windows may be truncated during a busy news cycle.
  const { results } = await db.prepare(`WITH
    earlier AS (SELECT ${cols} FROM news INDEXED BY news_page
      WHERE published_at>=? AND published_at<=? ORDER BY published_at DESC,id DESC LIMIT ${SIDE_LIMIT}),
    later AS (SELECT ${cols} FROM news INDEXED BY news_page
      WHERE published_at>? AND published_at<=? ORDER BY published_at,id LIMIT ${SIDE_LIMIT}),
    candidates AS (SELECT * FROM earlier UNION ALL SELECT * FROM later)
    SELECT id,title,published_at,publisher,source_json,source_type FROM candidates${visibility.baseWhere} AND id<>?`
  ).bind(
    from > visibility.cutoff ? from : visibility.cutoff, anchor.publishedAt,
    anchor.publishedAt, through < visibility.until ? through : visibility.until,
    ...visibility.baseArgs, anchor.id
  ).all();
  return { ...payload, matches: rankCoverage(anchor, results || []) };
}
