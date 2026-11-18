import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainText, sha256 } from '../src/feed.js';
import { fetchJSON } from '../src/upstream.js';
import { postIngest } from './collect-news.mjs';

const origin = 'https://www.federalregister.gov';
const endpoint = origin + '/api/v1/documents.json';
const apiGuide = origin + '/developers/documentation/api/v1';
const fields = ['document_number','title','abstract','type','publication_date','html_url','pdf_url','regulation_id_numbers','agencies','effective_on'];
const day = 86400000;
const pageSize = 160;
const issuePattern = /\b(?:airworthiness directives?|airspace (?:designation|amendment|revocation)|safety zone[s]?[;,]|special local regulations?|drawbridge operations?|regulated navigation area|tolerance[s]? for residues|fisheries of the exclusive economic zone|list of approved|extension of comment period|correction[s]?$)/i;
const routineTimeline = /\b(?:class [b-e] airspace|federal airways|air traffic service routes?|commercial space transportation insurance|jet routes?|bridge regulations?|danger zones?)\b/i;

const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const isoDay = value => new Date(value).toISOString().slice(0,10);
const wordCount = value => value.trim().split(/\s+/).length;
const sentenceSegmenter = new Intl.Segmenter('en', { granularity:'sentence' });
const identity = value => /^(?:C\d-)?\d{4}-\d{4,8}$/.test(value || '');
const rinOK = value => /^\d{4}-[A-Z0-9]{4}$/.test(value || '');
const onHost = (url, host) => {
  try { const value = new URL(url); return value.protocol === 'https:' && value.hostname === host && !value.username && !value.password && !value.port; }
  catch { return false; }
};

function categoryFor(record) {
  const agency = record.agencies.map(item => item.name).join(' ');
  const title = record.title;
  if (/health|food and drug|medicare|consumer product safety/i.test(agency)) return 'Health';
  if (/energy|environmental protection|nuclear regulatory/i.test(agency)) return 'Energy';
  if (/transportation|railroad|communications commission|highway/i.test(agency)) return 'Infrastructure';
  if (/international trade|customs|trade representative/i.test(agency) || /\b(?:tariff|import duties|export controls)\b/i.test(title)) return 'Trade';
  if (/securities|financial protection|federal reserve|deposit insurance|comptroller|credit union/i.test(agency)) return 'Finance';
  if (/treasury|internal revenue|labor department|agriculture|small business/i.test(agency)) return 'Economy';
  return 'Politics';
}

export function normalizeDocument(value, through) {
  if (!identity(value?.document_number) || value.document_number.startsWith('C') || !['Rule','Proposed Rule'].includes(value.type)
    || !date(value.publication_date) || value.publication_date > through || !onHost(value.html_url, 'www.federalregister.gov')
    || !Array.isArray(value.agencies) || !Array.isArray(value.regulation_id_numbers)) return null;
  const title = plainText(value.title, 490);
  const abstract = plainText(value.abstract, 3000);
  const authors = value.agencies.map(item => plainText(item?.name, 130)).filter(Boolean);
  if (!title || !abstract || !authors.length || issuePattern.test(title)) return null;
  const record = {
    id: value.document_number, title, abstract, agency: authors.at(-1), agencies: value.agencies,
    date: value.publication_date, type: value.type, url: value.html_url,
    pdf: onHost(value.pdf_url, 'www.govinfo.gov') ? value.pdf_url : null,
    rins: [...new Set(value.regulation_id_numbers.filter(rinOK))],
    ...(date(value.effective_on) ? { effective: value.effective_on } : {})
  };
  return { ...record, category: categoryFor(record) };
}

export function makeBrief(record, { min = 50, max = 100 } = {}) {
  const opener = `The Federal Register published this ${record.type.toLowerCase()} from ${record.agency} on ${record.date}.`;
  const effective = record.type === 'Rule' && record.effective ? ` The rule lists ${record.effective} as its effective date.` : '';
  const sentences = [...sentenceSegmenter.segment(record.abstract)].map(item => item.segment);
  let selected = '';
  for (const sentence of sentences) {
    const next = [selected, sentence.trim()].filter(Boolean).join(' ');
    if (wordCount(`${opener} ${next}${effective}`) > max) break;
    selected = next;
  }
  const brief = `${opener} ${selected}${effective}`;
  if (!selected || wordCount(selected) < 25 || wordCount(brief) < min) return '';
  return brief;
}

function topicKey(record, rin) {
  const name = record.title.normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/[^a-z0-9]+/g,' ').trim();
  return `${rin} | ${name}`;
}

