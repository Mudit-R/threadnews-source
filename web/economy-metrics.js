/* Shared, auditable macro-momentum calculation. Loaded before economy.js. */
(function (root) {
  'use strict';

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const valueAt = (country, series, year) => {
    const row = country?.[series]?.find(point => Number(point.year) === Number(year));
    return finite(row?.value) ? row.value : null;
  };
  const ownComparisonYears = country => {
    const years = new Set((country?.gdpGrowth || []).map(row => Number(row.year)).filter(Number.isFinite));
    return [...years].filter(year =>
      valueAt(country, 'gdpGrowth', year) !== null && valueAt(country, 'gdpGrowth', year - 1) !== null &&
      valueAt(country, 'inflation', year) !== null && valueAt(country, 'inflation', year - 1) !== null
    );
  };
  function commonComparisonYears(countries) {
    if (!Array.isArray(countries) || countries.length === 0) return [];
    const sets = countries.map(country => new Set(ownComparisonYears(country)));
    return [...sets[0]].filter(year => sets.every(set => set.has(year))).sort((a, b) => a - b);
  }
  function momentumScore(country, countries) {
    const years = commonComparisonYears(countries);
    const year = years.at(-1);
    if (!Number.isInteger(year) || !country || !countries.includes(country)) return null;
    const growthPrior = valueAt(country, 'gdpGrowth', year - 1);
    const growthCurrent = valueAt(country, 'gdpGrowth', year);
    const inflationPrior = valueAt(country, 'inflation', year - 1);
    const inflationCurrent = valueAt(country, 'inflation', year);
    if ([growthPrior, growthCurrent, inflationPrior, inflationCurrent].some(value => value === null)) return null;
    const growthChange = growthCurrent - growthPrior;
    const inflationChange = inflationCurrent - inflationPrior;
    const growthContribution = 5 * growthChange;
    const inflationContribution = -2.5 * inflationChange;
    const rawScore = 50 + growthContribution + inflationContribution;
    const score = Number(Math.max(0, Math.min(100, rawScore)).toFixed(1));
    return {
      version: 'macro-momentum-v1',
      score,
      status: score >= 60 ? 'Improving' : score <= 40 ? 'Slowing' : 'Mixed',
      period: { from: year - 1, to: year },
      baseline: 50,
      growthChange: Number(growthChange.toFixed(3)),
      growthContribution: Number(growthContribution.toFixed(3)),
      inflationChange: Number(inflationChange.toFixed(3)),
      inflationContribution: Number(inflationContribution.toFixed(3)),
      formula: 'clamp(50 + 5 × annual GDP-growth change − 2.5 × annual CPI-inflation change, 0, 100)'
    };
  }

  const sourceUrl = value => {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; }
    catch { return ''; }
  };
  function observationSource(country, key, point) {
    const sourceKey = key === 'monthlyCpiHistory' ? 'monthlyCpiHistory' : key === 'quarterlyCpiHistory' ? 'quarterlyCpiHistory' : key;
    return point?.source || (Number.isInteger(point?.sourceId) ? country?.[sourceKey + 'Sources']?.[point.sourceId] : null)
      || country?.[sourceKey + 'Source'] || {};
  }
  function coverage(countries) {
    const list = Array.isArray(countries) ? countries : [];
    const has = (country, key, pattern) => (country?.[key] || []).some(point =>
      finite(point?.value) && pattern.test(point.period || '') && sourceUrl(observationSource(country, key, point).url));
    return { countries: list.length,
      monthlyCountries: list.filter(country => has(country, 'monthlyCpiHistory', /^\d{4}-(0[1-9]|1[0-2])$/)).length,
      quarterlyCountries: list.filter(country => has(country, 'quarterlyCpiHistory', /^\d{4}-Q[1-4]$/)).length };
  }
  function observationRows(countries, { metrics = ['gdpGrowth', 'inflation', 'monthlyCpiHistory', 'quarterlyCpiHistory'], fallbackSources = {} } = {}) {
    const columns = ['country', 'iso3', 'indicator', 'frequency', 'period', 'value', 'unit', 'publisher', 'dataset', 'source_url', 'source_updated_at', 'source_retrieved_at', 'release_date', 'observation_status'];
    const rows = [columns];
    const definitions = {
      gdpGrowth: ['Real GDP growth', 'annual', 'annual percent change', /^\d{4}$/],
      inflation: ['Consumer-price inflation', 'annual', 'annual percent change', /^\d{4}$/],
      monthlyCpiHistory: ['Consumer-price inflation', 'monthly', 'year-on-year percent change', /^\d{4}-(0[1-9]|1[0-2])$/],
      quarterlyCpiHistory: ['Consumer-price inflation', 'quarterly', 'year-on-year percent change', /^\d{4}-Q[1-4]$/]
    };
    for (const country of Array.isArray(countries) ? countries : []) for (const key of metrics) {
      const definition = definitions[key]; if (!definition) continue;
      for (const point of country?.[key] || []) {
        const period = String(point.period ?? point.year ?? '');
        if (!definition[3].test(period)) continue;
        const source = observationSource(country, key, point), fallback = fallbackSources[key] || {};
        rows.push([country.name || '', country.iso3 || '', point.measure || source.measure || definition[0], definition[1], period,
          finite(point.value) ? point.value : '', definition[2], source.publisher || fallback.publisher || '', source.dataset || fallback.dataset || '',
          sourceUrl(source.url || fallback.url), source.updatedAt || source.updated || fallback.updatedAt || '',
          source.retrievedAt || fallback.retrievedAt || '', point.releaseDate || '', finite(point.value) ? (point.provisional ? 'provisional' : 'reported') : 'not_reported']);
      }
    }
    return rows;
  }
  function csv(rows) {
    const cell = value => {
      let text = String(value ?? '');
      // A publisher/country label is data even when it starts like a spreadsheet formula.
      if (typeof value !== 'number' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
  }

  root.ThreadNewsEconomyMetrics = Object.freeze({ commonComparisonYears, momentumScore, coverage, observationRows, csv });
})(globalThis);
