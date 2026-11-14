import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalUrl } from '../src/feed.js';

const HOUR = 3_600_000;
const FUTURE_TOLERANCE = 10 * 60_000;
const SAMPLE_LIMIT = 10;

function utcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const timestamp = Date.parse(value);
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === normalized ? timestamp : NaN;
}

function parsedSource(value) {
  try {
    const source = JSON.parse(value);
    return hasText(source?.publisher) && typeof source.url === 'string' ? source : null;
  } catch {
    return null;
  }
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addIssue(check, id) {
  check.count++;
  if (hasText(id) && check.sampleIds.length < SAMPLE_LIMIT && !check.sampleIds.includes(id)) check.sampleIds.push(id);
}

export function auditIngestion(db, { asOf = new Date().toISOString(), staleHours = 24 } = {}) {
  const now = utcTimestamp(asOf);
  if (!Number.isFinite(now)) throw new Error('Expected --as-of as an ISO 8601 UTC timestamp.');
  if (!Number.isFinite(staleHours) || staleHours <= 0) throw new Error('Expected --stale-hours as a positive number.');

  const checks = {
    malformedArticles: { count: 0, sampleIds: [] },
    noncanonicalUrls: { count: 0, sampleIds: [] },
    duplicateCanonicalUrlRows: { count: 0, sampleIds: [] },
    articlesWithoutMatchingLineage: { count: 0, sampleIds: [] },
    invalidLineageRows: { count: 0, sampleIds: [] },
    orphanRevisionRows: { count: 0, sampleIds: [] },
  };
  const seen = new Set();
  let articleCount = 0;

  for (const row of db.prepare(`
    SELECT n.id, n.title, n.canonical_url, n.source_json, n.published_at, n.ingested_at,
      EXISTS (SELECT 1 FROM article_source_lineage l
        WHERE l.news_id = n.id AND l.source_url = n.canonical_url) AS has_matching_lineage
    FROM news n ORDER BY n.id
  `).iterate()) {
    articleCount++;
    const url = canonicalUrl(row.canonical_url);
    const source = parsedSource(row.source_json);
    const published = utcTimestamp(row.published_at);
    const ingested = utcTimestamp(row.ingested_at);
    if (!hasText(row.id) || !hasText(row.title) || !url || !source || canonicalUrl(source.url) !== url ||
        !Number.isFinite(published) || !Number.isFinite(ingested) ||
        published > ingested + FUTURE_TOLERANCE || ingested > now + FUTURE_TOLERANCE) {
      addIssue(checks.malformedArticles, row.id);
    }
    if (url && url !== row.canonical_url) addIssue(checks.noncanonicalUrls, row.id);
    if (url && seen.has(url)) addIssue(checks.duplicateCanonicalUrlRows, row.id);
    if (url) seen.add(url);
    if (!row.has_matching_lineage) addIssue(checks.articlesWithoutMatchingLineage, row.id);
  }

  for (const row of db.prepare(`
    SELECT l.news_id, l.feed_id, l.source_url, l.source_json,
      l.first_seen_at, l.last_seen_at, n.canonical_url
    FROM article_source_lineage l LEFT JOIN news n ON n.id = l.news_id
    ORDER BY l.news_id, l.feed_id, l.source_url
  `).iterate()) {
    const firstSeen = utcTimestamp(row.first_seen_at);
    const lastSeen = utcTimestamp(row.last_seen_at);
    const source = parsedSource(row.source_json);
    if (!hasText(row.feed_id) || !row.canonical_url || row.source_url !== row.canonical_url ||
        !source || canonicalUrl(source.url) !== row.source_url ||
        !Number.isFinite(firstSeen) || !Number.isFinite(lastSeen) ||
        firstSeen > lastSeen || lastSeen > now + FUTURE_TOLERANCE) {
      addIssue(checks.invalidLineageRows, row.news_id);
    }
  }

  for (const row of db.prepare(`
    SELECT r.news_id FROM article_revisions r LEFT JOIN news n ON n.id = r.news_id
    WHERE n.id IS NULL ORDER BY r.news_id, r.id
  `).iterate()) {
    addIssue(checks.orphanRevisionRows, row.news_id);
  }

  const feeds = db.prepare(`
    SELECT id, last_attempt_at, last_success_at, error, item_count FROM feed_state ORDER BY id
  `).all().map(row => {
    const attempted = utcTimestamp(row.last_attempt_at);
    const succeeded = utcTimestamp(row.last_success_at);
    const ageHours = Number.isFinite(succeeded) && succeeded <= now ? (now - succeeded) / HOUR : null;
    let status;
    if ((row.last_attempt_at !== null && (!Number.isFinite(attempted) || attempted > now)) ||
        (row.last_success_at !== null && (ageHours === null || !Number.isFinite(attempted) || succeeded > attempted))) status = 'invalid_timestamp';
    else if (ageHours === null) status = 'never_succeeded';
    else if (ageHours >= staleHours) status = 'stale';
    else status = 'fresh';
    return {
      id: row.id,
      status,
      hoursSinceSuccess: ageHours === null ? null : Math.round(ageHours * 100) / 100,
      lastAttemptFailed: Boolean(row.error),
      lastSuccessfulItemCount: row.item_count,
    };
  });

  return {
    version: 1,
    asOf: new Date(now).toISOString(),
    staleHours,
    articleCount,
    checks,
    feeds,
  };
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'as-of': { type: 'string' }, 'stale-hours': { type: 'string', default: '24' } },
  });
  if (positionals.length !== 1) {
    throw new Error('Usage: node backend/scripts/audit-ingestion.mjs <local D1 SQLite file> [--as-of <UTC timestamp>] [--stale-hours <hours>]');
  }
  const db = new DatabaseSync(resolve(positionals[0]), { readOnly: true });
  try {
    db.exec('BEGIN');
    const report = auditIngestion(db, { asOf: values['as-of'], staleHours: Number(values['stale-hours']) });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
