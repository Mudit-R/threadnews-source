import { generateClaims } from './ai-provider.js';
import { contentConfig, storeSourceSummary } from './content.js';
import { ENRICHMENT_POLICIES, readOriginalArticle } from './enrichment.js';
import { sha256 } from './feed.js';

const HOUR = 3600000;
const LIMIT = 3;
const DAILY_LIMIT = 30;
const PUBLISHERS = [...new Set(ENRICHMENT_POLICIES.flatMap(policy => policy.publishers))];
const PROMPT = 'Write a short neutral news summary of this original publication in two sentences and at most 38 words total. State who reported or announced what. Include a concrete detail from the article body that is absent from the headline. Preserve qualifications and avoid predicting outcomes. Paraphrase the source without direct quotes. Do not infer unstated facts.';
const tokens = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const phrases = value => { const words = tokens(value); return words.slice(9).map((_, index) => words.slice(index, index + 10).join(' ')); };

export function shortSourceSummary(generated, article, paragraphs) {
  const pieces = generated?.claims?.map(claim => claim.text.trim()) || [];
  if (pieces.length < 1 || pieces.length > 2 || new Set(pieces).size !== pieces.length) return null;
  const summary = pieces.join(' ');
  if (tokens(summary).length < 14 || summary.split(/\s+/).length > 40 || /[<>\p{Cc}\p{Cf}]/u.test(summary)) return null;
  const headline = tokens(article.originalHeadline || article.title);
  const novel = new Set(tokens(paragraphs.join(' ')).filter(word => word.length >= 3 && !headline.includes(word)));
  // Require substantive overlap with the body beyond the title, and reject long verbatim runs.
  if (new Set(tokens(summary).filter(word => novel.has(word))).size < 3) return null;
  const originals = new Set(paragraphs.flatMap(phrases));
  if (phrases(summary).some(phrase => originals.has(phrase))) return null;
  return summary;
}

export async function refreshSourceSummaries(env, { now = new Date(), fetchImpl = fetch, generate = generateClaims } = {}) {
  const db = env.DB;
  if (env.SOURCE_SUMMARY_AI_ENABLED === 'false') return { ok: true, skipped: 'scheduled_ai_disabled' };
  if (!db || env.NEWS_STORAGE === 'static' || (!env.GEMINI_API_KEY && !env.AI)) return { ok: true, skipped: 'not_configured' };
  const at = now.toISOString(), day = at.slice(0, 10);
  const cutoff = new Date(+now - contentConfig(env).retentionDays * 24 * HOUR).toISOString();
  const budget = await db.prepare('SELECT used FROM source_summary_budget WHERE id=1 AND day=?').bind(day).first();
  if (budget?.used >= DAILY_LIMIT) return { ok: true, skipped: 'daily_limit' };
  const rows = await db.prepare(`SELECT n.id,n.title,n.original_headline,n.published_at,n.content_hash,n.source_json
    FROM news n LEFT JOIN source_summary_jobs j ON j.news_id=n.id
    WHERE n.published_at>=? AND n.publisher IN (SELECT value FROM json_each(?))
      AND COALESCE(json_extract(n.metadata_json,'$.editorialExcluded'),0)=0
      AND COALESCE(json_extract(n.metadata_json,'$.digestBasis'),'') IN ('','headline-only','headline_only','feed-description','source-extract')
      AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=?)
    ORDER BY (n.canonical_url LIKE 'https://news.google.com/%' AND json_extract(n.source_json,'$.publisherArticleUrl') IS NULL),
      n.published_at DESC,n.id DESC LIMIT ?`).bind(cutoff, JSON.stringify(PUBLISHERS), at, LIMIT).all();
  let attempted = 0, published = 0;
  const statuses = {}, robotsCache = new Map();
  for (const row of rows.results || []) {
    const lease = new Date(+now + HOUR / 4).toISOString();
    const locked = await db.prepare(`INSERT INTO source_summary_jobs(news_id,next_attempt_at,status) VALUES (?,?,'leased')
      ON CONFLICT(news_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,status='leased'
      WHERE source_summary_jobs.next_attempt_at<=? RETURNING news_id`).bind(row.id, lease, at).first();
    if (!locked) continue;
    attempted++;
    const article = { title: row.title, originalHeadline: row.original_headline, source: JSON.parse(row.source_json) };
    const page = await readOriginalArticle(article, { fetchImpl, robotsCache });
    let status = page.status;
    if (page.status === 'read') {
      const allowance = await db.prepare(`INSERT INTO source_summary_budget(id,day,used) VALUES (1,?,1)
        ON CONFLICT(id) DO UPDATE SET day=excluded.day,used=CASE WHEN source_summary_budget.day=excluded.day THEN source_summary_budget.used+1 ELSE 1 END
        WHERE source_summary_budget.day<>excluded.day OR source_summary_budget.used<? RETURNING used`).bind(day, DAILY_LIMIT).first();
      status = 'daily_limit';
      if (allowance) {
        const evidence = page.paragraphs.map((excerpt, index) => ({ id:index+1, title:article.title, excerpt,
          date:row.published_at.slice(0, 10), kind:'Original release paragraph', links:[{ publisher:article.source.publisher, url:page.url }] }));
        const result = await generate(env, PROMPT, evidence);
        const summary = shortSourceSummary(result, article, page.paragraphs);
        status = 'summary_unavailable';
        if (summary) {
          const saved = await storeSourceSummary(env, { row, summary, at, source: {
            ...article.source, basis:'article', publisherArticleUrl:page.url, summaryMethod:'original-source-paraphrase',
            contentHash:await sha256(page.paragraphs.join('\n')), contentRetrievedAt:at, reusePolicyUrl:page.policy.terms,
            ...(page.policy.freeAccessDisclosure ? { freeAccessDisclosure:page.policy.freeAccessDisclosure } : {})
          } });
          status = saved ? 'published' : 'record_changed';
          if (saved) published++;
        }
      }
    }
    const retryHours = ['daily_limit', 'record_changed', 'source_unavailable'].includes(status) ? 1
      : ['summary_unavailable', 'robots_unavailable', 'source_http_429', 'source_http_503'].includes(status) ? 12 : 24 * 7;
    await db.prepare('UPDATE source_summary_jobs SET status=?,next_attempt_at=? WHERE news_id=? AND next_attempt_at=?')
      .bind(status, new Date(+now + retryHours * HOUR).toISOString(), row.id, lease).run();
    statuses[status] = (statuses[status] || 0) + 1;
  }
  return { ok: true, attempted, published, statuses };
}
