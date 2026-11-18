import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../web/news-content.js');
const { displaySummary, displayQuickBrief } = globalThis.ThreadNewsContent;

test('headline-only editorial digests are never displayed', () => {
  assert.equal(displaySummary({ digestBasis: 'headline-only', summary: 'An otherwise polished sentence.' }), '');
  assert.equal(displaySummary({ metadata: { digest_basis: 'headline_only' }, summary: 'An otherwise polished sentence.' }), '');
});

test('automatic placeholder copy is suppressed independent of source metadata', () => {
  for (const summary of [
    'Headline-based discovery item. Open the original reporting for the full context.',
    'Official-source headline. Open the original release for details.',
    'Headline discovered through GDELT. Read the source for more.'
  ]) assert.equal(displaySummary({ summary }), '');
});

test('short reviewed summaries display and summaries over 40 words do not', () => {
  const fortyWords = Array.from({ length: 40 }, (_, index) => `word${index + 1}`).join(' ');
  assert.equal(displaySummary({ digestBasis: 'article-reviewed', summary: 'A reviewed summary.' }), 'A reviewed summary.');
  assert.equal(displaySummary({ digestBasis: 'full_text', summary: fortyWords }), fortyWords);
  assert.equal(displaySummary({ digestBasis: 'abstract', summary: `${fortyWords} word41` }), '');
});

test('source previews and headline restatements are excluded from summary presentation', () => {
  const story = {title:'Canada releases new inflation report',source:{basis:'article',publisher:'Statistics Canada'}};
  assert.equal(displayQuickBrief({...story,digestBasis:'source-summary',summary:'New inflation report released by Canada.'}),'');
  assert.equal(displayQuickBrief({...story,digestBasis:'publisher-preview',summary:'The full release contains monthly price figures and adjustments.'}),'');
  const original='Statistics Canada says grocery prices rose as fuel costs fell.';
  assert.equal(displayQuickBrief({...story,digestBasis:'source-summary',summary:original}),original);
});
