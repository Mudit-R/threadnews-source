import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context = {};
runInNewContext(readFileSync(new URL('../../web/impact-rank.js', import.meta.url), 'utf8'), context);
const { rank, regions, lifeStages, budgetConcerns, issues } = context.ThreadNewsImpactRank;
const now = Date.parse('2026-11-17T12:00:00Z');
const date = daysAgo => new Date(now - daysAgo * 86400000).toISOString();
const report = (id, title, extra = {}) => ({ id, title, category: 'Economy', region: 'Global', publishedAt: date(1), ...extra });
const ids = results => Array.from(results, result => result.article.id);

test('the ranker understands published country codes and broader region labels', () => {
  const articles = [
    report('abroad', 'Tokyo revisits mortgage rates', { region: 'Asia' }),
    report('wide', 'Asia publishes new consumer price readings', { region: 'Asia' }),
    report('local', 'Interest rates change after the policy decision', { countries: ['IN'] }),
    report('city', 'Mumbai reviews housing rules', { category: 'Politics' }),
    report('unrelated', 'India announces a summit schedule', { category: 'World' })
  ];
  assert.deepEqual(ids(rank(articles, { region: 'india' }, { now })), ['city', 'local', 'wide']);
  const selected = rank(articles, { region: 'mumbai', budgetConcerns: ['housing'] }, { now });
  assert.equal(selected[0].article.id, 'city');
  assert.ok(selected[0].reasons.includes('Location match: Mumbai'));
  assert.deepEqual(ids(rank([articles[0]], { region: 'india', budgetConcerns: ['borrowing'] }, { now })), []);
});

test('explicit choices outweigh overlapping stage suggestions and unverified summaries cannot match a topic', () => {
  const articles = [
    report('costs', 'Officials release a new update', { summary: 'The student loan rules change.', source: { basis: 'headline' }, digestBasis: 'headline-only' }),
    report('verified', 'Education department issues a bulletin', { summary: 'The student loan rules change.', source: { basis: 'article' }, digestBasis: 'article-reviewed' }),
    report('wages', 'Minimum wage increase goes into effect', { category: 'Politics' }),
    report('benefits', 'Retirement benefits office alters its intake process', { category: 'Politics' })
  ];
  const result = rank(articles, { lifeStage: 'student', issues: ['jobs'] }, { now });
  assert.deepEqual(ids(result), ['wages', 'verified']);
  assert.deepEqual(Array.from(result[0].reasons), ['Selected issue: Jobs and wages']);
  assert.ok(result[1].reasons.includes('Life stage: Education and training'));
  assert.deepEqual(ids(rank(articles, { lifeStage: 'pretend-stage', issues: ['unknown-topic'] }, { now })), []);
});

test('the model filters dates and exclusions and resolves tied and duplicate stories consistently', () => {
  const articles = [
    report('duplicate-b', 'Rent increases'),
    report('stale', 'Rent support expands', { publishedAt: date(8) }),
    report('duplicate-a', 'Rent increases'),
    report('late', 'Rent prices are forecast to rise', { publishedAt: date(-1) }),
    report('different', 'Housing policy changes'),
    report('hidden', 'Housing scheme opens', { metadata: { editorialExcluded: true } }),
    report('sport', 'Mortgage rate discussion on a sports broadcast', { category: 'Sports' }),
    report('retracted', 'Rent is under discussion', { retracted: true })
  ];
  const profile = { budgetConcerns: ['housing'] };
  assert.deepEqual(ids(rank(articles, profile, { now })), ['different', 'duplicate-a']);
  assert.deepEqual(ids(rank(articles.toReversed(), profile, { now, limit: 1 })), ['different']);
  assert.deepEqual(ids(rank(articles, {}, { now })), []);
  for (const list of [regions, lifeStages, budgetConcerns, issues]) {
    assert.ok(list.length && list.every(option => option.value && option.label));
  }
});
