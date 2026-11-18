(() => {
  'use strict';

  const summaries = new WeakMap();
  function fetchSummary(article, apiBase) {
    if (summaries.has(article)) return summaries.get(article);
    const url = apiBase + '/api/ai/article?' + new URLSearchParams({ id: article.id });
    const request = fetch(url, { method: 'POST', signal: AbortSignal.timeout(20000) })
      .then(async response => {
        if (!response.ok) return null;
        const result = await response.json();
        return result.status === 'answered' && Array.isArray(result.points) && result.points.length
          && result.points.every(point => typeof point === 'string') ? result : null;
      }).catch(() => null);
    summaries.set(article, request);
    return request;
  }

  function mount(panel, article, { apiBase, digest }) {
    const copy = panel.querySelector('[data-summary-copy]');
    const content = panel.querySelector('.article-summary-body');
    const label = panel.querySelector('.article-summary-label');
    const status = panel.querySelector('[role="status"]');
    const title = article.originalHeadline || article.title;
    let current = [];

    function render({ points, basis }) {
      current = points;
      label.textContent = basis === 'headline' ? 'Based on the publisher headline' : '';
      label.hidden = basis !== 'headline';
      if (points.length === 1) {
        const paragraph = document.createElement('p');
        paragraph.textContent = points[0];
        content.replaceChildren(paragraph);
        return;
      }
      const list = document.createElement('ul');
      for (const point of points) {
        const item = document.createElement('li');
        item.textContent = point;
        list.append(item);
      }
      content.replaceChildren(list);
    }
    render({ points: [digest || title], basis: digest ? 'source_brief' : 'headline' });
    copy.hidden = !navigator.clipboard;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText([article.title, ...current, location.origin + '/news/' + encodeURIComponent(article.id)].join('\n'));
        status.textContent = 'Summary and article link copied.';
      } catch { status.textContent = 'Could not copy the summary.'; }
    });
    if (typeof apiBase !== 'string' || !digest || ['source-summary','article-reviewed','official-primary-source'].includes(article.digestBasis)) return;
    void fetchSummary(article, apiBase).then(result => {
      if (!result || !panel.isConnected) return;
      render(result);
      if (!digest || result.basis !== 'source_brief' || result.points.includes(digest)) return;
      const details = document.createElement('details');
      const disclosure = document.createElement('summary');
      disclosure.textContent = 'Read the source brief';
      const paragraph = document.createElement('p');
      paragraph.textContent = digest;
      details.append(disclosure, paragraph);
      content.append(details);
    });
  }
  globalThis.ThreadNewsArticleSummary = Object.freeze({ mount });
})();
