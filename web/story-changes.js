(() => {
  'use strict';
  const dialog = document.querySelector('#story-changes');
  if (!dialog) return;
  const content = dialog.querySelector('#story-changes-content');
  const topic = dialog.querySelector('#story-changes-topic');
  const days = dialog.querySelector('#story-changes-days');
  const ask = dialog.querySelector('#story-changes-ask');
  const labels = { baseline: 'Before this range', milestone: 'Reviewed milestone', report: 'Linked reporting' };
  let active, request;

  const element = (tag, value) => {
    const node = document.createElement(tag);
    if (value) node.textContent = value;
    return node;
  };
  function sourceLink(source) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      const link = element('a', source.publisher);
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    } catch { return null; }
  }

  function render(data) {
    const count = data.counts;
    const intro = element('p', `${data.since} to ${data.through} (UTC) · ${count.milestones} reviewed milestones · ${count.linkedReports} recent linked reports`);
    const coverage = element('p', `Linked reporting sampled from ${data.reportSince.slice(0, 10)} UTC. ${data.previewTruncated ? 'Timeline preview through ' + data.reviewedThrough + '.' : ''}`.trim());
    content.replaceChildren(intro, coverage);
    const records = new Map(data.evidence.map(item => [item.id, item]));
    const cards = new Map();
    const details = element('details');
    details.open = data.status !== 'answered';
    details.append(element('summary', 'Records behind this brief'));
    for (const record of records.values()) {
      const card = element('article');
      card.id = 'story-record-' + record.id;
      card.tabIndex = -1;
      card.append(element('p', `${record.id} · ${labels[record.role]} · ${record.date}`), element('strong', record.title), element('p', record.excerpt));
      for (const source of record.links) {
        const link = sourceLink(source);
        if (link) card.append(link, ' ');
      }
      details.append(card);
      cards.set(record.id, card);
    }
    if (data.status === 'answered') {
      content.append(element('h3', 'What changed'), element('p', 'AI summary of the records below'));
      const list = element('ol');
      for (const claim of data.claims) {
        const item = element('li', claim.text);
        for (const id of claim.citations) {
          const card = cards.get(id);
          if (!card) continue;
          const citation = element('a', String(id));
          citation.className = 'ask-citation';
          citation.href = '#' + card.id;
          citation.setAttribute('aria-label', 'View source record ' + id);
          citation.addEventListener('click', event => {
            event.preventDefault();
            details.open = true;
            card.focus({ preventScroll: true });
            card.scrollIntoView({ block: 'nearest' });
          });
          item.append(' ', citation);
        }
        list.append(item);
      }
      content.append(list);
    } else {
      content.append(element('p', data.message || 'Browse the dated records below. An AI summary is unavailable for this request.'));
    }
    if (records.size) content.append(details);
  }

  async function load() {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    const loader = element('p', 'Comparing records…');
    loader.setAttribute('role', 'status');
    content.replaceChildren(loader);
    try {
      const url = '/api/ai/changes?' + new URLSearchParams({ event: active.id, days: days.value });
      const response = await fetch(url, { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      if (request === controller && dialog.open) render(data);
    } catch (error) {
      if (request === controller && dialog.open) {
        loader.textContent = error.message === '429' ? 'Too many requests. Try again in a minute.' : 'The comparison is unavailable. Try again.';
        const retry = element('button', 'Retry');
        retry.className = 'button';
        retry.addEventListener('click', load);
        content.append(retry);
      }
    } finally { clearTimeout(timer); }
  }

  days.addEventListener('change', load);
  ask.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => request?.abort());
  globalThis.ThreadNewsStoryChanges = Object.freeze({
    open(id, title) {
      active = { id, title };
      topic.textContent = active.title;
      ask.href = globalThis.ThreadNewsAsk.eventLink(id, title);
      days.value = '90';
      dialog.showModal();
      load();
    }
  });
})();
