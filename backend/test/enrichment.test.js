import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichArticle, sourceParagraphs, briefFromParagraphs, robotsAllowed, decodePublicGoogleLink, policyForUrl, auditArticles, readOriginalArticle } from '../src/enrichment.js';
import { shortSourceSummary } from '../src/source-summary.js';
import { fetchArchive, enrichArchive } from '../scripts/enrich-content.mjs';

const now = new Date('2026-11-04T12:00:00Z');
const article = { id: 'fed-source', title: 'Federal Reserve issues FOMC statement', originalHeadline: 'Federal Reserve issues FOMC statement', summary: '',
  category: 'Economy', region: 'North America', keywords: [], publishedAt: '2026-10-28T18:00:00Z', digestBasis: 'headline-only',
  source: { publisher: 'Federal Reserve', sourceType: 'Official source', basis: 'headline', url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm' }, officialSources: [], eventId: null };
const html = '<html><body><nav><p>Navigation must never become a factual source excerpt despite having more than eighty characters of text.</p></nav><main><p>The Committee decided to lower the target range for the federal funds rate by one quarter percentage point at this meeting.</p><p>The members stated that future adjustments would depend on incoming information, the evolving outlook and the balance of risks.</p></main></body></html>';
function sourceFetcher({ robots = '', document = html, redirect = null } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, undefined, 'publisher requests must never carry administrator credentials');
    if (url.pathname === '/robots.txt') return new Response(robots, { headers: { 'content-type': 'text/plain' } });
    if (redirect) return new Response('', { status: 302, headers: { location: redirect } });
    return new Response(document, { headers: { 'content-type': 'text/html' } });
  } };
}
test('source extraction reads article paragraphs and publishes at most 25 quoted words with explicit method and source hash', async () => {
  const fixture = sourceFetcher();
  const result = await enrichArticle(article, { ...fixture, now });
  assert.equal(result.status, 'source_excerpt_created');
  assert.equal(result.article.digestBasis, 'source-extract');
  assert.ok(result.article.summary.split(/\s+/).length <= 25);
  assert.match(result.article.summary, /^The Committee decided/);
  assert.equal(result.article.source.summaryMethod, 'bounded-source-excerpt');
  assert.match(result.article.source.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(result.article.source.url, article.source.url);
  assert.equal(fixture.calls.length, 2);
});
test('robot exclusions and unknown access conditions fail closed without fetching article text', async () => {
  const fixture = sourceFetcher({ robots: 'User-agent: *\nDisallow: /newsevents/' });
  const result = await enrichArticle(article, { ...fixture, now });
  assert.equal(result.status, 'robots_disallowed');
  assert.equal(fixture.calls.length, 1);
  const failed = await enrichArticle(article, { now, fetchImpl: async () => new Response('', { status: 503 }) });
  assert.equal(failed.status, 'robots_unavailable');
});
test('enrichment rejects private redirects and paywalled/unsupported documents', async () => {
  const redirected = await enrichArticle(article, { ...sourceFetcher({ redirect: 'https://127.0.0.1/admin' }), now });
  assert.equal(redirected.status, 'source_redirect_not_allowed');
  assert.deepEqual(sourceParagraphs('<main><p>A full body should not be extracted when the publisher says that it is not publicly accessible.</p></main><script type="application/ld+json">{"isAccessibleForFree":false}</script>'), []);
  const nonHtml = await enrichArticle(article, { now, fetchImpl: async input => new URL(input).pathname === '/robots.txt' ? new Response('') : new Response('PDF', { headers: { 'content-type': 'application/pdf' } }) });
  assert.equal(nonHtml.status, 'unsupported_source_document');
});
test('robot matching honours specific agents, longest paths and allow ties', () => {
  assert.equal(robotsAllowed('User-agent: *\nDisallow: /press\nAllow: /press/pr/', '/press/pr/release'), true);
  assert.equal(robotsAllowed('User-agent: *\nDisallow: /\nUser-agent: ThreadNewsMetaBot\nAllow: /', '/press'), true);
  assert.equal(robotsAllowed('User-agent: *\nDisallow: /a\nAllow: /a', '/a'), true);
  assert.equal(robotsAllowed('User-agent: *\nDisallow: /*.pdf$', '/paper.pdf'), false);
});
test('only ordinary publisher-matching public Google tokens can become direct links', () => {
  const direct = 'https://www.bbc.com/news/articles/abc123';
  const token = btoa('\x08\x01' + direct + '\xd2\x01').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(decodePublicGoogleLink('https://news.google.com/rss/articles/' + token, 'BBC News'), direct);
  assert.equal(decodePublicGoogleLink('https://news.google.com/rss/articles/' + token, 'Reuters'), null);
  assert.equal(decodePublicGoogleLink('https://news.google.com/rss/articles/CBMioAFBVV95cUxOeDdxVDdna', 'BBC News'), null);
});
test('named-author ECB pages and unknown publishers are not silently given reuse permission', async () => {
  assert.equal(policyForUrl('https://www.ecb.europa.eu/press/key/date/2026/html/speech.en.html'), null);
  assert.ok(policyForUrl('https://www.ecb.europa.eu//press/pr/date/2026/html/release.en.html'));
  const unknown = await enrichArticle({ ...article, source: { ...article.source, url: 'https://unknown-publisher.com/report' } }, { fetchImpl: async () => { throw new Error('Must not fetch an unregistered source'); } });
  assert.equal(unknown.status, 'summary_reuse_not_enabled');
});
test('strong reviewed evidence is never fetched or replaced, even with an old headline basis', async () => {
  const result = await enrichArticle({ ...article, digestBasis: 'article-reviewed', summary: 'Reviewed brief.' }, { fetchImpl: async () => { throw new Error('Unexpected fetch'); } });
  assert.equal(result.status, 'already_has_evidence');
  assert.equal(briefFromParagraphs([]), null);
  assert.equal(briefFromParagraphs(['The central bank made a statement that contains more than twenty five words and needs its complete qualifications so that a reader cannot mistake the measure or year being described. These were revised upwards compared with the previous round of the survey.']), null);
});
test('archive pagination remains scoped, detects repeated cursors and sends no publisher credentials', async () => {
  const urls = [];
  const records = await fetchArchive('https://threadnews.online', { fetchImpl: async (input, options) => {
    const url = new URL(input); urls.push(url);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(url.searchParams.get('archive'), '1');
    return Response.json(url.searchParams.has('cursor') ? { articles: [{ id: '2' }], meta: { mode: 'database', hasMore: false } } : { articles: [{ id: '1' }], meta: { mode: 'database', hasMore: true, nextCursor: 'cursor' } });
  } });
  assert.equal(records.length, 2); assert.equal(urls[1].searchParams.get('cursor'), 'cursor');
  await assert.rejects(fetchArchive('https://threadnews.online', { fetchImpl: async () => Response.json({ articles: [], meta: { mode: 'database', hasMore: true, nextCursor: 'repeat' } }) }), /invalid_archive_cursor/);
});
test('dry-run enrichment reports exact unresolved counts and does not publish or classify excerpts as reviewed', async () => {
  const fixture = sourceFetcher(), unresolved = { ...article, id: 'google-only', source: { ...article.source, url: 'https://news.google.com/rss/articles/CBMioAFBVV95cUxOeDdxVDdna', publisher: 'BBC News' } };
  const result = await enrichArchive({ articles: [article, unresolved], ...fixture, now });
  assert.equal(result.published, false); assert.equal(result.changed, 1); assert.equal(result.counts.reviewedDigests, 0);
  assert.equal(result.counts.sourceExcerpts, 1); assert.equal(result.counts.headlineOnly, 1); assert.equal(result.counts.googleLinks, 1);
  assert.equal(auditArticles([unresolved], now).counts.enrichmentEligible, 0);
});

test('source summary fails closed for publisher mismatches, indexing exclusions and headline paraphrases', async () => {
  const policyMismatch=await readOriginalArticle({...article,source:{...article.source,publisher:'Unrelated'}},{fetchImpl:()=>assert.fail('publisher mismatch must not fetch')});
  assert.equal(policyMismatch.status,'no_approved_original');
  const blocked=await readOriginalArticle(article,{fetchImpl:async input=>new URL(input).pathname==='/robots.txt'?new Response(''):new Response(html,{headers:{'content-type':'text/html','x-robots-tag':'nosnippet'}})});
  assert.equal(blocked.status,'robots_disallowed');
  const excerpts=sourceParagraphs(html);
  assert.equal(shortSourceSummary({claims:[{text:article.title}]},article,excerpts),null);
  assert.equal(shortSourceSummary({claims:[{text:excerpts[0]}]},article,excerpts),null);
});
