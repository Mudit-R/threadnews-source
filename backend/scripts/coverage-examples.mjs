import { readFileSync } from 'node:fs';
import { coverageFeatures, coverageHeadline, COVERAGE_FEATURES, HOUR } from '../src/coverage-features.js';

const { articles, examples } = JSON.parse(readFileSync(
  new URL('../test/fixtures/coverage-pairs.json', import.meta.url), 'utf8'
));
const byId = new Map(articles.map(article => [article.id, article]));
if (byId.size !== articles.length) throw new Error('Repeated coverage article ID');

console.log(JSON.stringify({
  features: COVERAGE_FEATURES,
  examples: examples.map(({ leftId, rightId, ...example }) => {
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    if (!left || !right) throw new Error('A coverage pair references a missing article');
    const hours = Math.abs(Date.parse(left.publishedAt) - Date.parse(right.publishedAt)) / HOUR;
    const match = coverageFeatures(coverageHeadline(left.title), coverageHeadline(right.title), hours);
    const features = match ? COVERAGE_FEATURES.map(name => match.features[name]) : null;
    const baseline = Boolean(match && match.features.jaccard >= 0.42 && match.features.containment >= 0.75);
    return { ...example, left, right, features, baseline };
  })
}));
