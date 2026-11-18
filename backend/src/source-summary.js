import { generateClaims } from './ai-provider.js';
import { contentConfig, storeSourceSummary } from './content.js';
import { ENRICHMENT_POLICIES, readOriginalArticle } from './enrichment.js';
import { sha256 } from './feed.js';

const HOUR = 3600000;
const LIMIT = 3;
const DAILY_LIMIT = 30;
const PUBLISHERS = [...new Set(ENRICHMENT_POLICIES.flatMap(policy => policy.publishers))];
const PROMPT = 'Write a neutral 50–100 word news brief from the body of this original publication. Use two or three readable sentences. Start with a concrete finding, decision or detail from the body. Add at least two important details beyond the headline. Attribute claims, preserve uncertainty and supply the paragraph IDs supporting each sentence. Paraphrase the body. Use no outside facts or quotations.';
const FILLER = new Set('about according after also before because being could from have into more other reports said says than that their them then there these they this those through when where which will with would'.split(' '));
const tokens = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const phrases = value => { const words = tokens(value); return words.slice(9).map((_, index) => words.slice(index, index + 10).join(' ')); };

export function shortSourceSummary(generated, article, paragraphs) {
  const claims = generated?.claims || [];
  if (!Array.isArray(claims) || claims.length < 2 || claims.length > 3) return null;
  const pieces = claims.map(claim => claim.text.trim());
  if (new Set(pieces).size !== pieces.length) return null;
  const summary = pieces.join(' ');
  const words = summary.split(/\s+/).length;
  if (words < 50 || words > 100 || summary.length > 1000 || /[<>\p{Cc}\p{Cf}]/u.test(summary)) return null;
  const headline = new Set(tokens([article.originalHeadline, article.title].filter(Boolean).join(' ')));
  const novel = new Set();
  for (const claim of claims) {
    if (!claim.citations?.length || claim.citations.some(id => !Number.isInteger(id) || id < 1 || id > paragraphs.length)) return null;
    const cited = new Set(tokens(claim.citations.map(id => paragraphs[id - 1]).join(' ')));
    const details = new Set(tokens(claim.text).filter(word => word.length >= 4 && !FILLER.has(word) && !headline.has(word) && cited.has(word)));
    if (details.size < 2) return null;
    for (const word of details) novel.add(word);
  }
  if (novel.size < 5) return null;
  const originals = new Set(paragraphs.flatMap(phrases));
  if (phrases(summary).some(phrase => originals.has(phrase))) return null;
  return summary;
}

const sentenceParts = new Intl.Segmenter('en', { granularity:'sentence' });

export function originalSourceExcerpt(article, paragraphs, policy) {
  if (!['public-domain-text','open-government-licence'].includes(policy.reuse)) return null;
  const headline = new Set(tokens([article.originalHeadline, article.title].filter(Boolean).join(' ')));
  const sentences = paragraphs.flatMap(paragraph => [...sentenceParts.segment(paragraph)].map(part => part.segment.trim()))
    .filter(sentence => /[.!?][”"')]*$/.test(sentence));
  for (let start=0; start<Math.min(5,sentences.length); start++) {
    if (/^(?:it|this|these|those|they|he|she|such)\b/i.test(sentences[start])) continue;
    for (let length=2; length<=4&&start+length<=sentences.length; length++) {
      const summary=sentences.slice(start,start+length).join(' ');
      const count=summary.split(/\s+/).length;
      if (count>100||summary.length>1000) break;
      if (count<50) continue;
      const details=new Set(tokens(summary).filter(word=>word.length>=4&&!headline.has(word)&&!FILLER.has(word)));
      if(details.size>=5)return summary;
    }
  }
  return null;
}

export async function refreshSourceSummaries(env, { now = new Date(), fetchImpl = fetch, generate = generateClaims } = {}) {
  const db = env.DB;
  if (env.SOURCE_SUMMARY_AI_ENABLED === 'false') return { ok: true, skipped: 'scheduled_ai_disabled' };
  if (!db || env.NEWS_STORAGE === 'static' || !env.AI) return { ok: true, skipped: 'not_configured' };
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
        const result = await generate({ AI: env.AI }, PROMPT, evidence);
        const paraphrase = shortSourceSummary(result, article, page.paragraphs);
        const summary = paraphrase || originalSourceExcerpt(article, page.paragraphs, page.policy);
        status = 'summary_unavailable';
        if (summary) {
          const saved = await storeSourceSummary(env, { row, summary, at, source: {
            ...article.source, basis:'article', publisherArticleUrl:page.url,
            summaryMethod:paraphrase?'original-source-paraphrase':'original-source-excerpt',
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
