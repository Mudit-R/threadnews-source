import { canonicalUrl, plainText, readLimited, sha256 } from './feed.js';

// Fetch/reuse policy is explicit. Adding a publisher is an editorial/rights
// decision, not something a caller-supplied article URL can enable.
export const ENRICHMENT_POLICIES = Object.freeze([
  { id: 'federal-reserve', hosts: ['www.federalreserve.gov', 'federalreserve.gov'],
    publishers: ['Federal Reserve'],
    paths: /^\/newsevents\/pressreleases\//, reuse: 'public-domain-text',
    terms: 'https://www.federalreserve.gov/disclaimer.htm' },
  { id: 'ecb-institutional', hosts: ['www.ecb.europa.eu', 'ecb.europa.eu'],
    publishers: ['European Central Bank'],
    paths: /^\/press\/(?:pr|govcdec\/otherdec)\//, reuse: 'attributed-institutional-text',
    terms: 'https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html',
    freeAccessDisclosure: 'The underlying ECB information is available free of charge on the ECB website.' },
  { id: 'bls-release', hosts: ['www.bls.gov'], publishers: ['U.S. Bureau of Labor Statistics', 'Bureau of Labor Statistics'],
    paths: /^\/news\.release\/archives\/(?:cpi|ppi|empsit)_\d{8}\.htm$/,
    reuse: 'public-domain-text', terms: 'https://www.bls.gov/opub/copyright-information.htm' },
  { id: 'uk-release', hosts: ['www.gov.uk'], publishers: ['UK Department for Energy Security and Net Zero'],
    paths: /^\/government\/news\/[a-z0-9-]+$/, reuse: 'open-government-licence',
    terms: 'https://www.gov.uk/help/terms-conditions',
    freeAccessDisclosure: 'Contains public sector information licensed under the Open Government Licence v3.0.' },
  { id: 'eurostat-release', hosts: ['ec.europa.eu'], publishers: ['Eurostat'],
    paths: /^\/eurostat\/web\/products-euro-indicators\/w\/[0-9a-z-]+$/i, reuse: 'attributed-institutional-text',
    terms: 'https://ec.europa.eu/eurostat/help/copyright-notice' }
]);
const PUBLISHER_HOSTS = Object.freeze({
  'bbc': ['bbc.com', 'bbc.co.uk'], 'bbc news': ['bbc.com', 'bbc.co.uk'],
  'reuters': ['reuters.com'], 'ap news': ['apnews.com'], 'associated press': ['apnews.com'],
  'cnn': ['cnn.com'], 'bloomberg': ['bloomberg.com'], 'bloomberg.com': ['bloomberg.com'],
  'the guardian': ['theguardian.com'], 'the washington post': ['washingtonpost.com'],
  'the new york times': ['nytimes.com'], 'wsj': ['wsj.com'], 'cnbc': ['cnbc.com'],
  'nhk world-japan': ['nhk.or.jp'], 'cna': ['channelnewsasia.com'],
  'dw': ['dw.com'], 'al jazeera': ['aljazeera.com'], 'financial times': ['ft.com'],
  'un news': ['news.un.org'], 'un news - global perspective human stories': ['news.un.org'],
  'european central bank': ['ecb.europa.eu'], 'federal reserve': ['federalreserve.gov'],
  'u.s. bureau of labor statistics': ['bls.gov'], 'bureau of labor statistics': ['bls.gov'],
  'uk department for energy security and net zero': ['gov.uk'], 'eurostat': ['ec.europa.eu']
});
const HEADLINE_BASES = new Set(['headline-only', 'headline_only', '']);
const USER_AGENT = 'ThreadNewsMetaBot/1.0 (+https://threadnews.online/sources)';
class EnrichmentError extends Error { constructor(code) { super(code); this.code = code; } }
const hostnameMatches = (host, domain) => host === domain || host.endsWith('.' + domain);
function publicUrl(value) {
  const canonical = canonicalUrl(value);
  if (!canonical) return null;
  const url = new URL(canonical), host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)
      || /\.(?:localhost|local|internal|test|invalid|example)$/.test(host)) return null;
  return url;
}
function decoded(value) {
  return String(value || '').replace(/&(?:amp|nbsp|quot|apos|lt|gt|#39|#x27);/gi, item => ({ '&amp;':'&','&nbsp;':' ','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&#39;':"'",'&#x27;':"'" }[item.toLowerCase()] || item))
    .replace(/&#(\d{1,6});/g, (_, code) => Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : '');
}
function attributes(tag) {
  const result = {};
  for (const item of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[item[1].toLowerCase()] = decoded(item[2] ?? item[3]);
  return result;
}
export function policyForUrl(value) {
  const url = publicUrl(value);
  if (!url) return null;
  const path = url.pathname.replace(/\/{2,}/g, '/');
  return ENRICHMENT_POLICIES.find(policy => policy.hosts.includes(url.hostname) && policy.paths.test(path)) || null;
}
export function publisherUrlAllowed(value, publisher) {
  const url = publicUrl(value), domains = PUBLISHER_HOSTS[String(publisher || '').trim().toLowerCase()] || [];
  return !!url && domains.some(domain => hostnameMatches(url.hostname, domain));
}

/** Older public Google link tokens sometimes contain the publisher URL itself.
 * Modern opaque tokens are left unresolved. No private RPC or circumvention. */
export function decodePublicGoogleLink(value, publisher) {
  const url = publicUrl(value);
  if (url?.hostname !== 'news.google.com') return null;
  const token = url.pathname.match(/^\/(?:rss\/)?articles\/([A-Za-z0-9_-]{10,2000})$/)?.[1];
  if (!token) return null;
  let payload;
  try { payload = atob(token.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
  for (const candidate of payload.match(/https?:\/\/[^\s\x00-\x20\x7f-\xff"'<>\\]+/g) || []) {
    if (publisherUrlAllowed(candidate, publisher)) return publicUrl(candidate).href;
  }
  return null;
}

/** Applicable robots groups, with longest-path Allow/Disallow precedence. */
export function robotsAllowed(text, pathname, agent = 'threadnewsmetabot') {
  const groups = []; let group = { agents: [], rules: [] }, sawRule = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(), match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2].trim();
    if (key === 'user-agent') {
      if (sawRule) { groups.push(group); group = { agents: [], rules: [] }; sawRule = false; }
      group.agents.push(value.toLowerCase());
    } else if (['allow', 'disallow'].includes(key) && group.agents.length) { sawRule = true; if (value) group.rules.push({ allow: key === 'allow', value }); }
  }
  groups.push(group);
  const specific = groups.filter(item => item.agents.some(value => value !== '*' && agent.includes(value)));
  const active = specific.length ? specific : groups.filter(item => item.agents.includes('*'));
  const matching = [];
  for (const rule of active.flatMap(item => item.rules)) {
    const expression = rule.value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\$$/, '$');
    try { if (new RegExp('^' + expression).test(pathname)) matching.push({ ...rule, length: rule.value.replace(/[\*$]/g, '').length }); } catch {}
  }
  matching.sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
  return !matching.length || matching[0].allow;
}

async function requestPublic(value, { fetchImpl, allowed, beforeFetch, maxBytes = 768 * 1024, maxRedirects = 4, accept = 'text/html, application/xhtml+xml' }) {
  let url = publicUrl(value);
  if (!url || !allowed(url)) throw new EnrichmentError('source_not_allowed');
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (beforeFetch) await beforeFetch(url);
    let response;
    try { response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { accept, 'user-agent': USER_AGENT } }); }
    catch { throw new EnrichmentError('source_unavailable'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      const next = location ? publicUrl(new URL(location, url).href) : null;
      await response.body?.cancel().catch(() => {});
      if (!next || !allowed(next)) throw new EnrichmentError('source_redirect_not_allowed');
      url = next; continue;
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new EnrichmentError('source_http_' + response.status); }
    const contentType = response.headers.get('content-type') || '';
    if (accept.startsWith('text/html') && !/text\/html|application\/xhtml\+xml/i.test(contentType)) { await response.body?.cancel().catch(() => {}); throw new EnrichmentError('unsupported_source_document'); }
    if (/\b(?:noai|noindex|nosnippet)\b/i.test(response.headers.get('x-robots-tag') || '')) { await response.body?.cancel().catch(() => {}); throw new EnrichmentError('robots_disallowed'); }
    let body;
    try { body = await readLimited(response, maxBytes); } catch { throw new EnrichmentError('source_document_too_large'); }
    return { url: url.href, body };
  }
  throw new EnrichmentError('source_redirect_limit');
}

async function robotsCheck(url, { fetchImpl, robotsCache }) {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    let response;
    try { response = await fetchImpl(new URL('/robots.txt', origin), { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { accept: 'text/plain', 'user-agent': USER_AGENT } }); }
    catch { throw new EnrichmentError('robots_unavailable'); }
    if (response.status === 404 || response.status === 410) robotsCache.set(origin, '');
    else if (response.status === 200) {
      try { robotsCache.set(origin, await readLimited(response, 128 * 1024)); } catch { throw new EnrichmentError('robots_invalid'); }
    } else { await response.body?.cancel().catch(() => {}); throw new EnrichmentError('robots_unavailable'); }
  }
  return robotsAllowed(robotsCache.get(origin), new URL(url).pathname + new URL(url).search);
}

export function sourceParagraphs(html, policyId) {
  if (/"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(html) || /<(?:div|section)[^>]+(?:class|id)=["'][^"']*(?:paywall|subscription-wall)/i.test(html) || /<meta\b[^>]+\b(?:noai|noindex|nosnippet)\b[^>]*>/i.test(html)) return [];
  const stripped = html.replace(/<!--[\s\S]*?-->|<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ');
  if (policyId === 'bls-release') {
    const release = stripped.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i)?.[1] || '';
    return release.split(/\r?\n[ \t]*\r?\n/).slice(0, 12).map(part => plainText(decoded(part), 900))
      .filter(part => part.length >= 100 && !/^(?:transmission of material|technical information|median|table [a-z0-9])/i.test(part));
  }
  let body = stripped.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || stripped.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  // The Federal Reserve uses a div#article rather than an HTML article/main.
  // Balance nested divs so navigation/footer paragraphs cannot enter the body.
  if (!body || ['uk-release','eurostat-release'].includes(policyId)) {
    const boundary = policyId === 'uk-release' ? /<div\b[^>]*\bclass=["']govspeak["'][^>]*>/i
      : policyId === 'eurostat-release' ? /<div\b[^>]*\bclass=["'][^"']*\bcomponent-euind-content\b[^"']*["'][^>]*>/i
        : /<div\b[^>]*\bid=["']article["'][^>]*>/i;
    const start = boundary.exec(stripped);
    if (['uk-release','eurostat-release'].includes(policyId)) body = null;
    if (start) {
      const tags = /<\/?div\b[^>]*>/gi; tags.lastIndex = start.index + start[0].length;
      let depth = 1, match;
      while ((match = tags.exec(stripped))) {
        depth += /^<\//.test(match[0]) ? -1 : 1;
        if (!depth) { body = stripped.slice(start.index + start[0].length, match.index); break; }
      }
    }
  }
  if (!body) return [];
  const clean = body.replace(/<(?:script|style|nav|aside|header|footer|form)\b[^>]*>[\s\S]*?<\/(?:script|style|nav|aside|header|footer|form)>/gi, ' ');
  return [...clean.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(match => plainText(decoded(match[1]), 6000)
    .replace(/^For release at .*?\b(?:EDT|EST|ET)\s+Share\s*/i, ''))
    .filter(value => value.length >= 80 && !/^(?:copyright|all rights reserved|for media queries|our website uses cookies|please enable javascript|share this|related topics|download the|last update|for immediate release|reproduction is permitted|this website)/i.test(value));
}

/** Returns bounded original text for a reviewed source policy. Never stores the text. */
export async function readOriginalArticle(article, { fetchImpl = fetch, robotsCache = new Map() } = {}) {
  const original = publicUrl(article.source?.url);
  const direct = publicUrl(article.source?.publisherArticleUrl || article.source?.articleUrl)
    || publicUrl(decodePublicGoogleLink(original?.href, article.source?.publisher)) || original;
  const policy = policyForUrl(direct?.href);
  if (!policy || !policy.publishers.includes(article.source?.publisher)) return { status: 'no_approved_original' };
  try {
    const page = await requestPublic(direct.href, {
      fetchImpl, maxRedirects: 2, maxBytes: policy.id === 'bls-release' ? 2 * 1024 * 1024 : undefined,
      allowed: url => policyForUrl(url.href)?.id === policy.id,
      beforeFetch: async url => {
        if (!await robotsCheck(url.href, { fetchImpl, robotsCache })) throw new EnrichmentError('robots_disallowed');
      }
    });
    const paragraphs = [...new Set(sourceParagraphs(page.body, policy.id))].slice(0, 7).map(p => p.slice(0, 700));
    if (paragraphs.length < 2 || paragraphs.join(' ').split(/\s+/).length < 65) return { status: 'source_text_unavailable' };
    return { status: 'read', url: page.url, policy, paragraphs };
  } catch (error) { return { status: error.code || 'source_unavailable' }; }
}
export function briefFromParagraphs(paragraphs) {
  const first = paragraphs.find(value => value.split(/\s+/).length >= 12);
  if (!first) return null;
  const sentence = (first.match(/^.*?[.!?](?=\s+[A-Z“"]|$)/)?.[0] || '').trim();
  const length = sentence ? sentence.split(/\s+/).length : 0;
  // A later sentence can depend on context omitted from an excerpt. If the
  // actual lead will not fit intact, leave it for editorial review instead.
  return length >= 12 && length <= 25 ? sentence : null;
}

export function needsEnrichment(article) {
  const basis = article.digestBasis || article.metadata?.digestBasis || '';
  if (['article-reviewed', 'source-summary', 'source-extract'].includes(basis)) return false;
  return HEADLINE_BASES.has(basis) || article.source?.basis === 'headline';
}

/** No credential is accepted by this function, so collector credentials cannot
 * accidentally reach a publisher. The result is a bounded attributed excerpt,
 * never an AI-generated claim or a claim of human article review. */
export async function enrichArticle(article, { fetchImpl = fetch, now = new Date(), robotsCache = new Map(), resolveGoogle = false } = {}) {
  const original = publicUrl(article.source?.url);
  if (!original) return { status: 'invalid_source_url', changed: false };
  if (!needsEnrichment(article)) return { status: 'already_has_evidence', changed: false };
  let direct = publicUrl(article.source?.publisherArticleUrl)?.href || null, resolution = null;
  if (original.hostname === 'news.google.com' && !direct) {
    direct = decodePublicGoogleLink(original.href, article.source.publisher);
    if (direct) resolution = 'public-link-token';
    else if (resolveGoogle) {
      try {
        if (!await robotsCheck(original.href, { fetchImpl, robotsCache })) return { status: 'robots_disallowed', changed: false };
        const result = await requestPublic(original.href, { fetchImpl, allowed: url => url.hostname === 'news.google.com' || publisherUrlAllowed(url.href, article.source.publisher) });
        if (new URL(result.url).hostname !== 'news.google.com') { direct = result.url; resolution = 'public-http-redirect'; }
        else {
          const candidates = [...result.body.matchAll(/<(?:a|link)\b[^>]*>/gi)].map(match => attributes(match[0]).href).filter(Boolean);
          const matches = [...new Set(candidates.filter(value => publisherUrlAllowed(value, article.source.publisher)))];
          if (matches.length === 1) { direct = publicUrl(matches[0]).href; resolution = 'public-page-link'; }
        }
      } catch (error) { return { status: error.code || 'source_unavailable', changed: false }; }
    }
    if (!direct) return { status: 'publisher_link_unresolved', changed: false };
  }
  direct ||= original.href;
  const normalizedDirect = new URL(direct);
  normalizedDirect.pathname = normalizedDirect.pathname.replace(/\/{2,}/g, '/');
  direct = normalizedDirect.href;
  const source = { ...article.source, publisherArticleUrl: direct,
    ...(resolution ? { publisherUrlResolution: resolution, publisherUrlResolvedAt: now.toISOString() } : {}) };
  const policy = policyForUrl(direct);
  if (!policy) return resolution ? { status: 'publisher_link_resolved', changed: true, article: { ...article, source } } : { status: 'summary_reuse_not_enabled', changed: false };
  if (/\.pdf(?:$|[?#])/i.test(direct)) return { status: 'unsupported_source_document', changed: false };
  try {
    if (!await robotsCheck(direct, { fetchImpl, robotsCache })) return { status: 'robots_disallowed', changed: false };
    if (!['federal-reserve', 'ecb-institutional'].includes(policy.id)) return { status: 'summary_reuse_not_enabled', changed: false };
    const page = await requestPublic(direct, { fetchImpl, allowed: url => policyForUrl(url.href)?.id === policy.id });
    const paragraphs = sourceParagraphs(page.body), brief = briefFromParagraphs(paragraphs);
    if (!brief) return { status: 'source_text_unavailable', changed: false };
    const contentHash = await sha256(paragraphs.join('\n'));
    return { status: 'source_excerpt_created', changed: true, article: { ...article, summary: brief, digestBasis: 'source-extract',
      evidenceNote: 'A short excerpt from the linked institutional source. It is not independent corroboration or a full article summary.',
      source: { ...source, publisherArticleUrl: page.url, basis: 'article', summaryMethod: 'bounded-source-excerpt', contentHash,
        contentRetrievedAt: now.toISOString(), reusePolicyUrl: policy.terms, reusePolicyCheckedAt: '2026-11-04',
        ...(policy.freeAccessDisclosure ? { freeAccessDisclosure: policy.freeAccessDisclosure } : {}) } } };
  } catch (error) { return { status: error.code || 'source_unavailable', changed: false }; }
}

export function auditArticles(articles, at = new Date()) {
  const counts = { total: articles.length, reviewedDigests: 0, sourceSummaries: 0, sourceExcerpts: 0, headlineOnly: 0, googleLinks: 0, directPublisherLinks: 0, enrichmentEligible: 0 };
  for (const article of articles) {
    if (article.digestBasis === 'article-reviewed') counts.reviewedDigests++;
    else if (article.digestBasis === 'source-summary') counts.sourceSummaries++;
    else if (article.digestBasis === 'source-extract') counts.sourceExcerpts++;
    else if (needsEnrichment(article)) counts.headlineOnly++;
    const url = publicUrl(article.source?.publisherArticleUrl || article.source?.url);
    if (url?.hostname === 'news.google.com') counts.googleLinks++; else if (url) counts.directPublisherLinks++;
    if (needsEnrichment(article) && policyForUrl(url?.href)) counts.enrichmentEligible++;
  }
  return { checkedAt: at.toISOString(), counts, note: 'Counts distinguish editorial source-reviewed digests, bounded institutional excerpts and unresolved headline-only records. An excerpt is not a reviewed digest.' };
}
