(() => {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;
  const MAX_AGE = 7 * DAY;
  const REVIEWED_BASES = new Set(['article-reviewed', 'source-summary', 'source-extract', 'publisher-preview', 'official-primary-source']);
  const INSPECTABLE_BASES = new Set(['article-reviewed', 'source-summary', 'official-primary-source']);
  const PUBLIC_TOPICS = new Set(['economy', 'finance', 'politics', 'world', 'world affairs', 'infrastructure', 'health', 'energy', 'trade', 'climate']);

  const places = [
    { value: 'mumbai', label: 'Mumbai', area: 'south-asia', country: 'india', pattern: /\b(?:mumbai|bombay|navi mumbai|thane)\b/ },
    { value: 'delhi', label: 'Delhi NCR', area: 'south-asia', country: 'india', pattern: /\b(?:delhi|gurugram|gurgaon|noida|ghaziabad|faridabad)\b/ },
    { value: 'india', label: 'India', area: 'south-asia', pattern: /\b(?:india|indian|new delhi|maharashtra|gujarat|karnataka|bengaluru|mumbai|rupee|rbi)\b/ },
    { value: 'united-states', label: 'United States', area: 'north-america', pattern: /\b(?:united states|american|u s|us government|washington dc|us federal reserve)\b/ },
    { value: 'canada', label: 'Canada', area: 'north-america', pattern: /\b(?:canada|canadian|ottawa)\b/ },
    { value: 'united-kingdom', label: 'United Kingdom', area: 'europe', pattern: /\b(?:united kingdom|britain|british|england|scotland|wales|northern ireland|uk|u k|bank of england)\b/ },
    { value: 'european-union', label: 'European Union', area: 'europe', pattern: /\b(?:european union|eu|eurozone|european commission|european central bank)\b/ },
    { value: 'australia', label: 'Australia', area: 'oceania', pattern: /\b(?:australia|australian|canberra|rba)\b/ },
    { value: 'japan', label: 'Japan', area: 'east-asia', pattern: /\b(?:japan|japanese|tokyo|bank of japan)\b/ },
    { value: 'china', label: 'China', area: 'east-asia', pattern: /\b(?:china|chinese|beijing|shenzhen)\b/ },
    { value: 'south-asia', label: 'South Asia', continent: 'asia', pattern: /\b(?:south asia|pakistan|bangladesh|nepal|bhutan|sri lanka|maldives|afghanistan)\b/ },
    { value: 'east-asia', label: 'East Asia', continent: 'asia', pattern: /\b(?:east asia|south korea|north korea|korean peninsula|taiwan|mongolia)\b/ },
    { value: 'southeast-asia', label: 'Southeast Asia', continent: 'asia', pattern: /\b(?:southeast asia|south east asia|asean|singapore|malaysia|indonesia|vietnam|thailand|philippines|myanmar|cambodia|laos|brunei|timor leste)\b/ },
    { value: 'asia', label: 'Asia', pattern: /\basia(?: pacific)?\b/ },
    { value: 'europe', label: 'Europe', pattern: /\b(?:europe|france|germany|italy|spain|portugal|netherlands|poland|norway|sweden|finland|greece|belgium|ukraine|switzerland)\b/ },
    { value: 'north-america', label: 'North America', continent: 'americas', pattern: /\b(?:north america|mexico)\b/ },
    { value: 'latin-america', label: 'Latin America and Caribbean', continent: 'americas', pattern: /\b(?:latin america|south america|central america|caribbean|brazil|argentina|chile|colombia|peru|ecuador|venezuela)\b/ },
    { value: 'americas', label: 'Americas', pattern: /\bamericas\b/ },
    { value: 'middle-east', label: 'Middle East', pattern: /\b(?:middle east|iran|iraq|saudi arabia|united arab emirates|qatar|kuwait|oman|israel|palestine|gaza|jordan|syria|yemen|lebanon)\b/ },
    { value: 'africa', label: 'Africa', pattern: /\b(?:africa|african union|nigeria|kenya|egypt|ghana|ethiopia|sudan|morocco|tunisia|senegal)\b/ },
    { value: 'oceania', label: 'Oceania', pattern: /\b(?:oceania|new zealand|pacific islands|fiji|papua new guinea)\b/ }
  ];

  const household = [
    { value: 'housing', label: 'Housing and rent', pattern: /\b(?:housing|rents?|rental costs?|mortgages?|evictions?|home loans?|home prices?)\b/ },
    { value: 'food', label: 'Groceries and food prices', pattern: /\b(?:food prices?|food costs?|food (?:supply|inflation|security)|grocer(?:y|ies)|household food|grain prices?)\b/ },
    { value: 'utilities', label: 'Power and fuel bills', pattern: /\b(?:electricity (?:prices?|bills?|rates?)|utility bills?|energy (?:prices?|bills?|costs?)|petrol prices?|gas (?:prices?|bills?)|fuel (?:prices?|costs?)|power tariffs?)\b/ },
    { value: 'borrowing', label: 'Borrowing and interest rates', pattern: /\b(?:mortgage rates?|interest rates?|policy rates?|rate cuts?|rate hikes?|borrowing costs?|lending rates?)\b/ },
    { value: 'living-costs', label: 'Cost of living and taxes', pattern: /\b(?:cost of living|consumer prices?|inflation|consumer price index|sales tax|income tax|tax (?:credits?|rises?|cuts?|relief|thresholds?))\b/ }
  ];

  const topics = [
    { value: 'jobs', label: 'Jobs and wages', pattern: /\b(?:jobs|employment|unemployment|jobless|layoffs?|redundan(?:cy|cies)|wages?|minimum wage|worker rights|labou?r market|job market)\b/ },
    { value: 'education', label: 'Education and training', pattern: /\b(?:student loans?|student grants?|tuition|university fees|school funding|education (?:funding|policy|costs?|reforms?)|apprenticeships?|vocational training|childcare|child care)\b/ },
    { value: 'health', label: 'Healthcare and care services', pattern: /\b(?:healthcare|health care|health insurance|medicine prices?|drug costs?|public health|hospitals?|vaccin(?:es?|ation)|care services|elder care)\b/ },
    { value: 'transport', label: 'Transport and essential services', pattern: /\b(?:public transport|trains?|railway|rail services|bullet train|transit fares?|transport fares?|power cuts?|power outages?|water supply|broadband access)\b/ },
    { value: 'benefits', label: 'Benefits and retirement', pattern: /\b(?:pensions?|social security|disability benefits?|public benefits?|food assistance|unemployment benefits?|retirement (?:income|savings)|family benefits?)\b/ },
    { value: 'rights', label: 'Rights, visas and consumer protection', pattern: /\b(?:consumer rights|consumer protection|labou?r rights|worker rights|work visas?|student visas?|immigration rules|public benefits?|data privacy|data breach)\b/ },
    { value: 'weather', label: 'Climate and public safety', pattern: /\b(?:extreme heat|heat waves?|heatwaves?|wildfires?|flood(?:s|ing)?|cyclones?|hurricanes?|drought|air pollution|evacuat(?:ion|ions|e)|emergency warnings?|flood alerts?)\b/ }
  ];

  const stages = [
    { value: 'student', label: 'Studying', topics: ['education', 'jobs'] },
    { value: 'early-career', label: 'Starting a career', topics: ['jobs', 'education', 'housing'] },
    { value: 'working', label: 'Working or looking for work', topics: ['jobs', 'transport', 'living-costs'] },
    { value: 'caregiver', label: 'Parent or caregiver', topics: ['education', 'health', 'benefits'] },
    { value: 'retired', label: 'Preparing for retirement or retired', topics: ['benefits', 'health', 'living-costs'] }
  ];

  const definitions = new Map([...household, ...topics].map(item => [item.value, item]));
  const placeById = new Map(places.map(place => [place.value, place]));
  const countryIds = new Map([['IN', 'india'], ['US', 'united-states'], ['CA', 'canada'], ['GB', 'united-kingdom'],
    ['UK', 'united-kingdom'], ['EU', 'european-union'], ['AU', 'australia'], ['JP', 'japan'], ['CN', 'china']]);
  const toOptions = items => Object.freeze(items.map(({ value, label }) => Object.freeze({ value, label })));
  const normalize = text => typeof text === 'string' ? text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';
  const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/;

  function ancestors(place) {
    const area = placeById.get(place?.area);
    return [place?.country, place?.area, place?.continent, area?.continent].filter(Boolean);
  }

  function geographicMatch(place, article, nameText) {
    if (!place) return { points: 0 };
    const names = Array.isArray(article.countries) ? article.countries.filter(name => typeof name === 'string') : [];
    const taggedIds = new Set(names.map(name => countryIds.get(name.trim().toUpperCase())).filter(Boolean));
    const labeledRegion = normalize(article.region);
    const nameHints = [nameText, ...names.map(normalize)].join(' ');
    const tags = places.filter(item => taggedIds.has(item.value) || item.pattern.test(labeledRegion) || item.pattern.test(nameHints));
    const placeFamily = ancestors(place);
    if (tags.some(tag => tag.value === place.value || ancestors(tag).includes(place.value))) {
      return { points: 14, reason: `Location match: ${place.label}` };
    }
    const widerRegion = tags.find(tag => placeFamily.includes(tag.value));
    const elsewhere = tags.some(tag => !placeFamily.includes(tag.value));
    if (widerRegion && !elsewhere) {
      return { points: 5, reason: `Wider ${widerRegion.label} coverage` };
    }
    const worldwide = /\b(?:global|worldwide|international)\b/.test(normalize(article.title));
    return { points: 0, elsewhere: elsewhere && !worldwide };
  }

  function matchedTopics(article, profile, published) {
    const title = normalize(article.title);
    const keywords = normalize(Array.isArray(article.keywords) ? article.keywords.join(' ') : article.keywords);
    const summary = published ? normalize(article.summary) : '';
    const preferences = new Map();
    const stage = stages.find(item => item.value === profile.lifeStage);
    for (const id of stage?.topics || []) preferences.set(id, { weight: 8, label: 'Life stage' });
    for (const id of Array.isArray(profile.budgetConcerns) ? profile.budgetConcerns : []) {
      if (household.some(item => item.value === id)) preferences.set(id, { weight: 17, label: 'Budget concern' });
    }
    for (const id of Array.isArray(profile.issues) ? profile.issues : []) {
      if (topics.some(item => item.value === id)) preferences.set(id, { weight: 18, label: 'Selected issue' });
    }
    const matches = [];
    for (const [id, preference] of preferences) {
      const topic = definitions.get(id);
      const inTitle = topic.pattern.test(title);
      if (inTitle || topic.pattern.test(summary) || topic.pattern.test(keywords)) {
        matches.push({ points: preference.weight - (inTitle ? 0 : 3), reason: `${preference.label}: ${topic.label}` });
      }
    }
    return { matches, hasPublicSignal: [...definitions.values()].some(topic => topic.pattern.test(title) || topic.pattern.test(summary)) };
  }

  function rank(articles, profile = {}, { now = Date.now(), limit = 4 } = {}) {
    const current = Number(now);
    if (!Array.isArray(articles) || !Number.isFinite(current) || !profile) return [];
    const cap = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, 12)) : 4;
    const place = placeById.get(profile.region);
    const results = [];
    for (const article of articles.slice(0, 250)) {
      if (!article || typeof article.id !== 'string' || !ID.test(article.id) || !normalize(article.title)
        || !PUBLIC_TOPICS.has(normalize(article.category)) || article.editorialExcluded || article.retracted || article.metadata?.editorialExcluded) continue;
      const age = current - Date.parse(article.publishedAt);
      if (!Number.isFinite(age) || age < 0 || age > MAX_AGE) continue;
      const reviewed = article.source?.basis === 'article' && REVIEWED_BASES.has(article.digestBasis);
      const nameText = normalize([article.title, Array.isArray(article.keywords) ? article.keywords.join(' ') : article.keywords].join(' '));
      const geo = geographicMatch(place, article, nameText);
      const { matches, hasPublicSignal } = matchedTopics(article, profile, reviewed);
      // An article needs a chosen topic or a concrete public issue in the selected region.
      // A geographically different domestic policy report is not a local match.
      if (geo.elsewhere || (!matches.length && !(geo.points && hasPublicSignal))) continue;
      const details = matches.sort((a, b) => b.points - a.points).slice(0, 3);
      const evidence = reviewed ? (INSPECTABLE_BASES.has(article.digestBasis) ? 5 : 2) : 0;
      const recency = Math.max(0, 4 - Math.floor(age / DAY));
      const reasons = [...details.map(item => item.reason), geo.reason].filter(Boolean);
      const score = details.reduce((sum, item) => sum + item.points, geo.points + evidence + recency);
      results.push({ article, score, reasons });
    }
    results.sort((a, b) => b.score - a.score || Date.parse(b.article.publishedAt) - Date.parse(a.article.publishedAt)
      || (a.article.id < b.article.id ? -1 : a.article.id > b.article.id ? 1 : 0));
    const seen = new Set();
    return results.filter(({ article }) => {
      const key = normalize(article.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, cap);
  }

  globalThis.ThreadNewsImpactRank = Object.freeze({
    regions: toOptions(places), lifeStages: toOptions(stages), budgetConcerns: toOptions(household), issues: toOptions(topics), rank
  });
})();
