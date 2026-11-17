const STOP = new Set(('the and what when how why who where which are was were has have had did does can could would should about into this that from with for will tell show give me of in a an it is to on at latest recent new changed change last please compare versus between since update updates today yesterday news headline headlines story stories happening briefing daily top now current happened around world globally explain overview summary summarize').split(' '));
const MODELS = { reranker: '@cf/baai/bge-reranker-base' };
const TOPICS = [
  ['inflation', 'cpi', 'hicp', 'consumer price index', 'cost of living', 'consumer prices'],
  ['gdp', 'gross domestic product', 'economic output', 'economic growth'],
  ['unemployment', 'jobless', 'joblessness', 'unemployment rate'],
  ['ceasefire', 'truce', 'cease-fire', 'cessation of hostilities'],
  ['interest rates', 'policy rate', 'benchmark rate', 'borrowing costs'],
  ['tariff', 'tariffs', 'import duties', 'customs duties'],
  ['bullet train', 'high-speed rail', 'high speed rail', 'shinkansen']
];
const DAY = 86400000;
const SHORTLIST_LIMIT = 16;
const CONTEXT_LIMIT = 9;

export const words = value => (String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]{2,}/g) || []);
const stem = word => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
const phrase = value => words(value).map(stem).join(' ');

export function questionFeatures(question) {
  const normalized = ` ${phrase(question)} `;
  const topics = TOPICS.map(group => [...new Set(group.map(phrase))])
    .filter(group => group.some(term => normalized.includes(` ${term} `))).slice(0, 3);
  const topicWords = new Set(topics.flatMap(group => group.filter(term => normalized.includes(` ${term} `)).flatMap(term => term.split(' '))));
  const groups = [
    ...new Set(words(question).filter(word => !STOP.has(word)).map(stem).filter(word => !topicWords.has(word)))
  ].slice(0, Math.max(0, 10 - topics.length)).map(term => [term]);
  return {
    groups: [...groups, ...topics],
    recent: /\b(latest|recent|current|now|new|today|yesterday|changed|happening|daily|updates?)\b/i.test(question),
    timeline: /\b(history|timeline|started|began|origins|chronology)\b/i.test(question),
    years: new Set(question.match(/\b(?:19|20)\d\d\b/g) || [])
  };
}

export function matches(value, groups) {
  const text = ` ${phrase(value)} `;
  return groups.filter(group => group.some(term => text.includes(` ${term} `))).length;
}

export function relevantPassage(value, groups, max = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max || !groups.length) return text.slice(0, max);
  const sentences = text.split(/(?<=[.!?])\s+/);
  const ranking = sentences.map((sentence, index) => ({ sentence, index, hits: matches(sentence, groups) }));
  ranking.sort((a, b) => b.hits - a.hits || a.index - b.index);
  const best = ranking[0];
  const adjacent = [best.sentence, sentences[best.index + 1]].filter(Boolean).join(' ');
  return (adjacent.length <= max ? adjacent : best.sentence).slice(0, max);
}

export function dateRelevance(date, features, now) {
  if (features.years.has(date?.slice(0, 4))) return 24;
  const age = (now.getTime() - Date.parse(date)) / DAY;
  return features.recent && Number.isFinite(age) && age >= 0 ? Math.max(0, 12 - 2 * age) : 0;
}

function compare(a, b) {
  return b.rank - a.rank || String(b.item.date).localeCompare(String(a.item.date))
    || a.item.title.localeCompare(b.item.title);
}

function duplicate(a, b) {
  if (a.kind !== b.kind || a.date !== b.date) return false;
  const sameTitle = phrase(a.title) === phrase(b.title);
  return sameTitle && (a.href === b.href || a.links[0]?.publisher === b.links[0]?.publisher
    || a.links.some(link => b.links.some(other => link.url === other.url)));
}

export function shortlistEvidence(candidates) {
  const selected = [];
  for (const candidate of [...candidates].sort(compare)) {
    if (selected.some(({ item }) => duplicate(item, candidate.item))) continue;
    selected.push(candidate);
    if (selected.length === SHORTLIST_LIMIT) break;
  }
  return selected;
}

export function selectEvidence(candidates) {
  const selected = [], deferred = [], publisherCounts = new Map();
  for (const { item } of candidates) {
    const publisher = item.links[0]?.publisher?.toLowerCase();
    const count = publisherCounts.get(publisher) || 0;
    const allowMultipleRecords = item.kind.startsWith('Timeline') || item.kind === 'Official economic data';
    if (!allowMultipleRecords && publisher && count >= 3) deferred.push(item);
    else {
      if (!allowMultipleRecords && publisher) publisherCounts.set(publisher, count + 1);
      selected.push(item);
    }
    if (selected.length === CONTEXT_LIMIT) break;
  }
  return [...selected, ...deferred].slice(0, CONTEXT_LIMIT).map((item, index) => ({ ...item, id: index + 1 }));
}

export async function rerankEvidence(ai, question, candidates) {
  if (typeof ai?.run !== 'function' || candidates.length < 2) {
    return { candidates, rankedByModel: false };
  }
  let timeout;
  try {
    const contexts = candidates.map(({ item }) => ({
      text: [item.kind, item.date, item.title, item.excerpt].join('\n')
    }));
    const result = await Promise.race([
      ai.run(MODELS.reranker, { query: question, contexts, top_k: contexts.length }),
      new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1800); })
    ]);
    if (!Array.isArray(result?.response)) return { candidates, rankedByModel: false };
    const modelRanks = new Map();
    for (const entry of [...result.response].sort((a, b) => (b?.score ?? -Infinity) - (a?.score ?? -Infinity))) {
      if (!Number.isSafeInteger(entry?.id) || entry.id < 0 || entry.id >= candidates.length || !Number.isFinite(entry.score) || modelRanks.has(entry.id)) continue;
      modelRanks.set(entry.id, modelRanks.size);
    }
    if (modelRanks.size !== candidates.length) return { candidates, rankedByModel: false };
    // Reciprocal rank fusion uses ordering, so lexical and model scores do not
    // need to share a scale. Either ranking can lift a passage into the context.
    const combined = candidates.map((candidate, index) => ({
      candidate,
      rank: 1 / (6 + index) + 1.1 / (6 + modelRanks.get(index))
    }));
    combined.sort((a, b) => b.rank - a.rank);
    return { candidates: combined.map(({ candidate }) => candidate), rankedByModel: true };
  } catch {
    return { candidates, rankedByModel: false };
  } finally {
    clearTimeout(timeout);
  }
}
