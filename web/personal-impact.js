(() => {
  'use strict';

  const storageKey = 'threadnews.impact-preferences.v1';
  const emptyProfile = () => ({ region: '', lifeStage: '', budgetConcerns: [], issues: [] });
  const matchCount = 4;
  const candidateFreshness = 5 * 60 * 1000;
  const displayDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  let profile = null;
  let remember = false;
  let initialized = false;

  function make(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    return node;
  }

  function validProfile(raw, rank) {
    const match = (value, options) => options.some(option => option.value === value);
    const matches = (values, options) => options.filter(({ value }) => Array.isArray(values) && values.includes(value)).map(({ value }) => value);
    return {
      region: match(raw?.region, rank.regions) ? raw.region : '',
      lifeStage: match(raw?.lifeStage, rank.lifeStages) ? raw.lifeStage : '',
      budgetConcerns: matches(raw?.budgetConcerns, rank.budgetConcerns),
      issues: matches(raw?.issues, rank.issues)
    };
  }

  function hasChoices(value) {
    return Boolean(value.region || value.lifeStage || value.budgetConcerns.length || value.issues.length);
  }

  function restore(rank) {
    if (initialized) return;
    initialized = true;
    try {
      const value = JSON.parse(localStorage.getItem(storageKey));
      const stored = validProfile(value, rank);
      if (hasChoices(stored)) {
        profile = stored;
        remember = true;
      }
    } catch {
      // A private browsing session can disable device storage.
    }
  }

  function updateStorage(value, keep) {
    try {
      if (keep && hasChoices(value)) {
        localStorage.setItem(storageKey, JSON.stringify(value));
        return true;
      }
      localStorage.removeItem(storageKey);
    } catch {
      return false;
    }
    return !keep;
  }

  function selectField(name, label, placeholder, options, chosen) {
    const field = make('label', 'impact-select');
    const select = make('select');
    select.name = name;
    const option = make('option', '', placeholder);
    option.value = '';
    select.append(option);
    for (const { value, label: labelText } of options) {
      const choice = make('option', '', labelText);
      choice.value = value;
      select.append(choice);
    }
    select.value = chosen;
    field.append(make('span', '', label), select);
    return field;
  }

  function checkbox(name, value, label, checked, className) {
    const field = make('label', className);
    const input = make('input');
    input.type = 'checkbox';
    input.name = name;
    input.value = value;
    input.checked = checked;
    field.append(input, make('span', '', label));
    return field;
  }

  function checkboxGroup(name, label, options, chosen) {
    const group = make('fieldset', 'impact-checkbox-group');
    const checks = make('div', 'impact-checks');
    for (const { value, label: labelText } of options) {
      checks.append(checkbox(name, value, labelText, chosen.includes(value), 'impact-choice'));
    }
    group.append(make('legend', '', label), checks);
    return group;
  }

  function resultCard({ article, reasons }) {
    if (!article?.id || !article.title) return null;
    const item = make('li', 'impact-result');
    const headline = make('h3');
    const link = make('a', '', article.title);
    link.href = `/news/${encodeURIComponent(article.id)}`;
    headline.append(link);
    const meta = make('p', 'impact-result-meta', article.source?.publisher || article.category || 'ThreadNews coverage');
    const time = new Date(article.publishedAt);
    if (article.publishedAt && Number.isFinite(time.getTime())) {
      const published = make('time', '', displayDate.format(time));
      published.dateTime = time.toISOString();
      meta.append(' · ', published);
    }
    const basis = article.digestBasis;
    const label = basis === 'publisher-preview' ? 'Publisher preview'
      : basis === 'source-extract' ? 'Source excerpt'
      : basis === 'feed-description' ? 'Feed brief'
      : article.source?.basis === 'article' ? 'Sourced brief' : 'Headline coverage';
    meta.append(' · ', label);
    const match = make('p', 'impact-match');
    match.append(make('strong', '', reasons.length ? 'Why it matches' : 'Coverage'), ' ', reasons.length ? reasons.join(' · ') : (article.region || 'General news'));
    item.append(meta, headline, match);
    return item;
  }

  function mount(container, { loadCandidates }) {
    const rank = globalThis.ThreadNewsImpactRank;
    if (!container || !rank || typeof loadCandidates !== 'function') return () => {};
    restore(rank);

    const section = make('section', 'personal-impact');
    section.setAttribute('aria-labelledby', 'personal-impact-heading');
    const header = make('header', 'impact-header');
    const heading = make('h2', '', 'What could affect you');
    heading.id = 'personal-impact-heading';
    header.append(heading, make('p', '', 'Find recent news about the places and everyday issues that matter to you.'));
    const details = make('details', 'impact-preferences');
    const disclosure = make('summary', '', 'Choose preferences');
    const form = make('form', 'impact-form');
    const selectRow = make('div', 'impact-selects');
    const instructions = make('p', 'impact-note', 'Choose what you want to follow, or leave every field blank for general coverage. Matching happens in this browser.');
    const actions = make('div', 'impact-actions');
    const submit = make('button', 'button primary', 'Show matching stories');
    submit.type = 'submit';
    const clear = make('button', 'impact-clear', 'Clear choices');
    clear.type = 'button';
    actions.append(submit, clear);
    const status = make('p', 'impact-status');
    status.setAttribute('role', 'status');
    const results = make('ul', 'impact-results');
    const footnote = make('p', 'impact-footnote', 'Matches are based on published locations and topics. Individual impacts vary.');
    footnote.hidden = true;
    details.append(disclosure, form);
    section.append(header, details, status, results, footnote);
    container.replaceChildren(section);

    let request = null;
    let candidates = null;
    let candidatesExpireAt = 0;
    let disposed = false;

    function renderForm() {
      const value = profile || emptyProfile();
      disclosure.textContent = hasChoices(value) ? 'Edit preferences' : 'Choose preferences';
      selectRow.replaceChildren(
        selectField('region', 'Region to follow', 'Any region', rank.regions, value.region),
        selectField('lifeStage', 'Life stage', 'Any life stage', rank.lifeStages, value.lifeStage)
      );
      form.replaceChildren(
        instructions,
        selectRow,
        checkboxGroup('budgetConcerns', 'Household costs', rank.budgetConcerns, value.budgetConcerns),
        checkboxGroup('issues', 'Other issues', rank.issues, value.issues),
        checkbox('remember', 'yes', 'Remember my choices on this device', remember, 'impact-remember'),
        actions
      );
    }

    async function showMatches(value, message = '') {
      request?.abort();
      const active = new AbortController();
      request = active;
      results.replaceChildren();
      results.setAttribute('aria-busy', 'true');
      footnote.hidden = true;
      status.textContent = 'Finding recent stories…';
      try {
        const cached = candidates && Date.now() < candidatesExpireAt;
        const articles = cached ? candidates : await loadCandidates({ signal: active.signal });
        if (active.signal.aborted || disposed) return;
        if (!Array.isArray(articles)) throw new TypeError('Expected public articles');
        if (!cached) {
          candidates = articles;
          candidatesExpireAt = Date.now() + candidateFreshness;
        }
        const cards = rank.rank(articles, value, { limit: matchCount }).map(resultCard).filter(Boolean);
        results.replaceChildren(...cards);
        const matchedText = hasChoices(value)
          ? `${cards.length} matching ${cards.length === 1 ? 'story' : 'stories'}`
          : `${cards.length} recent ${cards.length === 1 ? 'story' : 'stories'} on public issues`;
        status.textContent = [message, cards.length ? matchedText : 'No recent matches. Try another region or issue.'].filter(Boolean).join(' ');
        footnote.hidden = !cards.length;
      } catch {
        if (!active.signal.aborted && !disposed) status.textContent = 'Stories are temporarily unavailable. Try again from preferences.';
      } finally {
        if (request === active) {
          results.removeAttribute('aria-busy');
          request = null;
        }
      }
    }

    form.addEventListener('change', event => {
      if (event.target.name === 'remember' && !event.target.checked && remember) {
        remember = false;
        updateStorage(profile || emptyProfile(), false);
      }
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const choices = new FormData(form);
      profile = validProfile({
        region: choices.get('region'), lifeStage: choices.get('lifeStage'),
        budgetConcerns: choices.getAll('budgetConcerns'), issues: choices.getAll('issues')
      }, rank);
      const wantsStorage = choices.has('remember') && hasChoices(profile);
      const stored = updateStorage(profile, wantsStorage);
      remember = wantsStorage && stored;
      renderForm();
      details.open = false;
      disclosure.focus({ preventScroll: true });
      showMatches(profile, wantsStorage && !stored ? 'Device storage is unavailable. Choices will reset when you leave the site.' : '');
    });
    clear.addEventListener('click', () => {
      request?.abort();
      request = null;
      profile = null;
      remember = false;
      const cleared = updateStorage(emptyProfile(), false);
      renderForm();
      results.replaceChildren();
      results.removeAttribute('aria-busy');
      footnote.hidden = true;
      status.textContent = cleared ? 'Choices cleared.' : 'Choices cleared for this visit. Browser storage could not be updated.';
      disclosure.focus({ preventScroll: true });
    });

    renderForm();
    if (profile) showMatches(profile);
    return () => {
      disposed = true;
      request?.abort();
      section.remove();
    };
  }

  globalThis.ThreadNewsPersonalImpact = Object.freeze({ mount });
})();
