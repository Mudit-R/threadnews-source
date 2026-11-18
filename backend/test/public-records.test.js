import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArticles,buildTimelines,normalizeDocument } from '../scripts/sync-public-records.mjs';
import '../../web/news-content.js';

const abstract='The agency proposed to revise the rules that apply to providers serving the affected households. It explained that the new schedule would allow providers to prepare and give customers earlier notice of the changes. Public comments addressed implementation dates, reporting requirements, and how the notice would be delivered.';
const record=(number,publication,type,overrides={})=>normalizeDocument({
  document_number:`2026-${number}`,title:'Household service notice requirements',abstract,type,publication_date:publication,
  html_url:`https://www.federalregister.gov/documents/2026/${number}`,
  pdf_url:`https://www.govinfo.gov/content/pkg/FR-${publication}/pdf/2026-${number}.pdf`,
  agencies:[{name:'Federal Communications Commission'}],regulation_id_numbers:['3060-AA38'],...overrides
},'2026-11-18');

test('public record timelines require matching proposal and rule dates and preserve effective-date qualifiers', async () => {
  const proposal=record('12345','2026-01-01','Proposed Rule');
  const rule=record('24012','2026-09-01','Rule',{effective_on:'2026-10-01'});
  const unrelated=record('23111','2026-10-09','Rule',{title:'Unrelated agency action'});
  const {events,ids}=await buildTimelines([proposal,rule,unrelated],'2026-11-18',100);
  assert.equal(events.length,1);
  assert.deepEqual(events[0].milestones.map(moment=>moment.dateType),['publication','publication','event']);
  assert.equal(events[0].milestones[2].title,'Stated effective date');
  assert(!ids.has(unrelated.id));
  const [article]=buildArticles([rule],ids,'2026-08-01',10);
  const preview=globalThis.ThreadNewsContent.displayQuickBrief(article);
  assert.equal(preview,article.summary);
  assert(preview.split(/\s+/).length>=50 && preview.split(/\s+/).length<=100);
  assert.equal(article.eventId,events[0].id);
  assert.equal(globalThis.ThreadNewsContent.displayQuickBrief({title:'Only a headline',summary:'Speculative text',digestBasis:'headline-only'}),'');
});
