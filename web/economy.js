/* Annual history and recent CPI prints are intentionally different views. */
globalThis.createEconomyView = function createEconomyView({icon, esc, toast, renderNav, mountCurrency} = {}) {
  const safe = esc || (v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const glyph = name => typeof icon === 'function' ? icon(name) : '';
  const announce = text => typeof toast === 'function' && toast(text);
  const $ = selector => document.querySelector(selector);
  const palette = ['#275744', '#8e9f52', '#688ba3'];
  const state = {selected:['IND'], metric:'gdpGrowth', year:null, compareOpen:false, view:'chart', cpiFrequency:''};
  let routeCountryApplied=false;
  const number = new Intl.NumberFormat('en-GB', {minimumFractionDigits:1, maximumFractionDigits:2});
  const valid = v => typeof v === 'number' && Number.isFinite(v);
  const fmt = v => valid(v) ? `${number.format(v)}%` : 'Not reported';
  const pp = v => `${number.format(Math.abs(v))} percentage ${Math.abs(v) === 1 ? 'point' : 'points'}`;
  const snapshot = () => globalThis.ECONOMY_SNAPSHOT || {countries:[],meta:{}};
  const countries = () => snapshot().countries || [];
  const country = id => countries().find(c => c.iso3 === id);
  const metricLabel = () => state.metric === 'gdpGrowth' ? 'Real GDP growth' : 'Consumer-price inflation';
  const observations = c => c?.[state.metric] || [];
  const at = (c,y,metric=state.metric) => (c?.[metric] || []).find(p => Number(p.year) === Number(y))?.value ?? null;
  const latest = (c, metric=state.metric) => (c?.[metric] || []).filter(p => valid(p.value)).sort((a,b) => Number(b.year)-Number(a.year))[0];
  const momentum = c => globalThis.ThreadNewsEconomyMetrics?.momentumScore(c, countries()) || null;
  const allYears = () => [...new Set(countries().flatMap(c => (c[state.metric] || []).map(p => Number(p.year))))].sort((a,b)=>a-b);
  const plotYears = () => {
    const all = allYears(), reported = countries().flatMap(c => observations(c).filter(p => valid(p.value)).map(p => Number(p.year)));
    if (!reported.length) return [];
    const last = Math.max(...reported);
    return all.filter(y => y <= last);
  };
  const selected = () => state.selected.map(country).filter(Boolean);
  const period = value => {
    if (!value) return 'Period not recorded';
    if (/^\d{4}-\d{2}$/.test(value)) return new Date(`${value}-15T12:00:00Z`).toLocaleDateString('en-GB',{month:'short',year:'numeric'});
    const quarter = /^(\d{4})-Q([1-4])$/.exec(value);
    if (quarter) return `Q${quarter[2]} ${quarter[1]}`;
    return String(value);
  };
  const day = value => {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  };
  const rateDelta = (c, metric=state.metric) => {
    const p = latest(c,metric);
    if (!p) return null;
    const prior = at(c,Number(p.year)-1,metric);
    return valid(prior) ? {value:p.value-prior, year:Number(p.year), priorYear:Number(p.year)-1} : null;
  };
  function ensureState() {
    if(!routeCountryApplied){
      routeCountryApplied=true;
      const match=/^\/economy\/([^/]+)\/?$/i.exec(location.pathname);
      if(match){let code;try{code=decodeURIComponent(match[1]).toLowerCase();}catch{code=match[1].toLowerCase();}const selectedCountry=countries().find(item=>item.iso3?.toLowerCase()===code||item.code?.toLowerCase()===code||item.name?.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')===code);if(selectedCountry)state.selected=[selectedCountry.iso3];}
    }
    state.selected = state.selected.filter(id => country(id));
    if (!state.selected.length && countries().length) state.selected = [country('IND') ? 'IND' : countries()[0].iso3];
    const years = plotYears();
    if (years.length && !years.includes(state.year)) state.year = years[years.length-1];
  }
  function sourceUrl(type) {
    const links = snapshot().meta?.sourceLinks;
    if (Array.isArray(links)) {
      const match = links.find(x => String(x.id || x.key || x.title || x.label || '').toLowerCase().includes(type === 'gdpGrowth' ? 'gdp' : 'inflation'));
      if (match?.url) return match.url;
    } else if (links && typeof links === 'object') {
      const candidate = links[type];
      if (typeof candidate === 'string') return candidate;
      if (candidate?.url) return candidate.url;
    }
    return type === 'gdpGrowth' ? 'https://data.worldbank.org/indicator/NY.GDP.MKTP.KD.ZG' : 'https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG';
  }
  function deltaText(c, metric) {
    const d = rateDelta(c,metric);
    if (!d) return 'Prior-year comparison unavailable';
    if (Math.abs(d.value) < 0.005) return `Little changed from ${d.priorYear}`;
    return `${pp(d.value)} ${d.value > 0 ? 'higher' : 'lower'} than ${d.priorYear}`;
  }
  function metricTile(c, metric) {
    const p = latest(c,metric);
    return `<article class="econ-stat-card"><div class="econ-stat-label">${metric === 'gdpGrowth' ? 'REAL GDP GROWTH' : 'ANNUAL CPI INFLATION'}<span>ANNUAL</span></div><div class="econ-stat-value">${p ? fmt(p.value) : '—'}<small>${p ? p.year : 'No observation'}</small></div><p>${safe(deltaText(c,metric))}</p><a href="${safe(sourceUrl(metric))}" target="_blank" rel="noopener noreferrer">World Bank · WDI ${glyph('up')}</a></article>`;
  }
  function momentumTile(c) {
    const reading = momentum(c);
    if (!reading) return `<article class="econ-stat-card econ-momentum-card"><div class="econ-stat-label">MACRO MOMENTUM<span>COMPARABLE PERIOD</span></div><div class="econ-stat-value">—<small>Not available</small></div><p>A shared adjacent annual period is not available for every G20 country.</p></article>`;
    const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${number.format(Math.abs(value))}`;
    return `<article class="econ-stat-card econ-momentum-card"><div class="econ-stat-label">MACRO MOMENTUM<span>DESCRIPTIVE · NOT A FORECAST</span></div><div class="econ-stat-value">${number.format(reading.score)}<small>/100 · ${safe(reading.status)}</small></div><p>Annual comparison ${reading.period.from} → ${reading.period.to}. A change in growth contributes ${signed(reading.growthContribution)} points; a change in inflation contributes ${signed(reading.inflationContribution)}.</p><details class="econ-score-details"><summary>Show the formula and limits</summary><p>Score = clamp(50 + 5 × annual GDP-growth change − 2.5 × annual CPI-inflation change, 0, 100). Changes are percentage points. Labels: 60 or above improving, 40 or below slowing, otherwise mixed. It does not measure income, jobs, inequality, debt, poverty, or living standards.</p></details></article>`;
  }
  function latestCpi(c) {
    const print = c.latestInflation;
    if (!print || !valid(print.value)) return `<article class="econ-stat-card econ-current-card"><div class="econ-stat-label">RECENT CPI PRINT<span>SEPARATE SERIES</span></div><div class="econ-stat-value">—<small>Not verified</small></div><p>A recent monthly or quarterly print is not available in this snapshot.</p></article>`;
    const provisional = print.provisional === true || print.status === 'provisional';
    return `<article class="econ-stat-card econ-current-card"><div class="econ-stat-label">RECENT CPI PRINT<span>${print.frequency === 'quarterly' ? 'QUARTERLY' : 'MONTHLY'}</span></div><div class="econ-stat-value">${fmt(print.value)}<small>${safe(period(print.period))} · year on year</small></div><p>${provisional ? '<span class="econ-provisional">Provisional</span> ' : ''}${safe(print.measure || 'Headline consumer-price index')}${print.releaseDate ? `<small class="econ-release-date">Released ${safe(day(print.releaseDate))}</small>` : ''}</p><a href="${safe(print.source?.url || sourceUrl('inflation'))}" target="_blank" rel="noopener noreferrer">${safe(print.source?.publisher || 'Official source')} ${glyph('up')}</a></article>`;
  }
  function chart() {
    const rows = selected(), years = plotYears();
    if (!years.length) return '<div class="econ-empty">Annual observations are not available in this snapshot.</div>';
    const narrow=typeof matchMedia==='function' && matchMedia('(max-width:620px)').matches;
    const W=narrow?420:850, H=narrow?280:318, left=narrow?46:58, right=narrow?14:24, top=24, bottom=39;
    const values = rows.flatMap(c => years.map(y=>at(c,y))).filter(valid);
    if (!values.length) return '<div class="econ-empty">No reported observations for this comparison. Choose another country.</div>';
    const low = Math.min(0,...values), high = Math.max(0,...values), pad = Math.max((high-low)*0.13,0.7);
    const min=low-pad, max=high+pad;
    const x = y => left + (years.length > 1 ? (y-years[0])/(years[years.length-1]-years[0]) : .5) * (W-left-right);
    const sy = v => top + (max-v)/(max-min)*(H-top-bottom);
    const axisNumber = v => Math.abs(v) < 0.05 ? '0' : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
    const grid = Array.from({length:5},(_,i)=> {
      const val=min+(max-min)*i/4, y=sy(val);
      return `<g><line x1="${left}" y1="${y}" x2="${W-right}" y2="${y}" class="econ-grid-line"/><text x="${left-12}" y="${y+4}" text-anchor="end" class="econ-axis-label">${axisNumber(val)}%</text></g>`;
    }).join('');
    const zero = `<line x1="${left}" y1="${sy(0)}" x2="${W-right}" y2="${sy(0)}" class="econ-zero-line"/>`;
    const lines = rows.map((c,index)=> {
      let d='', previousWasValid=false;
      for (const y of years) {
        const v=at(c,y);
        if (!valid(v)) {previousWasValid=false;continue;}
        d+=`${previousWasValid?'L':'M'}${x(y).toFixed(2)},${sy(v).toFixed(2)} `;
        previousWasValid=true;
      }
      const points=years.filter(y=>valid(at(c,y))).map(y=>`<circle cx="${x(y)}" cy="${sy(at(c,y))}" r="${y===state.year?4.5:2.6}" fill="${palette[index]}" stroke="var(--paper,#f8f9f5)" stroke-width="${y===state.year?2:1.4}"><title>${safe(c.name)}, ${y}: ${fmt(at(c,y))}</title></circle>`).join('');
      return `<g><path d="${d}" fill="none" stroke="${palette[index]}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${points}</g>`;
    }).join('');
    const labels=years.map((y,i)=>`<text x="${x(y)}" y="${H-12}" text-anchor="middle" class="econ-axis-label">${(narrow || years.length>12) && i%2!==0 && i!==years.length-1?'':y}</text>`).join('');
    const marker=years.includes(state.year)?`<line x1="${x(state.year)}" y1="${top}" x2="${x(state.year)}" y2="${H-bottom}" class="econ-inspect-line"/>`:'';
    return `<svg class="econ-chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="econ-chart-title econ-chart-description"><title id="econ-chart-title">${safe(metricLabel())}, ${years[0]}–${years[years.length-1]}</title><desc id="econ-chart-description">Annual percent changes for ${safe(rows.map(c=>c.name).join(', '))}. Missing observations break the line. Exact values are available in the table view and the year inspector below.</desc>${grid}${zero}${marker}${lines}${labels}</svg>`;
  }
  function rawTable() {
    const rows=selected(), years=allYears();
    return `<div class="econ-table-scroll" tabindex="0" role="region" aria-label="Annual comparison data"><table class="econ-raw-table"><caption>${safe(metricLabel())} · annual percent change</caption><thead><tr><th scope="col">Year</th>${rows.map(c=>`<th scope="col">${safe(c.name)}</th>`).join('')}</tr></thead><tbody>${years.map(y=>`<tr class="${y===state.year?'econ-inspected-row':''}"><th scope="row">${y}</th>${rows.map(c=>`<td>${valid(at(c,y))?fmt(at(c,y)):'<span class="econ-missing">Not reported</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function cpiHistory(c) {
    const periods = [
      { key:'monthlyCpiHistory', label:'Monthly', noun:'month', units:12, pattern:/^\d{4}-(0[1-9]|1[0-2])$/, limit:72 },
      { key:'quarterlyCpiHistory', label:'Quarterly', noun:'quarter', units:4, pattern:/^\d{4}-Q[1-4]$/, limit:40 }
    ].map(option => ({ ...option, rows:(c[option.key] || []).filter(row =>
      option.pattern.test(row.period || '') && valid(row.value)).sort((a,b) => a.period.localeCompare(b.period)) }))
      .filter(option => option.rows.length);
    const selection = periods.find(option => option.key === state.cpiFrequency) || periods[0];
    if (!selection) return `<section class="econ-monthly-panel"><h2>CPI history</h2><p class="econ-monthly-empty">Monthly and quarterly observations are unavailable for ${safe(c.name)}. Annual inflation is available in the comparison below.</p></section>`;

    const { key, label, noun, units, limit, rows } = selection;
    const visible = rows.slice(-limit), values = visible.map(row => row.value);
    const narrow = typeof matchMedia === 'function' && matchMedia('(max-width:620px)').matches;
    const W = narrow ? 420 : 900, H = narrow ? 235 : 280, left = narrow ? 51 : 65, right = 30, top = 22, bottom = 38;
    const low = Math.min(0, ...values), high = Math.max(0, ...values), pad = Math.max((high - low) * .12, .4);
    const min = low - pad, max = high + pad;
    const index = value => Number(value.slice(0,4)) * units + Number(value.slice(units === 12 ? 5 : 6)) - 1;
    const first = index(visible[0].period), span = index(visible.at(-1).period) - first;
    const x = value => left + (span ? (index(value) - first) / span : .5) * (W - left - right);
    const y = value => top + (max - value) / (max - min) * (H - top - bottom);
    const grid = Array.from({length:5}, (_, i) => {
      const value = min + (max - min) * i / 4, yy = y(value);
      return `<g><line x1="${left}" y1="${yy}" x2="${W-right}" y2="${yy}" class="econ-grid-line"/><text x="${left-10}" y="${yy+4}" text-anchor="end" class="econ-axis-label">${value.toFixed(1)}%</text></g>`;
    }).join('');
    const sourceFor = row => row.source || (Number.isInteger(row.sourceId) ? c[key + 'Sources']?.[row.sourceId] : null) || c[key + 'Source'] || {};
    const measureFor = row => row.measure || sourceFor(row).measure || 'CPI';
    const path = visible.map((row, i) => {
      const previous = visible[i-1];
      const gap = !previous || index(row.period) - index(previous.period) !== 1 || measureFor(row) !== measureFor(previous);
      return `${gap?'M':'L'}${x(row.period).toFixed(2)},${y(row.value).toFixed(2)}`;
    }).join(' ');
    const dots = visible.map((row, i) => `<circle cx="${x(row.period)}" cy="${y(row.value)}" r="${i === visible.length - 1 ? 4 : 2.4}" fill="#688ba3"><title>${safe(period(row.period))} · ${fmt(row.value)}</title></circle>`).join('');
    const labels = [...new Set(Array.from({length:narrow?3:5}, (_, i) => Math.round(i * (visible.length - 1) / (narrow?2:4))))]
      .map(i => `<text x="${x(visible[i].period)}" y="${H-10}" text-anchor="middle" class="econ-axis-label">${safe(period(visible[i].period))}</text>`).join('');
    const last = rows.at(-1), source = sourceFor(last), measure = measureFor(last);
    const frequencyButtons = periods.length > 1 ? `<div class="econ-cpi-frequency" aria-label="CPI frequency">${periods.map(option =>
      `<button type="button" data-action="econ-cpi-frequency" data-frequency="${option.key}" aria-pressed="${option.key===key}">${option.label}</button>`).join('')}</div>` : '';
    return `<section class="econ-monthly-panel" aria-label="CPI history"><div class="econ-panel-heading"><div>
      <div class="econ-eyebrow">${label.toUpperCase()} CPI</div><h2>${safe(c.name)} inflation</h2>
      <p class="econ-monthly-subtitle">${safe(measure)} · ${safe(period(visible[0].period))} to ${safe(period(last.period))}</p>
    </div>${frequencyButtons}</div>
    <div class="econ-monthly-chart-wrap"><svg class="econ-monthly-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} inflation for ${safe(c.name)}">${grid}<path d="${path}" fill="none" stroke="#688ba3" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>${dots}${labels}</svg></div>
    <p class="econ-monthly-note">Year-on-year change by reference ${noun}. Gaps mark missing observations or a change in the measure.</p>
    ${source.sourceNote?`<p class="econ-monthly-note">${safe(source.sourceNote)}</p>`:''}
    ${source.url?`<a class="econ-monthly-source" href="${safe(source.url)}" target="_blank" rel="noopener noreferrer">${safe(source.publisher || 'Open the source series')} ${glyph('up')}</a>`:''}
    <details class="econ-monthly-values"><summary>View ${rows.length} ${label.toLowerCase()} observations</summary><div class="econ-table-scroll" tabindex="0" role="region" aria-label="${label} figures for ${safe(c.name)}"><table class="econ-raw-table"><thead><tr><th scope="col">Reference ${noun}</th><th scope="col">Inflation</th><th scope="col">Measure</th><th scope="col">Publisher</th></tr></thead><tbody>${rows.map(row=>`<tr><th scope="row">${safe(period(row.period))}</th><td>${fmt(row.value)}</td><td>${safe(measureFor(row))}</td><td>${safe(sourceFor(row).publisher || 'Source details unavailable')}</td></tr>`).join('')}</tbody></table></div></details></section>`;
  }
  function inspector() {
    return `<div class="econ-inspector"><div class="econ-inspector-title"><span>THE YEAR IN VIEW</span><strong>${state.year ?? '—'}</strong></div>${selected().map((c,i)=> {
      const v=at(c,state.year), prev=at(c,Number(state.year)-1), delta=valid(v)&&valid(prev)?v-prev:null;
      return `<div class="econ-inspector-country"><span class="econ-legend-dot" style="--econ-color:${palette[i]}"></span><div><strong>${safe(c.name)}</strong><small>${valid(delta)?`${delta>=0?'+':'−'}${number.format(Math.abs(delta))} pp vs ${Number(state.year)-1}`:'No prior-year comparison'}</small></div><b>${valid(v)?fmt(v):'—'}</b></div>`;
    }).join('')}</div>`;
  }
  function plotRegion() { return `${state.view==='chart'?chart():rawTable()}${inspector()}`; }
  function assessment(c) {
    const gdp=latest(c,'gdpGrowth'), inf=latest(c,'inflation');
    const growth=gdp?`Real output ${gdp.value < 0?'contracted':'grew'} by ${fmt(Math.abs(gdp.value))} in ${gdp.year}.`:'No annual real-output observation is available.';
    const gd=rateDelta(c,'gdpGrowth');
    const pace=gd?`The growth rate was ${pp(gd.value)} ${gd.value>=0?'higher':'lower'} than in ${gd.priorYear}.`:'';
    const id=rateDelta(c,'inflation');
    const prices=inf?`The reported annual inflation rate was ${fmt(inf.value)} in ${inf.year}${id?`, ${pp(id.value)} ${id.value>=0?'higher':'lower'} than in ${id.priorYear}`:''}.`:'The annual inflation series has no reported observation.';
    return `<aside class="econ-reading"><div class="econ-eyebrow">READING THE INDICATORS</div><h3>What changed in<br>${safe(c.name)}?</h3><div class="econ-reading-item"><span>OUTPUT</span><p>${safe(growth)} ${safe(pace)}</p></div><div class="econ-reading-item"><span>PRICES</span><p>${safe(prices)}</p></div><p class="econ-reading-note">These describe two indicators. Employment, incomes, debt, inequality and national circumstances add further context.</p></aside>`;
  }
  function comparisonPicker() {
    if (!state.compareOpen) return '';
    return `<section class="econ-comparison-picker" aria-label="Choose comparison countries"><div><strong>Add a perspective.</strong><span>Select up to three countries.</span></div><div class="econ-country-options">${countries().map(c=>`<button data-action="econ-compare" data-code="${safe(c.iso3)}" aria-pressed="${state.selected.includes(c.iso3)}" class="${state.selected.includes(c.iso3)?'econ-option-selected':''}"><span>${safe(c.code || c.iso3)}</span>${safe(c.name)}${state.selected.includes(c.iso3)?glyph('check'):''}</button>`).join('')}</div></section>`;
  }
  function countryTable() {
    return `<section class="econ-country-table-section"><div class="econ-section-heading"><div><div class="econ-eyebrow">THE WIDER PICTURE</div><h2>${countries().length} economies. Different conditions.</h2></div><span>Latest reported observations</span></div><div class="econ-table-scroll" tabindex="0" role="region" aria-label="Economic indicators for ${countries().length} G20 countries"><table class="econ-country-table"><caption>Macro momentum compares annual changes only. It is not an overall country ranking or an assessment of household welfare.</caption><thead><tr><th scope="col">Country</th><th scope="col">Momentum<small>Shared annual period</small></th><th scope="col">Real GDP growth<small>Annual</small></th><th scope="col">CPI inflation<small>Annual history</small></th><th scope="col">Recent CPI print<small>Year on year</small></th><th scope="col"><span class="econ-sr-only">Explore country</span></th></tr></thead><tbody>${countries().map(c=> {
      const score=momentum(c), g=latest(c,'gdpGrowth'), i=latest(c,'inflation'), m=c.latestInflation, gd=rateDelta(c,'gdpGrowth'), id=rateDelta(c,'inflation');
      const change=d=>d?` · ${d.value>=0?'+':'−'}${number.format(Math.abs(d.value))} pp`:'';
      return `<tr class="${state.selected[0]===c.iso3?'econ-primary-row':''}"><th scope="row"><button data-action="econ-country" data-code="${safe(c.iso3)}"><span class="econ-country-code">${safe(c.code || c.iso3)}</span><span>${safe(c.name)}<small>${safe(c.region || '')}</small></span></button></th><td>${score?`<strong>${number.format(score.score)}/100</strong><small>${score.status} · ${score.period.from}–${score.period.to}</small>`:'<span class="econ-missing">No shared period</span>'}</td><td>${g?`<strong>${fmt(g.value)}</strong><small>${g.year}${change(gd)} vs prior year</small>`:'<span class="econ-missing">Not reported</span>'}</td><td>${i?`<strong>${fmt(i.value)}</strong><small>${i.year}${change(id)} vs prior year</small>`:'<span class="econ-missing">Not reported</span>'}</td><td>${m&&valid(m.value)?`<strong>${fmt(m.value)}${m.provisional===true||m.status==='provisional'?'<span class="econ-table-provisional" title="Provisional observation">P</span>':''}</strong><small>${safe(period(m.period))} · ${safe(m.measure || 'CPI')}</small>`:'<span class="econ-missing">Not verified</span>'}</td><td><button class="econ-table-open" data-action="econ-country" data-code="${safe(c.iso3)}" aria-label="Explore ${safe(c.name)}">${glyph('arrow')}</button></td></tr>`;
    }).join('')}</tbody></table></div><p class="econ-table-note">The momentum score uses only annual GDP-growth and CPI-inflation changes. P = provisional. Recent monthly prints are separate from annual history. Missing values remain unavailable.</p></section>`;
  }
  function methodology() {
    const meta=snapshot().meta || {}, counts=globalThis.ThreadNewsEconomyMetrics.coverage(countries());
    return `<section class="econ-methodology"><div><div class="econ-eyebrow">THE RECORD BEHIND THE NUMBERS</div><h2>Keep the definition close.</h2></div><div class="econ-method-grid"><article><span>01 / ANNUAL HISTORY</span><p>World Bank World Development Indicators supplies annual real GDP growth and consumer-price inflation. Historical observations can be revised and may include statistical estimates. Current-year forecasts are not filled into gaps.</p><a href="${safe(sourceUrl('gdpGrowth'))}" target="_blank" rel="noopener noreferrer">GDP indicator ${glyph('up')}</a><a href="${safe(sourceUrl('inflation'))}" target="_blank" rel="noopener noreferrer">Inflation indicator ${glyph('up')}</a></article><article><span>02 / RECENT PRINTS</span><p>National CPI and harmonised HICP histories are loaded from official statistics APIs. A monthly year-on-year rate compares with the same month a year earlier. Countries have different baskets, release calendars and methods; CPI and HICP are distinct measures.</p></article><article><span>03 / MACRO MOMENTUM SCORE</span><p>The latest annual window with complete GDP and CPI observations across all ${counts.countries} countries is used. Score = clamp(50 + 5 × GDP-growth change − 2.5 × CPI-inflation change, 0, 100). Changes are percentage points. 50 means no net change; 60+ is labelled improving, 40 or below slowing, and the middle mixed. This summarizes direction, not absolute income, jobs, debt, inequality, affordability or overall wellbeing. It is not a forecast.</p></article><article><span>04 / G20 COVERAGE</span><p>This view covers ${counts.countries} member countries. The European Union and African Union are also G20 members. They are regional blocs, and no country or euro-area value has been substituted for either bloc. Source-linked monthly history is stored for ${counts.monthlyCountries} countries and quarterly history for ${counts.quarterlyCountries}. Series can have different cut-off dates. The source and reference period stay attached to every exported observation.</p></article></div><div class="econ-source-dates"><span>World Bank dataset updated ${safe(day(meta.sourceUpdatedAt || meta.sourceUpdated) || 'date not recorded')}</span><span>Snapshot ${safe(day(meta.generatedAt || meta.retrievedAt) || 'date not recorded')}</span></div></section>`;
  }
  function render() {
    ensureState();
    const c=selected()[0], meta=snapshot().meta || {};
    if (!c) {$('#main').innerHTML='<section class="econ-empty"><h1>Economic data is not available yet.</h1><p>The official-source snapshot could not be loaded.</p></section>'; return;}
    const years=plotYears();
    const m=c.latestInflation, notes=m?.comparabilityNotes;
    const currentNote=Array.isArray(notes)?notes.join(' '):notes || m?.note || '';
    $('#main').innerHTML=`<div class="econ-page"><header class="econ-hero"><div><div class="econ-eyebrow"><span></span>THE ECONOMY, IN CONTEXT</div><h1>A clearer view of<br><em>what moves an economy.</em></h1><p>Follow growth and prices across the G20, with the source,<br class="econ-desktop-break"> period and definition beside every number.</p>${globalThis.ThreadNewsAsk&&c.code?`<a class="button ask-context-link ask-economy-link" href="${safe(globalThis.ThreadNewsAsk.countryLink(c.code,c.name))}">${globalThis.ThreadNewsAsk.glyph} Ask about ${safe(c.name)}’s economy</a>`:''}</div><div class="econ-coverage">${glyph('globe')}<strong>${countries().length}<span>economies</span></strong><small>Official sources.<br>Room for perspective.</small></div></header>
      <section class="econ-selection" aria-label="Country and comparison selection"><label for="econ-primary-country">YOUR FOCUS<select id="econ-primary-country" aria-label="Select an economy">${countries().map(x=>`<option value="${safe(x.iso3)}" ${x.iso3===c.iso3?'selected':''}>${safe(x.name)}</option>`).join('')}</select></label><div class="econ-selected-countries">${selected().map((x,i)=>`<span><i style="background:${palette[i]}"></i>${safe(x.name)}</span>`).join('')}</div><button class="econ-button ${state.compareOpen?'econ-button-active':''}" data-action="econ-picker" aria-expanded="${state.compareOpen}" id="econ-compare-button">${glyph('layers')} Compare countries<span>${state.selected.length}/3</span></button></section>
      ${comparisonPicker()}<section class="econ-stat-grid" aria-label="Latest indicators for ${safe(c.name)}">${momentumTile(c)}${metricTile(c,'gdpGrowth')}${metricTile(c,'inflation')}${latestCpi(c)}</section>
      ${currentNote?`<p class="econ-current-note">${glyph('info')}${safe(currentNote)}</p>`:''}
      ${cpiHistory(c)}
      <div id="economy-fx-mount"></div>
      <div class="econ-chart-layout"><section class="econ-chart-panel" aria-label="Historical economic indicators"><div class="econ-panel-heading"><div><div class="econ-eyebrow">ANNUAL DATA</div><h2>Annual comparison</h2></div><div class="econ-export-actions" aria-label="Download economic observations"><button class="econ-export" data-action="econ-export">Annual CSV</button><button class="econ-export" data-action="econ-export-history">All series CSV</button></div></div><div class="econ-chart-controls"><div class="econ-metric-tabs" aria-label="Economic indicator"><button data-action="econ-metric" data-metric="gdpGrowth" aria-pressed="${state.metric==='gdpGrowth'}" class="${state.metric==='gdpGrowth'?'econ-tab-active':''}">Real GDP growth</button><button data-action="econ-metric" data-metric="inflation" aria-pressed="${state.metric==='inflation'}" class="${state.metric==='inflation'?'econ-tab-active':''}">CPI inflation</button></div><div class="econ-view-toggle"><button data-action="econ-view" data-view="chart" aria-label="Chart view" aria-pressed="${state.view==='chart'}" class="${state.view==='chart'?'econ-view-active':''}">${glyph('layers')}</button><button data-action="econ-view" data-view="table" aria-label="Raw data table" aria-pressed="${state.view==='table'}" class="${state.view==='table'?'econ-view-active':''}">${glyph('list')}</button></div></div><div class="econ-chart-caption"><span>Annual percent change · ${years[0] || '—'}–${years[years.length-1] || '—'}</span><div>${selected().map((x,i)=>`<span><i style="background:${palette[i]}"></i>${safe(x.name)}</span>`).join('')}</div></div><div id="econ-plot-region">${plotRegion()}</div><div class="econ-year-control"><label for="econ-year-slider">Inspect a year<strong id="econ-year-value">${state.year || '—'}</strong></label><div><button data-action="econ-step" data-step="-1" aria-label="Inspect previous year" ${state.year===years[0]?'disabled':''}>←</button><input type="range" id="econ-year-slider" min="${years[0] || 2015}" max="${years[years.length-1] || 2025}" step="1" value="${state.year || 2025}" aria-label="Inspect annual observation" aria-valuetext="${state.year || 2025}"><button data-action="econ-step" data-step="1" aria-label="Inspect next year" ${state.year===years[years.length-1]?'disabled':''}>→</button></div></div><p class="econ-chart-footnote">Lines break where a value is missing. Current-year annual gaps remain unfilled; the recent CPI card uses a separate frequency.</p></section>${assessment(c)}</div>
      ${countryTable()}${methodology()}</div>`;
    mountCurrency?.($('#economy-fx-mount'));
    if (typeof renderNav === 'function') renderNav();
  }
  function redraw(focusId) {
    const scroll=window.scrollY;
    render();
    window.scrollTo(0,scroll);
    if (focusId) document.getElementById(focusId)?.focus({preventScroll:true});
  }
  function updateYear(value) {
    const years=plotYears();
    if (!years.length) return;
    state.year=Math.max(years[0],Math.min(years[years.length-1],Number(value)));
    const region=$('#econ-plot-region'); if(region) region.innerHTML=plotRegion();
    const output=$('#econ-year-value');if(output)output.textContent=state.year;
    const slider=$('#econ-year-slider');if(slider){slider.value=state.year;slider.setAttribute('aria-valuetext',String(state.year));}
    const previous=document.querySelector('[data-action="econ-step"][data-step="-1"]'), next=document.querySelector('[data-action="econ-step"][data-step="1"]');
    if(previous)previous.disabled=state.year===years[0];if(next)next.disabled=state.year===years[years.length-1];
  }
  function download(blob,filename) {
    const url=URL.createObjectURL(blob), anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function exportCsv(allSeries=false) {
    const metrics=globalThis.ThreadNewsEconomyMetrics;
    const meta=snapshot().meta || {};
    const fallbackSources=Object.fromEntries(['gdpGrowth','inflation'].map(key=>[key,{publisher:'World Bank',dataset:'World Development Indicators',url:sourceUrl(key),updatedAt:meta.sourceUpdatedAt || meta.sourceUpdated || '',retrievedAt:meta.generatedAt || meta.retrievedAt || ''}]));
    const rows=metrics.observationRows(selected(),{...(allSeries?{}:{metrics:[state.metric]}),fallbackSources});
    download(new Blob([metrics.csv(rows)],{type:'text/csv;charset=utf-8'}),`ThreadNews-${allSeries?'all-series':state.metric}-${state.selected.join('-').toLowerCase()}.csv`);
    announce('Observations downloaded with their frequency, reference period and source. Missing values stay blank.');
  }

  function handleAction(e,button) {
    const b=button || e?.target?.closest('[data-action]'), action=b?.dataset?.action;
    if (!action?.startsWith('econ-')) return false;
    if (action==='econ-picker') {state.compareOpen=!state.compareOpen;redraw('econ-compare-button');}
    else if(action==='econ-compare') {
      const id=b.dataset.code;
      if(!country(id))return true;
      if(state.selected.includes(id)){if(state.selected.length===1){announce('Keep one economy selected.');return true;}state.selected=state.selected.filter(x=>x!==id);}
      else if(state.selected.length>=3){announce('Compare up to three economies at a time. Remove one to add another.');return true;}
      else state.selected.push(id);
      redraw();
    } else if(action==='econ-country') {
      const id=b.dataset.code;if(!country(id))return true;
      state.selected=[id,...state.selected.slice(1).filter(x=>x!==id)];render();$('.econ-selection')?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});$('#econ-primary-country')?.focus({preventScroll:true});
    } else if(action==='econ-metric') {
      if(!['gdpGrowth','inflation'].includes(b.dataset.metric))return true;
      state.metric=b.dataset.metric;ensureState();redraw();document.querySelector(`[data-action="econ-metric"][data-metric="${state.metric}"]`)?.focus({preventScroll:true});
    } else if(action==='econ-cpi-frequency') {
      const value=b.dataset.frequency;
      if(!['monthlyCpiHistory','quarterlyCpiHistory'].includes(value))return true;
      state.cpiFrequency=value;
      redraw();
      $(`[data-action="econ-cpi-frequency"][data-frequency="${value}"]`)?.focus({preventScroll:true});
    } else if(action==='econ-view') {state.view=b.dataset.view==='table'?'table':'chart';redraw();document.querySelector(`[data-action="econ-view"][data-view="${state.view}"]`)?.focus({preventScroll:true});}
    else if(action==='econ-step')updateYear(Number(state.year)+Number(b.dataset.step));
    else if(action==='econ-export')exportCsv();
    else if(action==='econ-export-history')exportCsv(true);

    else return false;
    return true;
  }
  function handleChange(e) {
    if(e?.target?.id==='econ-primary-country'){const id=e.target.value;if(country(id)){state.selected=[id,...state.selected.slice(1).filter(x=>x!==id)];redraw('econ-primary-country');}return true;}
    if(e?.target?.id==='econ-year-slider'){updateYear(e.target.value);return true;}
    return false;
  }
  function handleInput(e) {if(e?.target?.id==='econ-year-slider'){updateYear(e.target.value);return true;}return false;}
  return {render, handleAction, handleChange, handleInput};
};
