(() => {
  'use strict';
  const maxLength = 240;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const glyph = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5c0 5.3 4.2 9.5 9.5 9.5-5.3 0-9.5 4.2-9.5 9.5 0-5.3-4.2-9.5-9.5-9.5 5.3 0 9.5-4.2 9.5-9.5Z"/></svg>';
  const examples = [
    { label: 'Infrastructure', question: 'How did the Mumbai–Ahmedabad bullet train project develop?' },
    { label: 'Economy', question: 'How do India and Japan compare on GDP growth and inflation?' },
    { label: 'Investigation', question: 'What did the Air India Flight 171 investigation establish?' }
  ];
  const sourceURL = value => {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password) return escape(url.href);
    } catch {}
    return null;
  };
  const recordURL = value => typeof value === 'string' && /^\/(threads|economy|news)\/[A-Za-z0-9_.:%-]+$/.test(value) ? escape(value) : '';
  const scopeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
  const countryId = /^[A-Z]{2}$/;
  const path = (scope, id, title) => '/ask?' + new URLSearchParams({ [scope]: id, topic: title });

  function getScope() {
    const params = new URLSearchParams(location.search);
    const eventId = params.get('event'), countryCode = params.get('country'), articleId = params.get('article');
    const topic = params.get('topic')?.trim().slice(0, 110);
    if (scopeId.test(articleId || '')) return { topic: topic || 'This report', articleId };
    if (scopeId.test(eventId || '')) return { topic: topic || 'This timeline', eventId };
    if (countryId.test(countryCode || '')) return { topic: topic || countryCode, countryCode };
    return {};
  }

  function exampleQuestions(scope) {
    if (scope.articleId) return [
      { label: 'Key claims', question: 'What does this report say?' },
      { label: 'Context', question: 'What earlier developments help explain this report?' },
      { label: 'Evidence limits', question: 'What can we establish from this report and what remains unclear?' }
    ];
    if (scope.eventId) return [
      { label: 'Timeline', question: 'What are the key turning points in this timeline?' },
      { label: 'Recent coverage', question: 'What changed in the latest published records?' }
    ];
    if (scope.countryCode) return [
      { label: 'Growth', question: 'How has real GDP growth changed?' },
      { label: 'Prices', question: 'What do the latest inflation readings show?' }
    ];
    return examples;
  }

  function evidenceCard(item) {
    const href = recordURL(item.href);
    const links = (Array.isArray(item.links) ? item.links : []).map(link => {
      const url = sourceURL(link?.url);
      return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${escape(link.publisher || link.title || 'Original source')} <span aria-hidden="true">↗</span></a>` : '';
    }).join('');
    return `<article class="ask-source" id="ask-source-${item.id}" tabindex="-1">
      <div class="ask-source-meta"><span class="ask-number">${item.id}</span><span>${item.role === 'focus' ? 'Report in focus · ' : ''}${escape(item.kind)}${item.date ? ' · ' + escape(item.date) : ''}</span></div>
      <h3>${escape(item.title)}</h3>
      <p>${escape(item.excerpt)}</p>
      ${item.note ? `<p class="ask-source-note">${escape(item.note)}</p>` : ''}
      <div class="ask-source-links">${href ? `<a href="${href}">ThreadNews record <span aria-hidden="true">→</span></a>` : ''}${links}</div>
    </article>`;
  }

  function drawResult(panel, data, question) {
    const evidence = (Array.isArray(data.evidence) ? data.evidence : []).filter(item => Number.isSafeInteger(item?.id) && item.id > 0);
    const ids = new Set(evidence.map(item => item.id));
    const claims = (Array.isArray(data.claims) ? data.claims : []).map(claim => ({
      text: claim?.text, citations: [...new Set((Array.isArray(claim?.citations) ? claim.citations : []).filter(id => ids.has(id)))]
    })).filter(claim => claim.text && claim.citations.length);
    const answered = data.status === 'answered' && claims.length > 0;
    const title = answered ? 'The answer' : data.status === 'insufficient' ? 'Limited evidence for this question' : 'Explore the matching sources';
    const citedIds = new Set(claims.flatMap(claim => claim.citations));
    const titleMarkup = `<h2 id="ask-answer-heading" tabindex="-1">${title}</h2><p class="ask-result-question">${escape(question)}</p>`;
    const body = answered ? `<ol class="ask-claims">${claims.map(claim =>
      `<li><p>${escape(claim.text)} ${claim.citations.map(id =>
        `<a class="ask-citation" href="#ask-source-${id}" data-citation="${id}" aria-label="View evidence ${id}">${id}</a>`
      ).join(' ')}</p></li>`).join('')}</ol>
      <p class="ask-note">AI-generated from ${citedIds.size} cited ${citedIds.size === 1 ? 'record' : 'records'}. Follow a citation to inspect its source.</p>
      ${navigator.clipboard ? '<button type="button" class="button ask-copy" data-ask-copy>Copy answer with sources</button><span class="ask-copy-status" role="status"></span>' : ''}`
      : `<p class="ask-note">${escape(data.message || 'An AI answer is unavailable for this request.')}${data.reason === 'no_evidence'
        ? ' Try adding a country, event name or year.'
        : ''}</p>${data.reason === 'no_evidence' ? '<a class="button" href="/news?archive=1">Search the news archive</a>' : ''}`;
    const cited = evidence.filter(item => citedIds.has(item.id));
    const focus = evidence.find(item => item.role === 'focus' && !citedIds.has(item.id));
    const related = evidence.filter(item => !citedIds.has(item.id) && item !== focus);
    const sources = answered
      ? `${cited.map(evidenceCard).join('')}${focus ? evidenceCard(focus) : ''}${related.map(evidenceCard).join('')}`
      : evidence.map(evidenceCard).join('');
    panel.innerHTML = `<div class="ask-answer">${titleMarkup}${body}</div>
      ${evidence.length ? `<aside class="ask-evidence" aria-label="Evidence"><header><h2>Matching sources</h2><span>${evidence.length} ${evidence.length === 1 ? 'record' : 'records'}${answered ? ` · ${cited.length} cited` : ''}</span></header>${sources}</aside>` : ''}`;
    panel.querySelector('[data-ask-copy]')?.addEventListener('click', async () => {
      const citations = cited.map(item => {
        const direct = Array.isArray(item.links) ? item.links.find(link => sourceURL(link?.url)) : null;
        const record = recordURL(item.href);
        const url = direct?.url || (record ? new URL(item.href, location.origin).href : '');
        return `[${item.id}] ${item.title}${url ? `\n${url}` : ''}`;
      });
      const lines = claims.map(claim => `${claim.text} ${claim.citations.map(id => `[${id}]`).join(' ')}`);
      const status = panel.querySelector('.ask-copy-status');
      try {
        await navigator.clipboard.writeText([question, lines.join('\n'), citations.join('\n\n')].join('\n\n'));
        if (status) status.textContent = 'Copied.';
      } catch {
        if (status) status.textContent = 'Clipboard unavailable.';
      }
    });
    panel.querySelector('#ask-answer-heading').focus();
  }

  function render({ container, apiBase }) {
    const scope = getScope();
    const suggestions = exampleQuestions(scope);
    let request;
    container.innerHTML = `<div class="ask-page">
      <header class="ask-intro">
        <div class="ask-mark">${glyph}</div>
        <div><h1>Ask ThreadNews</h1>
        <p>Ask about a headline, a turning point, or an economic indicator. Check each answer against the records it cites.</p></div>
      </header>
      ${apiBase === null ? '<p class="ask-offline">Answers are available on the <a href="https://threadnews.online/ask">live ThreadNews site</a>.</p>' : `
      <form class="ask-form">
        ${scope.topic ? `<div class="ask-scope"><span>Focused on ${escape(scope.topic)}</span><div class="ask-form-actions">${scope.articleId ? `<a href="/news/${encodeURIComponent(scope.articleId)}">Back to the article</a>` : ''}<a href="/ask">Search all coverage</a></div></div>` : ''}
        <label for="ask-question">Your question</label>
        <textarea id="ask-question" rows="2" maxlength="${maxLength}" minlength="8" required placeholder="What happened, and how did we get here?" aria-describedby="ask-input-note"></textarea>
        <div class="ask-form-bottom">
          <span id="ask-input-note">Questions are sent to an AI provider. Keep personal details out.</span>
          <div class="ask-form-actions"><button type="submit" class="button primary">Find an answer <span aria-hidden="true">→</span></button>${scope.articleId ? '<button type="submit" class="button" data-sources-only formnovalidate>Browse sources</button>' : ''}</div>
        </div>
      </form>
      <div class="ask-examples" aria-label="Suggested questions">${suggestions.map(({ label, question }, index) =>
        `<button type="button" data-question="${index}"><span>${escape(label)}</span>${escape(question)} <span aria-hidden="true">↗</span></button>`
      ).join('')}</div>
      <div class="ask-status" role="status"></div>
      <section class="ask-results" aria-label="Answer and evidence" aria-busy="false"></section>`}
    </div>`;
    if (apiBase === null) return () => {};
    const page = container.querySelector('.ask-page');
    const form = page.querySelector('form'), input = page.querySelector('textarea');
    const buttons = [...form.querySelectorAll('button[type="submit"]')];
    const results = page.querySelector('.ask-results'), status = page.querySelector('.ask-status');
    page.querySelector('.ask-examples').addEventListener('click', event => {
      const suggestion = suggestions[Number(event.target.closest('button')?.dataset.question)];
      if (!suggestion || request) return;
      input.value = suggestion.question;
      input.setCustomValidity('');
      form.requestSubmit();
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    results.addEventListener('click', event => {
      const id = event.target.closest('[data-citation]')?.dataset.citation;
      if (!id) return;
      const item = document.getElementById('ask-source-' + id);
      if (!item) return;
      event.preventDefault();
      results.querySelector('.ask-source.is-cited-target')?.classList.remove('is-cited-target');
      item.classList.add('is-cited-target');
      item.focus({ preventScroll: true });
      item.scrollIntoView({ block: 'nearest' });
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (request) return;
      const sourcesOnly = event.submitter?.hasAttribute('data-sources-only') === true;
      const question = input.value.trim() || (sourcesOnly ? 'What records give context to this report?' : '');
      if (question.length < 8) {
        input.setCustomValidity('Enter a question with at least eight characters.');
        input.reportValidity();
        return;
      }
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 35_000);
      buttons.forEach(button => { button.disabled = true; });
      status.textContent = sourcesOnly ? 'Finding related records…' : 'Finding related records and checking citations…';
      results.replaceChildren();
      results.setAttribute('aria-busy', 'true');
      try {
        const response = await fetch(apiBase + '/api/ai/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, eventId: scope.eventId, countryCode: scope.countryCode, articleId: scope.articleId, sourcesOnly }),
          signal: controller.signal
        });
        if (response.status === 429) {
          status.textContent = 'Too many requests. Wait a minute and try again.';
          return;
        }
        if (response.status === 400) {
          status.textContent = 'Enter a question between eight and 240 characters.';
          return;
        }
        if (!response.ok) throw new Error('Unable to load an answer');
        const data = await response.json();
        if (!page.isConnected) return;
        status.textContent = '';
        drawResult(results, data, question);
      } catch {
        if (page.isConnected) status.textContent = controller.signal.aborted
          ? 'The request took too long. Try again in a moment.'
          : 'The answer could not be loaded. Please try again.';
      } finally {
        clearTimeout(timeout);
        request = null;
        buttons.forEach(button => { button.disabled = false; });
        results.setAttribute('aria-busy', 'false');
      }
    });
    return () => request?.abort();
  }

  globalThis.ThreadNewsAsk = Object.freeze({
    render, glyph,
    articleLink: (id, title) => path('article', id, title.slice(0, 110)),
    eventLink: (id, title) => path('event', id, title),
    countryLink: (id, title) => path('country', id, title)
  });
})();
