import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import fs from 'node:fs/promises';
import { enrichArticle, auditArticles, needsEnrichment, policyForUrl, decodePublicGoogleLink } from '../src/enrichment.js';
import { readLimited } from '../src/feed.js';
import { collectorConfig, postIngest } from './collect-news.mjs';
import { fetchExistingNews } from './import-content.mjs';

export async function fetchArchive(origin = 'https://threadnews.online', { fetchImpl = fetch, maxPages = 40 } = {}) {
  const target = new URL(origin);
  if (target.protocol !== 'https:' || target.pathname !== '/' || target.username || target.password || target.search || target.hash) throw new Error('invalid_archive_origin');
  const articles = [], seen = new Set(), cursors = new Set(); let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL('/api/news', target);
    url.searchParams.set('archive', '1'); url.searchParams.set('limit', '100');
    url.searchParams.set('related', '0'); url.searchParams.set('count', '0');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('archive_http_' + response.status);
    const payload = JSON.parse(await readLimited(response, 2 * 1024 * 1024));
    if (!Array.isArray(payload.articles) || payload.articles.length > 100 || payload.meta?.mode !== 'database') throw new Error('invalid_archive_page');
    for (const article of payload.articles) {
      if (typeof article.id !== 'string' || seen.has(article.id)) throw new Error('duplicate_archive_record');
      seen.add(article.id); articles.push(article);
    }
    if (!payload.meta.hasMore) return articles;
    cursor = payload.meta.nextCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('invalid_archive_cursor');
    cursors.add(cursor);
  }
  throw new Error('archive_page_limit');
}

export function ingestArticle(article) {
  const names = ['id', 'title', 'originalHeadline', 'summary', 'category', 'region', 'keywords', 'publishedAt', 'source', 'officialSources', 'eventId', 'countries', 'evidenceNote', 'digestBasis', 'secondarySources'];
  return Object.fromEntries(names.filter(name => article[name] !== undefined).map(name => [name, article[name]]));
}

export async function enrichArchive({ env = process.env, articles, fetchImpl = fetch, now = new Date(), maxArticles = 25, concurrency = 3, resolveGoogle = false, publish = false } = {}) {
  if (!Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > 100) throw new Error('invalid_enrichment_limit');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('invalid_enrichment_concurrency');
  if (publish) collectorConfig({ ...env, APP_ORIGIN: env.APP_ORIGIN || 'https://threadnews.online' });
  const records = articles || await fetchArchive(env.APP_ORIGIN || 'https://threadnews.online', { fetchImpl });
  // Readable institutional items are processed first. Opaque Google discovery
  // URLs do not monopolise the budget; public-token decoding costs no request.
  const candidates = records.filter(needsEnrichment).filter(article => policyForUrl(article.source?.publisherArticleUrl || article.source?.url)
    || decodePublicGoogleLink(article.source?.url, article.source?.publisher) || resolveGoogle)
    .sort((a, b) => Number(!!policyForUrl(b.source?.publisherArticleUrl || b.source?.url)) - Number(!!policyForUrl(a.source?.publisherArticleUrl || a.source?.url)) || String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .slice(0, maxArticles);
  const robotsCache = new Map(), updates = [], attempts = [], byId = new Map(records.map(article => [article.id, article]));
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const article = candidates[cursor++];
      const result = await enrichArticle(article, { fetchImpl, now, robotsCache, resolveGoogle });
      attempts.push({ id: article.id, publisher: article.source.publisher, status: result.status, changed: result.changed });
      if (result.changed) { const update = ingestArticle(result.article); updates.push(update); byId.set(article.id, update); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  if (publish && updates.length) await postIngest({ articles: updates, feedId: 'source-enrichment', mode: 'automatic' }, { env: { ...env, APP_ORIGIN: env.APP_ORIGIN || 'https://threadnews.online' }, fetchImpl });
  const audit = auditArticles([...byId.values()], now);
  return { ...audit, published: publish, attempted: attempts.length, changed: updates.length, statusCounts: attempts.reduce((counts, attempt) => ({ ...counts, [attempt.status]: (counts[attempt.status] || 0) + 1 }), {}), attempts: attempts.sort((a, b) => a.id.localeCompare(b.id)), updates };
}

export async function main() {
  const args = process.argv.slice(2), limitArg = args.find(arg => arg.startsWith('--max='));
  const env = { ...process.env, APP_ORIGIN: process.env.APP_ORIGIN || 'https://threadnews.online' };
  const now = new Date();
  const records = args.includes('--admin') ? await fetchExistingNews(env.APP_ORIGIN, collectorConfig(env).secret) : undefined;
  const result = await enrichArchive({ env, articles: records, now, maxArticles: limitArg ? Number(limitArg.split('=')[1]) : 25,
    resolveGoogle: args.includes('--resolve-google'), publish: args.includes('--publish') });
  const report = { ...result }; delete report.updates;
  const reportUrl = new URL('../../research/content-enrichment-audit.json', import.meta.url);
  const updatesUrl = new URL('../../research/generated-source-excerpts.json', import.meta.url);
  await fs.writeFile(reportUrl, JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(updatesUrl, JSON.stringify({ generatedAt: now.toISOString(), note: 'Bounded institutional-source excerpts, not editorial source-reviewed digests. Publisher links remain attached.', articles: result.updates }, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, published: result.published, counts: result.counts, attempted: result.attempted, changed: result.changed, statusCounts: result.statusCounts }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { console.error(JSON.stringify({ ok: false, error: 'content_enrichment_failed' })); process.exitCode = 1; });
}