function milestone(record, supplemental = false) {
  const type = record.type === 'Proposed Rule' ? 'Proposal published' : 'Rule published';
  return {
    date: supplemental ? record.effective : record.date,
    dateType: supplemental ? 'event' : 'publication',
    datePrecision: 'day',
    title: supplemental ? 'Stated effective date' : type,
    kind: 'Official record', key: true, tone: supplemental ? 'neutral' : 'development',
    summary: supplemental
      ? `The published rule listed ${record.effective} as its effective date. Check the agency record for later changes or court orders that could affect implementation.`
      : makeBrief(record, { min: 35 }) || `${record.agency} published ${record.type === 'Proposed Rule' ? 'a proposed rule' : 'a rule'} titled “${record.title}.”`,
    sources: [{ publisher: 'Federal Register', type: 'Primary record', title: record.title, url: record.url, published: record.date },
      ...(record.pdf ? [{ publisher: 'U.S. Government Publishing Office', type: 'Official PDF', title: record.title, url: record.pdf, published: record.date }] : [])]
  };
}

export async function buildTimelines(records, through, limit, requireRecent) {
  const groups = new Map();
  for (const record of records) {
    if (routineTimeline.test(record.title)) continue;
    for (const rin of record.rins) {
      const key = topicKey(record, rin);
      if (!groups.has(key)) groups.set(key, { rin, documents: [] });
      groups.get(key).documents.push(record);
    }
  }
  const cases = [];
  for (const [key, { rin, documents }] of groups) {
    const ordered = [...new Map(documents.map(item => [item.id, item])).values()].sort((a,b) => a.date.localeCompare(b.date));
    const proposal = ordered.find(record => record.type === 'Proposed Rule');
    const final = ordered.findLast(record => record.type === 'Rule' && proposal && record.date > proposal.date);
    if (!final || new Set(ordered.map(item => item.date)).size < 2 || (requireRecent && final.date < requireRecent)) continue;
    const actions = [...new Map(ordered.map(item => [`${item.date}|${item.type}`,item])).values()];
    const moments = actions.map(item => milestone(item));
    if (final.date < final.effective && final.effective <= through && !moments.some(item => item.date === final.effective)) moments.push(milestone(final, true));
    moments.sort((a,b) => a.date.localeCompare(b.date));
    cases.push({ key, rin, proposal, final, moments, documents: ordered });
  }
  cases.sort((a,b) => Number(b.moments.length >= 3) - Number(a.moments.length >= 3) || b.final.date.localeCompare(a.final.date) || a.key.localeCompare(b.key));
  const seen = new Set();
  const events = [], ids = new Map();
  for (const item of cases) {
    if (events.length >= limit) break;
    const subject = item.key.split(' | ')[1];
    if (seen.has(subject)) continue;
    seen.add(subject);
    const id = 'public-rule-' + (await sha256(item.key)).slice(0, 18);
    const { final, rin, moments } = item;
    const coverageEnd = moments.at(-1).date;
    events.push({ id, title: final.title, shortTitle: final.title.slice(0,110), category:final.category, region:'North America',
      location:'United States', recordType:'rulemaking', status:'Official record',
      description:`Source history for ${final.agency} rulemaking ${rin}, from its proposal to the published rule and any documented effective date.`,
      context:'The proposal and rule are dated by publication. This timeline groups records sharing the same regulation identifier and subject. Check the linked agency records for subsequent changes or court orders.',
      watch:'The agency can issue corrections, delays or further rules. The linked register and official PDFs provide the original text.',
      limitation:'This chronology covers matching Federal Register records from 2022 onward. It does not determine the rule’s current legal effect.',
      keywords:[rin, final.agency], coverageEnd, milestones:moments,
      sourcePolicy:apiGuide });
    for (const doc of item.documents) if (!ids.has(doc.id)) ids.set(doc.id,id);
  }
  return { events, ids };
}

export function buildArticles(records, ids, from, limit) {
  const articles = [];
  const unique = new Set();
  for (const record of records.sort((a,b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))) {
    if (articles.length >= limit) break;
    if (unique.has(record.id) || record.date < from) continue;
    unique.add(record.id);
    const summary = makeBrief(record);
    if (!summary) continue;
    articles.push({ id:`federal-register-${record.id}`, title:record.title, originalHeadline:record.title, summary,
      digestBasis:'official-primary-source', category:record.category, region:'North America', countries:['US'],
      keywords:[...record.rins,record.agency], publishedAt:record.date,
      source:{ publisher:'Federal Register', sourceType:'Official source', basis:'article', url:record.url,
        publisherArticleUrl:record.url, dateBasis:'day', summaryMethod:'agency-abstract', reusePolicyUrl:apiGuide,
        freeAccessDisclosure:'Brief contains a portion of the published U.S. agency abstract. The complete Federal Register publication is available free.' },
      officialSources:record.pdf ? [{ publisher:'U.S. Government Publishing Office', sourceType:'Official source', url:record.pdf, title:record.title }] : [],
      ...(ids.has(record.id) ? { eventId:ids.get(record.id) } : {}) });
  }
  return articles;
}

