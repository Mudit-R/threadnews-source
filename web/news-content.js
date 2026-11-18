/* Presentation rules shared by the newsroom and its policy tests. */
(function attachThreadNewsContent(root) {
  'use strict';

  const PLACEHOLDER = /^(?:Headline-based discovery item\b|Headline digest\b|Official-source headline\b|Headline discovered through GDELT\b)/i;
  const SOURCED = new Set(['article-reviewed','source-summary','source-extract','official-primary-source','full_text','abstract']);
  const STOPWORDS = new Set('about after again also and are been before being can could does for from have into its more said says than that the their them then there these they this those through was were what when where which who will with would you'.split(' '));

  function detailTerms(value) {
    const words = String(value || '').normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]{3,}/gu) || [];
    return new Set(words.filter(word => !STOPWORDS.has(word)).map(word => word.length > 4 ? word.replace(/s$/, '') : word));
  }

  function addsDetails(summary, article) {
    const headline = detailTerms([article.title, article.originalHeadline, article.source?.publisher].filter(Boolean).join(' '));
    let novel = 0;
    for (const term of detailTerms(summary)) if (!headline.has(term) && ++novel >= 2) return true;
    return false;
  }

  function displayQuickBrief(article) {
    const basis = article?.digestBasis ?? article?.metadata?.digestBasis ?? article?.metadata?.digest_basis;
    if (!SOURCED.has(basis) && (basis || article?.source?.basis !== 'article')) return '';
    const summary = typeof article.summary === 'string' ? article.summary.trim() : '';
    if (!summary || PLACEHOLDER.test(summary) || !addsDetails(summary, article)) return '';
    const words = summary.split(/\s+/);
    if (words.length <= 100) return summary;
    const end = words.findLastIndex((word, index) => index >= 49 && index < 99 && /[.!?][”"')]*$/.test(word));
    return words.slice(0, end >= 0 ? end + 1 : 99).join(' ') + (end >= 0 ? '' : '…');
  }

  function displaySummary(article) {
    const summary = displayQuickBrief(article);
    return summary.split(/\s+/).length <= 40 ? summary : '';
  }

  const api = Object.freeze({ displaySummary, displayQuickBrief });
  root.ThreadNewsContent = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
