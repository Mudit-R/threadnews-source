/* Sparse logistic ranking trained from the reader's explicit feedback. */
(() => {
  const STOP = new Set('about after amid before breaking could from have into latest more news says some than that their them there these they this those through under were what when where which while will with would your'.split(' '));
  const size = 512;
  const limit = 48;
  const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  function words(value) {
    return [...new Set((normalize(value).match(/[\p{L}]{3,22}/gu) || []).filter(word => !STOP.has(word)))];
  }
  function bucket(key) {
    let hash = 2166136261;
    for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
    return (hash >>> 0) % size;
  }
  function terms(article) {
    return words(`${article.title || ''} ${Array.isArray(article.keywords) ? article.keywords.join(' ') : ''}`).slice(0, 20);
  }
  function vector(article) {
    const map = new Map();
    const add = (key, strength) => map.set(bucket(key), strength);
    if (article.category) add(`topic:${normalize(article.category)}`, 1.5);
    if (article.region && article.region !== 'Global') add(`region:${normalize(article.region)}`, 0.65);
    for (const word of terms(article)) add(`term:${word}`, 0.75);
    const norm = Math.hypot(...map.values()) || 1;
    return [...map].map(([i,value]) => [i,Math.round(value / norm * 1000) / 1000]);
  }
  function validFeedback(records) {
    if (!Array.isArray(records)) return [];
    return records.slice(-limit).filter(row => /^[A-Za-z0-9_.:-]{1,120}$/.test(row?.id || '')
      && [0,1].includes(row.label) && Array.isArray(row.features) && row.features.length <= 22
      && row.features.every(pair => Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0])
        && pair[0] >= 0 && pair[0] < size && Number.isFinite(pair[1]) && pair[1] > 0 && pair[1] <= 1));
  }
  const dot = (weights, vector) => vector.reduce((sum,[i,value]) => sum + weights[i] * value,0);
  function train(records) {
    const weights = new Float64Array(size);
    // Replay bounded examples so undoing or replacing a vote changes the model.
    for (let pass = 0; pass < 8; pass++) {
      for (const { features, label } of records) {
        const prediction = 1 / (1 + Math.exp(-dot(weights,features)));
        for (const [i,value] of features) weights[i] = 0.992 * weights[i] + 0.4 * (label - prediction) * value;
      }
    }
    return weights;
  }
  function feedback(article, label) {
    return { id: article.id, label, features: vector(article) };
  }
  function rank(articles, records) {
    const history = validFeedback(records);
    const seen = new Set(history.map(row => row.id));
    const weights = train(history);
    const candidates = articles.slice(0,160).filter(article => article?.id && article.title && !seen.has(article.id));
    const ranked = candidates.map((article,index) => {
      const score = dot(weights,vector(article));
      const topic = article.category && weights[bucket(`topic:${normalize(article.category)}`)] > 0.12 ? article.category : '';
      const matchingTerm = terms(article).find(word => weights[bucket(`term:${word}`)] > 0.15);
      return { article, score, reason: score > 0.1 && (topic || matchingTerm) ? `Matches your feedback on ${topic || matchingTerm}` : 'Explore a different story', index };
    }).sort((a,b) => b.score - a.score || a.index - b.index);
    // Keep a varied first screen before the reader has given any examples.
    if (!history.length) {
      const topics = new Set();
      const diverse = ranked.filter(({ article }) => !topics.has(article.category) && topics.add(article.category));
      return [...diverse,...ranked.filter(row => !diverse.includes(row))].slice(0,4);
    }
    return ranked.slice(0,4);
  }
  globalThis.ThreadNewsArticleRanker = Object.freeze({ feedback, rank, validFeedback, limit });
})();
