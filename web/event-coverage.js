(() => {
  'use strict';
  const instances = new WeakMap();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const safeURL = value => { try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? esc(url.href) : '#'; } catch { return '#'; } };
  const date = value => { const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value + 'T12:00:00Z' : value); return Number.isFinite(at.getTime()) ? at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unavailable'; };
  const month = value => { const at = new Date(value); return Number.isFinite(at.getTime()) ? at.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'Date unavailable'; };
  function archiveAccessNote(scope) {
    return `<p class="coverage-archive-note" role="status">Full historical ${scope} requires verified supporter access. <a href="/pricing">See membership options</a>.</p>`;
  }
  function statusView(event) {
    const check = event.statusCheck;
    if (!check?.observation) return event.checkedThrough ? `<p class="coverage-check-date">Reviewed chronology checked through ${date(event.checkedThrough)}.</p>` : '';
    const sources = Array.isArray(check.sources) && check.sources.length ? check.sources : [{ url: check.url, publisher: check.publisher, title: 'Public source index' }];
    return `<details class="coverage-status-check"><summary>Public records checked ${date(check.date)}</summary><p>${esc(check.observation)}</p><ul>${sources.map(source => `<li><a href="${safeURL(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title || source.publisher || 'Original source')} ↗</a><span>${esc(source.publisher || '')}${source.published ? ' · published ' + date(source.published) : ''}</span></li>`).join('')}</ul><p class="coverage-check-note">This is the date of a source check. It does not add a new development to the chronology.</p></details>`;
  }
  function itemView(item) {
    const source = item.source || {}, editorLinked = item.matchedBy?.type === 'editor-linked';
    const phrases = Array.isArray(item.matchedBy?.phrases) ? item.matchedBy.phrases : [];
    return `<article class="coverage-item" data-coverage-id="${esc(item.id)}"><div class="coverage-item-meta"><time datetime="${esc(item.publishedAt)}">${date(item.publishedAt)}</time><span>${esc(source.publisher || 'Source')}</span><span class="coverage-source-type">${/official|primary|government|statistical/i.test(source.sourceType || '') ? 'Institutional source' : 'Reporting'}</span></div><h3><a href="${safeURL(source.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)} <span aria-hidden="true">↗</span></a></h3><div class="coverage-item-foot"><span>${editorLinked ? 'Editor linked source headline' : 'Automatically linked source headline'}</span><details class="coverage-match"><summary>Why it appears here</summary><p>${editorLinked ? 'An editor linked this report to the event.' : 'The headline or its source metadata matched the event’s tracking phrases.'}${phrases.length ? ' Matched phrases: ' + phrases.map(phrase => '“' + esc(phrase) + '”').join(', ') + '.' : ''} This match does not verify the report’s claims.</p><p>First collected ${date(item.firstSeenAt)}. Publication dates belong to the source report, and may differ from event dates.</p></details></div>${Number(item.revisionCount) > 0 ? `<details class="coverage-revisions" data-revisions="${esc(item.id)}"><summary>${Number(item.revisionCount)} earlier headline ${Number(item.revisionCount) === 1 ? 'version' : 'versions'}</summary><div class="coverage-revision-content"><button type="button" data-coverage-action="revisions" data-id="${esc(item.id)}">Load earlier headlines</button></div></details>` : ''}</article>`;
  }

  /** Call after inserting the event-page container. Returns {ready,destroy}.
   * eventOrId may be the full event payload, enabling its source-check display.
   * No bundled edition is substituted for an empty or failed production API. */
  function mount(container, eventOrId, options = {}) {
    if (!container) return { ready: Promise.resolve(), destroy() {} };
    instances.get(container)?.destroy();
    const event = typeof eventOrId === 'string' ? { id: eventOrId } : eventOrId || {};
    const config = globalThis.THREADLINE_CONFIG || {}, apiBase = options.apiBase ?? config.apiBase;
    const connected = typeof apiBase === 'string', fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    const controller = new AbortController(), state = { items: [], total: 0, nextCursor: null, loading: false, error: '', range: 'recent' };
    let disposed = false, generation = 0;
    container.classList.add('event-coverage'); container.setAttribute('aria-label', 'Source coverage over time');
    function alive() { return !disposed && container.isConnected; }
    function render() {
      if (!alive()) return;
      let currentMonth = '';
      const items = state.items.map(item => { const heading = month(item.publishedAt); const divider = heading !== currentMonth ? `<h3 class="coverage-month">${esc(heading)}</h3>` : ''; currentMonth = heading; return divider + itemView(item); }).join('');
      const archiveLocked = state.error === 'archive_access_required';
      container.innerHTML = `<div class="coverage-heading"><div><span class="eyebrow">FOLLOW THE REPORTING</span><h2>Coverage as it unfolds.</h2><p>Source headlines appear here as they are collected. The reviewed milestones above keep their own dates and evidence.</p></div><span class="coverage-count">${state.loading && !state.items.length ? 'Checking coverage…' : archiveLocked ? 'Supporter archive' : `${state.total} linked ${state.total === 1 ? 'report' : 'reports'}`}</span></div>${options.showStatusCheck === false ? '' : statusView(event)}<div class="coverage-controls" role="group" aria-label="Coverage period"><button type="button" data-coverage-action="recent" aria-pressed="${state.range === 'recent'}">Recent coverage</button><button type="button" data-coverage-action="all" aria-pressed="${state.range === 'all'}">All stored coverage</button></div><p class="coverage-access-note">Recent coverage uses the public news window. Full historical coverage and earlier headline versions require supporter access. <a href="/pricing">See membership options</a>.</p><p class="coverage-evidence-note">Automatic links identify relevant reporting. They are not reviewed milestones or independent confirmation; several publishers may repeat the same original account.</p><div class="coverage-items" aria-busy="${state.loading}">${items || (!state.loading ? `<div class="coverage-empty">${archiveLocked ? 'Historical coverage is available with verified supporter access.' : connected ? 'No linked headlines have been collected for this period. This does not establish that no developments occurred; the reviewed chronology and original sources remain available above.' : 'Automatic source coverage is available on the independently hosted ThreadNews site. This edition contains the reviewed chronology.'}</div>` : '<p class="coverage-loading" role="status">Checking source coverage…</p>')}</div>${archiveLocked ? archiveAccessNote('source coverage') : state.error ? `<p class="coverage-error" role="status">Source coverage could not be loaded. The reviewed chronology is still available. <button type="button" data-coverage-action="retry">Retry</button></p>` : ''}${state.nextCursor ? `<button type="button" class="button coverage-more" data-coverage-action="more" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Loading…' : 'Load more source coverage'}</button>` : ''}<p class="coverage-scope">Only reporting collected by ThreadNews appears here. ${state.range === 'recent' ? 'Recent results follow the public news window.' : 'Stored coverage remains separate from the current-news feed.'}</p>`;
    }
    async function load(reset = false) {
      if (!connected || state.loading || !event.id) return;
      const run = ++generation; state.loading = true; state.error = '';
      if (reset) { state.items = []; state.nextCursor = null; state.total = 0; }
      render();
      try {
        const url = new URL(String(apiBase).replace(/\/$/, '') + '/api/events/' + encodeURIComponent(event.id) + '/coverage', location.origin);
        url.searchParams.set('limit', '20'); if (state.range === 'all') url.searchParams.set('since', '1970-01-01');
        if (!reset && state.nextCursor) url.searchParams.set('cursor', state.nextCursor);
        const response = await fetchImpl(url, { credentials: 'same-origin', signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) {
          let payload = {}; try { payload = await response.json(); } catch {}
          const failure = new Error(payload.error || 'coverage_unavailable');
          failure.code = payload.error;
          throw failure;
        }
        const document = await response.json();
        if (!Array.isArray(document.coverage) || !document.meta || !Number.isInteger(document.meta.total)) throw new Error('invalid_coverage');
        if (!alive() || run !== generation) return;
        const known = new Set(state.items.map(item => item.id)); state.items.push(...document.coverage.filter(item => item && typeof item.id === 'string' && !known.has(item.id)));
        state.total = document.meta.total; state.nextCursor = document.meta.hasMore && typeof document.meta.nextCursor === 'string' ? document.meta.nextCursor : null;
      } catch (error) { if (error.name !== 'AbortError' && alive() && run === generation) state.error = error.code === 'archive_access_required' ? 'archive_access_required' : 'coverage_unavailable'; }
      finally { if (run === generation) { state.loading = false; render(); } }
    }
    async function revisions(button) {
      const target = button.closest('.coverage-revision-content'); if (!target || button.disabled) return;
      button.disabled = true; button.textContent = 'Loading earlier headlines…';
      try {
        const url = new URL(String(apiBase).replace(/\/$/, '') + '/api/events/' + encodeURIComponent(event.id) + '/coverage/' + encodeURIComponent(button.dataset.id) + '/revisions?limit=20', location.origin);
        const response = await fetchImpl(url, { credentials: 'same-origin', signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) {
          let payload = {}; try { payload = await response.json(); } catch {}
          const failure = new Error(payload.error || 'revision_unavailable');
          failure.code = payload.error;
          throw failure;
        }
        const document = await response.json(); if (!Array.isArray(document.revisions)) throw new Error('invalid_revisions');
        if (alive() && target.isConnected) target.innerHTML = `<ol>${document.revisions.map(revision => `<li><strong>${esc(revision.coverage?.title || 'Earlier source headline')}</strong><span>Replaced when collected ${date(revision.recordedAt)}</span></li>`).join('')}</ol><p>Earlier headline metadata only. Full publisher articles are not archived here.${document.meta?.hasMore ? ' The most recent 20 earlier versions are shown.' : ''}</p>`;
      } catch (error) { if (error.name !== 'AbortError' && alive() && target.isConnected) { if (error.code === 'archive_access_required') target.innerHTML = archiveAccessNote('earlier headline versions'); else { button.disabled = false; button.textContent = 'Retry loading earlier headlines'; } } }
    }
    function click(event) {
      const button = event.target.closest('[data-coverage-action]'); if (!button || !container.contains(button)) return;
      const action = button.dataset.coverageAction;
      if (action === 'revisions') { revisions(button); return; }
      if (state.loading) return;
      if (action === 'recent' || action === 'all') { state.range = action; if (connected) load(true); else render(); }
      if (action === 'more' || action === 'retry') load(!state.items.length);
    }
    container.addEventListener('click', click); render();
    const instance = { ready: connected ? load(true) : Promise.resolve(), destroy() { disposed = true; controller.abort(); container.removeEventListener('click', click); instances.delete(container); } };
    instances.set(container, instance); return instance;
  }
  globalThis.ThreadNewsEventCoverage = { mount };
})();
