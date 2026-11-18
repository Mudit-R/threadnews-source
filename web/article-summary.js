(() => {
  'use strict';

  function mount(panel, article, digest) {
    const copy = panel.querySelector('[data-summary-copy]');
    const status = panel.querySelector('[role="status"]');
    copy.hidden = !navigator.clipboard;
    copy.addEventListener('click', async () => {
      try {
        const link = location.origin + '/news/' + encodeURIComponent(article.id);
        await navigator.clipboard.writeText([article.title, digest, link].join('\n'));
        status.textContent = 'Summary and article link copied.';
      } catch {
        status.textContent = 'Could not copy the summary.';
      }
    });
  }

  globalThis.ThreadNewsArticleSummary = Object.freeze({ mount });
})();
