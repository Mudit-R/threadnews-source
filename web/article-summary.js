(() => {
  'use strict';

  function mount(panel, article, { apiBase, digest }) {
    const button = panel.querySelector('[data-summary-generate]');
    const copy = panel.querySelector('[data-summary-copy]');
    const content = panel.querySelector('.article-summary-body');
    const label = panel.querySelector('.article-summary-label');
    const status = panel.querySelector('[role="status"]');
    const heading = panel.querySelector('h2');
    const title = article.originalHeadline || article.title;
    let current = [];

    function render({ points, status: mode, basis }) {
      current = points;
      heading.textContent = mode === 'answered' ? 'AI summary' : 'At a glance';
      label.textContent = basis === 'headline' ? 'Based on the publisher headline'
        : mode === 'answered' ? 'From the stored source brief' : 'Source brief';
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
    render({ points: [digest || title], status: 'source', basis: digest ? 'source_brief' : 'headline' });
    copy.hidden = !navigator.clipboard;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText([article.title, ...current, location.origin + '/news/' + encodeURIComponent(article.id)].join('\n'));
        status.textContent = 'Summary and article link copied.';
      } catch { status.textContent = 'Could not copy the summary.'; }
    });
    if (typeof apiBase !== 'string') {
      button.hidden = true;
      return;
    }
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = 'Preparing a shorter summary…';
      try {
        const url = apiBase + '/api/ai/article?' + new URLSearchParams({ id: article.id });
        const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(String(response.status));
        const result = await response.json();
        if (!Array.isArray(result.points) || !result.points.length || result.points.some(point => typeof point !== 'string')) throw new Error('invalid_summary');
        if (result.status === 'answered') {
          render(result);
          if (digest) {
            const details = document.createElement('details');
            const label = document.createElement('summary');
            label.textContent = 'Read the source brief';
            const paragraph = document.createElement('p');
            paragraph.textContent = digest;
            details.append(label, paragraph);
            content.append(details);
          }
          button.hidden = true;
          status.textContent = 'AI summary ready.';
        } else {
          status.textContent = 'The source text is available above. Try again later for an AI summary.';
        }
      } catch (error) {
        status.textContent = error.message === '429'
          ? 'Please wait a minute before requesting another summary.'
          : 'The AI summary is unavailable. You can still read the source text.';
      } finally { button.disabled = false; }
    });
  }
  globalThis.ThreadNewsArticleSummary = Object.freeze({ mount });
})();
