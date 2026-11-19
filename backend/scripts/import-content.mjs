import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isImpactNews } from '../src/policy.js';

// This explicit import backfills curated metadata; migrations never seed data.
// The source release imports published snapshots.
// Credentials stay in process memory and are never printed or written to disk.
export async function loadContent(root = new URL('../../web/', import.meta.url)) {
  const read = async (name, base = root, location = `web/${name}`) => {
    try { return JSON.parse((await readFile(new URL(name, base), 'utf8')).replace(/^\uFEFF/, '')); }
    catch { throw new Error(`Cannot read ${location}; generate the source JSON before importing.`); }
  };
  const [news, timelines, economy, releases] = await Promise.all([
    read('news-data.json'), read('timeline-data.json'), read('economy-data.json'),
    read('reviewed-official-releases-2026-11-19.json', new URL('../../research/', import.meta.url), 'research/reviewed-official-releases-2026-11-19.json')
  ]);
  const articles = Array.isArray(news) ? news : news.articles || news.items;
  const events = Array.isArray(timelines) ? timelines : timelines.events || timelines.stories;
  if (!Array.isArray(articles) || !Array.isArray(events) || !economy || !Array.isArray(economy.countries)) throw new Error('Content JSON has an unexpected shape.');
  if (events.some(event => !Array.isArray(event?.milestones) || event.milestones.length > 100)) throw new Error('Full timeline seed is incomplete or contains an invalid milestone list.');
  const combined=new Map([...articles, ...releases.articles].map(record=>[record.id,record]));
  return { articles: [...combined.values()].filter(isImpactNews), events, economy };
}
export function importBatches({ articles, events, economy }) {
  const batches = [], maxBytes = 1500 * 1024;
  const append = (key, records, count) => {
    let batch = [];
    for (const record of records) {
      if (batch.length && (batch.length >= count || Buffer.byteLength(JSON.stringify({ [key]: [...batch, record] })) > maxBytes)) { batches.push({ [key]: batch }); batch = []; }
      batch.push(record);
      if (Buffer.byteLength(JSON.stringify({ [key]: batch })) > maxBytes) throw new Error('A content record exceeds the import request size limit.');
    }
    if (batch.length) batches.push({ [key]: batch });
  };
  append('articles', articles, 25);
  append('events', events, 10);
  if (economy) {
    if (Buffer.byteLength(JSON.stringify({ economy })) > maxBytes) throw new Error('Economy document exceeds the import request size limit.');
    // Bootstrap only: a release must never overwrite live source histories.
    batches.push({ economy, expectedEconomyHash:null });
  }
  return batches;
}

const publisherKey = value => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'associated press' || normalized === 'ap news' ? 'ap-news' : normalized;
};

// A curated seed can overlap earlier automated imports. Keep D1's existing
// stable identity and publisher when an incoming record would reassign either.
// The AP News / Associated Press display-name pair is the only alias we fold.
export function filterConflictingArticles(articles, existing) {
  const byId = new Map(), byUrl = new Map(),reviewedUrls=new Set();
  for (const row of existing) {
    const url = row?.source?.url, publisher = row?.source?.publisher;
    if (typeof row?.id === 'string' && typeof url === 'string') byId.set(row.id, { url, publisher });
    if (typeof url === 'string') byUrl.set(url, publisher);
    if(typeof url==='string'&&row.digestBasis==='article-reviewed')reviewedUrls.add(url);
  }

  const accepted = [], seenIds = new Map(), seenUrls = new Map();let reviewedPreserved=0;
  const skipped = { idConflict: 0, publisherConflict: 0 };
  for (const article of articles) {
    const id = article?.id, url = article?.source?.url, publisher = article?.source?.publisher;
    if (typeof id !== 'string' || typeof url !== 'string' || typeof publisher !== 'string') {
      throw new Error('Curated article is missing its stable ID or source attribution.');
    }

    const priorId = byId.get(id) || seenIds.get(id);
    if (priorId && priorId.url !== url) {
      skipped.idConflict++;
      continue;
    }

    const priorPublisher = byUrl.has(url) ? byUrl.get(url) : seenUrls.get(url);
    if (priorPublisher && publisherKey(priorPublisher) !== publisherKey(publisher)) {
      skipped.publisherConflict++;
      continue;
    }

    if(reviewedUrls.has(url)){reviewedPreserved++;continue;}
    const effectivePublisher = priorPublisher || publisher;
    const prepared = effectivePublisher === publisher
      ? article
      : { ...article, source: { ...article.source, publisher: effectivePublisher } };
    accepted.push(prepared);
    seenIds.set(id, { url, publisher: effectivePublisher });
    seenUrls.set(url, effectivePublisher);
  }
  return { articles: accepted, skipped,reviewedPreserved };
}

