(() => {
  'use strict';

  const CURRENCIES = ['USD','INR','EUR','GBP','JPY','CAD','AUD','CNY','CHF'];
  const REFRESH_MS = 15 * 60 * 1000;
  const ECB = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html';
  const amount = new Intl.NumberFormat('en-GB', { maximumFractionDigits:4, minimumFractionDigits:2 });
  const date = new Intl.DateTimeFormat('en-GB', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' });

  function create(apiBase) {
    const host = document.createElement('section');
    host.className = 'fx-panel';
    host.setAttribute('aria-labelledby','fx-title');
    host.innerHTML = `<div class="fx-panel-head"><h2 id="fx-title">Currency exchange rates</h2><div class="fx-actions">
      <label>Base <select aria-label="Base currency">${CURRENCIES.map(code=>`<option>${code}</option>`).join('')}</select></label>
      <button type="button">Check rates</button></div></div>
      <div class="fx-rates" aria-label="Rates per unit of base currency"></div>
      <p class="fx-status" role="status"></p><a class="fx-source" href="${ECB}" target="_blank" rel="noopener noreferrer">European Central Bank reference rates</a>`;
    const base = host.querySelector('select'), button = host.querySelector('button');
    const list = host.querySelector('.fx-rates'), status = host.querySelector('.fx-status');
    let release, lastCheck = 0, pending = false;
    try {
      const saved = localStorage.getItem('threadnews-fx-base');
      if (CURRENCIES.includes(saved)) base.value = saved;
    } catch {}

    function draw() {
      if (!release) return;
      const rate = release.rates[base.value];
      if (!rate) return;
      const items = [];
      for (const code of CURRENCIES) {
        if (code === base.value || !release.rates[code]) continue;
        const row = document.createElement('div'), currency = document.createElement('span'), value = document.createElement('strong');
        currency.textContent = code;
        value.textContent = amount.format(release.rates[code] / rate);
        row.append(currency,value);
        items.push(row);
      }
      list.replaceChildren(...items);
      status.textContent = `Per 1 ${base.value} · Release ${date.format(new Date(release.publishedDate))}`;
    }

    async function refresh() {
      if (pending) return;
      pending = true;
      lastCheck = Date.now();
      button.disabled = true;
      if (!release) status.textContent = 'Checking the latest ECB release…';
      try {
        const response = await fetch(apiBase + '/api/economy/fx', { signal:AbortSignal.timeout(11000) });
        if (!response.ok) throw Error('Rates unavailable');
        const next = await response.json();
        if (!next.rates?.EUR || !/^\d{4}-\d{2}-\d{2}$/.test(next.publishedDate || '')) throw Error('Invalid rates');
        release = next;
        draw();
      } catch {
        status.textContent = release ? `Showing the ${date.format(new Date(release.publishedDate))} release. The latest check failed.` : 'Currency rates are temporarily unavailable.';
      } finally {
        pending = false;
        button.disabled = false;
      }
    }

    function refreshIfVisible() {
      if (host.isConnected && !document.hidden && Date.now() - lastCheck >= REFRESH_MS) void refresh();
    }
    base.addEventListener('change', () => {
      try { localStorage.setItem('threadnews-fx-base',base.value); } catch {}
      draw();
    });
    button.addEventListener('click',refresh);
    document.addEventListener('visibilitychange',refreshIfVisible);
    setInterval(refreshIfVisible,60000);
    return { host, refreshIfVisible };
  }

  globalThis.ThreadNewsFxRates = Object.freeze({ create });
})();
