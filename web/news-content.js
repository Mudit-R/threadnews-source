/* Presentation rules shared by the newsroom and its policy tests. */
(function attachThreadNewsContent(root) {
  'use strict';

  const PLACEHOLDER = /^(?:Headline-based discovery item\b|Headline digest\b|Official-source headline\b|Headline discovered through GDELT\b)/i;

  function displaySummary(article) {
    const basis = article?.digestBasis ?? article?.metadata?.digestBasis ?? article?.metadata?.digest_basis;
    if (basis === 'headline-only' || basis === 'headline_only') return '';

    const summary = typeof article?.summary === 'string' ? article.summary.trim() : '';
    if (!summary || PLACEHOLDER.test(summary)) return '';
    if (summary.split(/\s+/).length > 40) return '';
    return summary;
  }

  const api = Object.freeze({ displaySummary });
  root.ThreadNewsContent = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