function sourceQuery(from, through, page, rin) {
  const request = new URL(endpoint);
  request.search = new URLSearchParams({ per_page:String(pageSize), page:String(page), order:'newest',
    'conditions[publication_date][gte]':from, 'conditions[publication_date][lte]':through });
  for (const kind of ['RULE','PRORULE']) request.searchParams.append('conditions[type][]', kind);
  for (const field of fields) request.searchParams.append('fields[]', field);
  if (rin) request.searchParams.set('conditions[regulation_id_number]',rin);
  return request;
}

async function fetchWindow(from, through, fetchImpl, rin) {
  const result = [];
  for (let page = 1; page <= 16; page++) {
    let payload;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { payload = await fetchJSON(sourceQuery(from, through, page, rin), { fetchImpl, maxBytes:2*1024*1024 }); break; }
      catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1))); }
    }
    if (!Array.isArray(payload?.results)) throw Error('Invalid Federal Register response');
    result.push(...payload.results.map(item => normalizeDocument(item, through)).filter(Boolean));
    if (!payload.next_page_url) return result;
  }
  throw Error('Federal Register paging exceeded its expected window');
}

function windows(from, through, days) {
  const end = Date.parse(through), out = [];
  for (let start = Date.parse(from); start <= end; start += days * day) {
    out.push([isoDay(start),isoDay(Math.min(end,start + (days - 1) * day))]);
  }
  return out;
}

async function fetchRecords(from, through) {
  const parts = windows(from, through, 70), out = [];
  // Each window is paginated separately. A failed page aborts the snapshot
  // so an incomplete history cannot overwrite a complete timeline.
  for (let index = 0; index < parts.length; index += 3) {
    const part = await Promise.all(parts.slice(index,index+3).map(([first,last]) => fetchWindow(first,last,fetch)));
    out.push(...part.flat());
  }
  return out;
}

function batches(rows, size) {
  return Array.from({ length:Math.ceil(rows.length / size) }, (_, index) => rows.slice(index*size,(index+1)*size));
}

async function publish(snapshot) {
  let events = 0, accepted = 0, skipped = 0;
  for (const batch of batches(snapshot.events, 10)) {
    const result = await postIngest({ events:batch, feedId:'federal-register-timelines', mode:'automatic' });
    events += result.events?.accepted || 0;
  }
  for (const batch of batches(snapshot.articles.map(item=>({ ...item, source:{...item.source,dateBasis:'day'} })), 45)) {
    const result = await postIngest({ articles:batch, feedId:'federal-register', mode:'automatic' });
    accepted += result.articles?.accepted || 0;
    skipped += result.articles?.attributionConflicts || 0;
  }
  const at=new Date().toISOString();
  await postIngest({ articles:[], feedId:'federal-register', mode:'automatic', feedState:{lastAttemptAt:at,lastSuccessAt:at,itemCount:Math.min(accepted,100)} });
  console.log(JSON.stringify({ events, accepted, preservedExistingAttribution:skipped }));
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = prefix => args.find(item => item.startsWith(prefix))?.slice(prefix.length);
  const saved = getArg('--input=');
  if (saved) { await publish(JSON.parse(await readFile(saved,'utf8'))); return; }
  const bootstrap = args.includes('--bootstrap');
  const through = isoDay(Date.now());
  const historyStart = '2022-01-01';
  const from = bootstrap ? historyStart : isoDay(Date.now() - 21*day);
  const records = await fetchRecords(from,through);
  let history = records;
  if (!bootstrap) {
    const recent = records.filter(record => record.type === 'Rule').sort((a,b) => b.date.localeCompare(a.date));
    const identifiers = [...new Set(recent.flatMap(record => record.rins))].slice(0,12);
    history = [];
    for (let index=0;index<identifiers.length;index+=3) {
      const scans = await Promise.allSettled(identifiers.slice(index,index+3).map(rin => fetchWindow(historyStart,through,fetch,rin)));
      for (const scan of scans) {
        if (scan.status === 'fulfilled') history.push(...scan.value);
        else console.warn('Skipped a rule history after an upstream error');
      }
    }
  }
  const { events, ids } = await buildTimelines(history,through,bootstrap ? 100 : 12,bootstrap ? null : from);
  const articles = buildArticles(records,ids,isoDay(Date.now() - (bootstrap ? 117 : 21)*day),bootstrap ? 2200 : 250);
  if (!articles.length || (bootstrap && events.length !== 100)) throw Error(`Insufficient verified data for this run. ${articles.length} briefs and ${events.length} timelines.`);
  const output = { through, articles, events };
  const target = getArg('--snapshot=');
  if (target) await writeFile(target,JSON.stringify(output));
  console.log(JSON.stringify({ through, eligibleSourceDocuments:records.length, articles:articles.length, events:events.length,
    threeOrMore:events.filter(event => event.milestones.length >= 3).length }));
  if (args.includes('--publish')) await publish(output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode=1; });
}