export async function fetchExistingNews(origin, secret, { fetchImpl = fetch } = {}) {
  const records = [];
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const url = new URL('/api/admin/content-backup', origin);
    url.searchParams.set('kind', 'news');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + secret },
      redirect: 'error',
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Cannot preflight existing D1 news: HTTP ${response.status}.`);
    let page;
    try { page = await response.json(); } catch { throw new Error('Existing D1 news preflight returned invalid JSON.'); }
    if (!page || !Array.isArray(page.records)) throw new Error('Existing D1 news preflight returned an invalid record list.');
    records.push(...page.records);
    if (!page.nextCursor) return records;
    if (typeof page.nextCursor !== 'string' || page.nextCursor.length > 3000) throw new Error('Existing D1 news preflight returned an invalid cursor.');
    cursor = page.nextCursor;
  }
  throw new Error('Existing D1 news preflight exceeded its page limit.');
}

export async function hasExistingEconomy(origin, secret, {fetchImpl=fetch}={}) {
  const url=new URL('/api/admin/content-backup?kind=economy',origin);
  const response=await fetchImpl(url,{headers:{authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Cannot preflight existing economic history.');
  const body=await response.json();
  if(!Array.isArray(body.records)||body.records.length>1||body.records.some(record=>!Array.isArray(record?.countries)||record.countries.length!==19))throw new Error('Invalid existing economic document.');
  return body.records.length===1;
}

export async function main() {
  const secret = process.env.INGEST_SECRET, origin = process.env.APP_ORIGIN;
  if (!secret || secret.length < 24 || !origin) throw new Error('Set APP_ORIGIN and an INGEST_SECRET of at least 24 characters in the process environment.');
  let url;
  try { url = new URL(origin); } catch { throw new Error('APP_ORIGIN must be an HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('APP_ORIGIN must be a plain HTTPS origin.');
  const loaded = await loadContent();
  const [existing,economyExists] = await Promise.all([fetchExistingNews(url.origin, secret),hasExistingEconomy(url.origin,secret)]);
  const preflight = filterConflictingArticles(loaded.articles, existing);
  const data = { ...loaded, articles: preflight.articles, economy:economyExists?null:loaded.economy };
  const batches = importBatches(data);
  const skipped = preflight.skipped.idConflict + preflight.skipped.publisherConflict;
  if (skipped) console.log(`Skipped ${skipped} curated articles that conflict with an existing D1 ID or publisher; existing records were left unchanged.`);
  if(preflight.reviewedPreserved)console.log(`Preserved ${preflight.reviewedPreserved} existing source-reviewed articles instead of replacing them with deployment seeds.`);
  for (let i = 0; i < batches.length; i++) {
    const response = await fetch(new URL('/api/ingest', url), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
      body: JSON.stringify({ ...batches[i], feedId: 'curated-import', mode: 'seed' }),
      redirect: 'error', signal: AbortSignal.timeout(30000)
    });
    // Do not print upstream bodies: an unexpected service could echo request data.
    if(response.status===409&&batches[i].economy&&batches[i].expectedEconomyHash===null){console.log('A live economy document was created concurrently; preserved that document.');continue;}
    if (!response.ok) throw new Error(`Import batch ${i + 1} failed with HTTP ${response.status}. Previous successful batches can be safely re-imported.`);
    const result = await response.json();
    if (!result.ok) throw new Error(`Import batch ${i + 1} was not acknowledged.`);
    console.log(`Imported content batch ${i + 1}/${batches.length}.`);
  }
  console.log(`Import complete: ${data.articles.length} articles, ${data.events.length} events; economy ${economyExists?'preserved':'bootstrapped only if absent'}.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
