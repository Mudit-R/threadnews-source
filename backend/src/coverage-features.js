export const COVERAGE_HOURS = 36;
export const HOUR = 3600000;

const STOP_WORDS = new Set(
  ('about after all amid an and are as at be because been before being but by can could do during for ' +
   'from had has have he how if in into is it its latest live may more my new news now of off on one only ' +
   'or other out over said say says should so that the their them then there these they this those through ' +
   'to today under up update updates was we were what when where which while who why will with would').split(' ')
);

export const COVERAGE_FEATURES = [
  'jaccard', 'containment', 'phraseOverlap', 'sharedTerms',
  'leadOverlap', 'proximity', 'numberConflict'
];

function overlap(left, right) {
  return [...left].filter(term => right.has(term));
}

export function coverageHeadline(title) {
  const words = (title.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
    .replace(/['’]s\b/g, '').match(/\p{N}+(?:\.\p{N}+)?|[\p{L}\p{N}]+/gu) || [])
    .filter(word => (word.length >= 2 || /^\d$/.test(word)) && !STOP_WORDS.has(word))
    .slice(0, 48);
  const stems = words.map(word => word.length > 4 && /[^siu]s$/.test(word) ? word.slice(0, -1) : word);
  const terms = new Map(stems.map((stem, index) => [stem, words[index]]));
  return {
    terms,
    phrases: new Set(stems.slice(1).map((word, index) => stems[index] + ' ' + word)),
    lead: new Set(stems.slice(0, 4)),
    numbers: new Set(words.filter(word => /^\d/.test(word))),
    wording: stems.join(' ')
  };
}

// This same feature extractor is used by the Worker and the offline trainer.
export function coverageFeatures(anchor, candidate, hours) {
  const shared = overlap(anchor.terms.keys(), candidate.terms);
  if (shared.length < 2 || !Number.isFinite(hours) || hours < 0 || hours > COVERAGE_HOURS) return null;
  const union = anchor.terms.size + candidate.terms.size - shared.length;
  const phraseTotal = anchor.phrases.size + candidate.phrases.size;
  const features = {
    jaccard: shared.length / union,
    containment: shared.length / Math.min(anchor.terms.size, candidate.terms.size),
    phraseOverlap: phraseTotal ? 2 * overlap(anchor.phrases, candidate.phrases).length / phraseTotal : 0,
    sharedTerms: Math.min(shared.length, 8) / 8,
    leadOverlap: overlap(anchor.lead, candidate.lead).length / Math.min(anchor.lead.size, candidate.lead.size),
    proximity: 1 - hours / COVERAGE_HOURS,
    numberConflict: Number(Boolean(anchor.numbers.size && candidate.numbers.size && !overlap(anchor.numbers, candidate.numbers).length))
  };
  return { features, terms: shared.map(key => anchor.terms.get(key)), similarWording: anchor.wording === candidate.wording };
}
