(() => {
  'use strict';
  const button = document.querySelector('#daily-brief-button');
  const dialog = document.querySelector('#daily-brief');
  const content = document.querySelector('#daily-brief-content');
  const date = document.querySelector('#daily-brief-date');
  if (!button || !dialog || !content || !date) return;
  const sync = () => {
    const routes = globalThis.ThreadNewsPublicRoutes;
    const legacy = routes?.legacyLocationPath(location.hash, location.search);
    const current = routes?.routeForPath(legacy?.split('?')[0] || location.pathname);
    button.hidden = current?.page !== 'explore' || globalThis.THREADLINE_CONFIG?.apiBase === null;
    if (button.hidden && dialog.open) dialog.close();
  };
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function showBrief(data) {
    const time = new Date(data.asOf);
    date.textContent = Number.isFinite(time.getTime()) ? '24 hours ending ' + formatter.format(time) : 'The last 24 hours of coverage';
    const evidence = new Map((data.evidence || []).map(item => [item.id, item]));
    const answered = data.status === 'answered' && data.claims?.length;
    const notice = document.createElement('p');
    notice.textContent = answered ? 'AI summary of selected reporting' : evidence.size
      ? 'Recent source records. An AI summary is unavailable right now.' : 'No source records are available for this 24-hour edition yet.';
    content.replaceChildren(notice);
    const claims = answered ? data.claims : [...evidence.values()].slice(0, 5).map(item => ({ text: item.title, citations: [item.id] }));
    if (!claims.length) return;
    const list = document.createElement('ol');
    for (const claim of claims) {
      const item = document.createElement('li'), text = document.createElement('p');
      text.textContent = claim.text;
      item.append(text);
      for (const id of claim.citations) {
        const source = evidence.get(id);
        if (!/^\/news\/[a-z0-9_.:%-]+$/i.test(source?.href || '')) continue;
        const link = document.createElement('a');
        link.href = source.href;
        link.textContent = source.links?.[0]?.publisher || 'Source record';
        item.append(link, ' ');
      }
      list.append(item);
    }
    content.append(list);
  }

  let pending = false;
  button.addEventListener('click', async () => {
    dialog.showModal();
    if (pending) return;
    pending = true;
    date.textContent = 'The last 24 hours of coverage';
    content.textContent = 'Preparing the latest brief…';
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await fetch('/api/ai/daily', { signal: AbortSignal.timeout(18000) });
        if (response.status === 202) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
        if (!response.ok) break;
        showBrief(await response.json());
        return;
      }
      content.textContent = 'The brief is unavailable. Open it again to retry.';
    } catch {
      content.textContent = 'The brief is unavailable. Open it again to retry.';
    } finally { pending = false; }
  });
  dialog.addEventListener('click', event => {
    if (event.target.closest('a')) dialog.close();
  });
  new MutationObserver(sync).observe(document.querySelector('#main'), { childList: true });
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);
  sync();
})();
