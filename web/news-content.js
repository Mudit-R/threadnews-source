/* Presentation rules shared by the newsroom and its policy tests. */
(function attachThreadNewsContent(root) {
  'use strict';

  const PLACEHOLDER = /^(?:Headline-based discovery item\b|Headline digest\b|Official-source headline\b|Headline discovered through GDELT\b)/i;
  const SOURCED = new Set(['article-reviewed','source-summary','source-extract','official-primary-source','publisher-preview','feed-description']);

  function displaySummary(article) {
    const basis = article?.digestBasis ?? article?.metadata?.digestBasis ?? article?.metadata?.digest_basis;
    if (basis === 'headline-only' || basis === 'headline_only') return '';

    const summary = typeof article?.summary === 'string' ? article.summary.trim() : '';
    if (!summary || PLACEHOLDER.test(summary)) return '';
    if (summary.split(/\s+/).length > 40) return '';
    return summary;
  }

  function displayQuickBrief(article) {
    if (!SOURCED.has(article?.digestBasis)) return article?.source?.basis === 'article' ? displaySummary(article) : '';
    const summary = typeof article.summary === 'string' ? article.summary.trim() : '';
    if (!summary || summary === article.title || PLACEHOLDER.test(summary)) return '';
    const words = summary.split(/\s+/);
    if (words.length <= 100) return summary;
    const end = words.findLastIndex((word, index) => index >= 49 && index < 99 && /[.!?][”"')]*$/.test(word));
    return words.slice(0, end >= 0 ? end + 1 : 99).join(' ') + (end >= 0 ? '' : '…');
  }

  const api = Object.freeze({ displaySummary, displayQuickBrief });
  root.ThreadNewsContent = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
