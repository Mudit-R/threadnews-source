import test from 'node:test';
import assert from 'node:assert/strict';
import '../../web/article-ranker.js';
import { parseFeed } from '../src/feed.js';
import { refreshSourceSummaries } from '../src/source-summary.js';
import { FEEDS } from '../src/feeds.js';

const model = globalThis.ThreadNewsArticleRanker;
const item = (id, title, category) => ({ id, title, category, region:'Global' });

test('explicit votes transfer to unseen headlines and negative feedback lowers similar stories', () => {
  const history = [model.feedback(item('seen-rail','Passenger railway fares capped','Infrastructure'),1),
    model.feedback(item('seen-rates','Household loan rates rise','Economy'),0)];
  const candidates = [item('rates','Household policy rates fall','Economy'),
    item('rail','Passenger railway timetable expands','Infrastructure'),
    item('health','Hospital network launches health programme','Health')];
  assert.deepEqual(model.rank(candidates,history).map(row=>row.article.id), ['rail','health','rates']);
  assert.deepEqual(model.rank(candidates,[]).map(row=>row.article.id), ['rates','rail','health']);
});

test('scheduled inference can be disabled before touching sources, the D1 budget, or a provider', async () => {
  const never = () => assert.fail('Disabled task spent work');
  const result = await refreshSourceSummaries({ DB:{prepare:never}, SOURCE_SUMMARY_AI_ENABLED:'false', AI:{run:never} }, { fetchImpl:never, generate:never });
  assert.deepEqual(result,{ ok:true, skipped:'scheduled_ai_disabled' });
});

test('token-free parser retains only an opted-in first-party Atom synopsis', async () => {
  const now = new Date('2026-11-17T12:00:00Z');
  const feed = FEEDS.find(item=>item.id==='uk-transport');
  const entry = (id,host) => `<entry><title>New rail timetable ${id}</title><link href="https://${host}/government/news/rail-${id}"/><updated>2026-11-17T09:00:00Z</updated><summary type="html">The agency has announced a revised departure timetable for passengers.</summary><content>Full article text</content></entry>`;
  const xml = `<feed>${entry('internal','www.gov.uk')}${entry('external','publisher.example')}</feed>`;
  const [internal,external] = await parseFeed(xml,feed,now);
  assert.equal(internal.digestBasis,'feed-description');
  assert.equal(internal.summary,'The agency has announced a revised departure timetable for passengers.');
  assert.equal(external.digestBasis,'headline-only');
  assert.equal((await parseFeed(xml,{ ...feed, licensedFeedSummary:false },now))[0].digestBasis,'headline-only');
});
