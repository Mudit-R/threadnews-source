(() => {
  'use strict';

  function create({getJSON, esc}) {
    const host = document.createElement('aside');
    host.className = 'daily-top-stories';
    host.setAttribute('aria-labelledby','daily-top-title');
    host.innerHTML = `<header><h2 id="daily-top-title">Top 5 stories</h2><label>Edition <select aria-label="Top stories edition"><option value="">Global</option></select></label></header>
      <p class="daily-top-ranking" hidden></p><p class="daily-top-status" role="status"></p><ol class="daily-top-list"></ol>`;
    const select = host.querySelector('select'), list = host.querySelector('ol');
    const status = host.querySelector('.daily-top-status'), rankingNote = host.querySelector('.daily-top-ranking');
    const names = new Intl.DisplayNames('en', { type:'region', fallback:'none' });
    let selected = '', preferred, ranking = [], rankingRequest, serial = 0, loadedEdition, loadedAt = 0;

    function updateOptions() {
      const options = [{ code:'', name:'Global' }, ...ranking];
      if (selected && !options.some(item => item.code === selected)) options.push({code:selected, name:names.of(selected) || selected});
      select.replaceChildren(...options.map(item=>new Option(item.name,item.code)));
      select.value = selected;
    }

    async function loadStories() {
      const edition = selected, request = ++serial;
      loadedEdition = edition;
      loadedAt = Date.now();
      status.textContent = 'Loading top stories…';
      list.replaceChildren();
      try {
        const data = await getJSON('/api/news/top'+(edition?'?country='+encodeURIComponent(edition):''));
        if (request !== serial) return;
        if (data.country !== edition || !Array.isArray(data.stories)) throw Error('Invalid edition');
        if (!data.stories.length) {
          status.textContent = edition ? 'No recent matches for this country. Choose Global for more stories.' : 'There are no recent stories yet.';
          return;
        }
        status.textContent = '';
        list.innerHTML = data.stories.slice(0,5).map(item=>`<li><a href="/news/${encodeURIComponent(item.id)}"><strong>${esc(item.title)}</strong><span>${esc(item.publisher)}</span></a></li>`).join('');
      } catch {
        if (request !== serial) return;
        status.textContent = 'Top stories are temporarily unavailable.';
        const retry=document.createElement('button');
        retry.type='button';retry.textContent='Try again';retry.addEventListener('click',loadStories);
        status.append(' ',retry);
      }
    }

    function sync(defaultCountry) {
      if (preferred !== defaultCountry) {
        preferred = defaultCountry;
        selected = defaultCountry || '';
        updateOptions();
      }
      if (!rankingRequest) rankingRequest = getJSON('/api/economy/gdp-ranking').then(data => {
        if (!Array.isArray(data.countries) || !Number.isInteger(data.year)) return;
        ranking = data.countries.filter(item => /^[A-Z]{2}$/.test(item.code) && typeof item.name === 'string').slice(0,10);
        updateOptions();
        rankingNote.hidden = false;
        rankingNote.innerHTML = `10 largest economies by nominal GDP · ${data.year} <a href="https://data.worldbank.org/indicator/NY.GDP.MKTP.CD" target="_blank" rel="noopener noreferrer">World Bank</a>`;
      }).catch(()=>{});
      if (loadedEdition !== selected || Date.now() - loadedAt >= 5 * 60000) void loadStories();
    }

    select.addEventListener('change',()=>{selected=select.value;void loadStories();});
    return {host,sync};
  }

  globalThis.ThreadNewsDailyStories = Object.freeze({create});
})();
