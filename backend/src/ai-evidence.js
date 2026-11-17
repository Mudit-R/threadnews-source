import { buildContentQuery, publicTimeline } from './content.js';
import { hasPaidAccess } from './paypal.js';
import { dateRelevance, matches, questionFeatures, relevantPassage, selectEvidence, shortlistEvidence, words } from './ai-retrieval.js';

const asList = value => Array.isArray(value) ? value : [];
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const text = (value, size) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, size);

function linksFor(sources) {
  const links = [];
  for (const source of sources) {
    try {
      const url = new URL(source?.publisherArticleUrl || source?.url);
      if (url.protocol !== 'https:' || url.username || url.password || links.some(item => item.url === url.href)) continue;
      links.push({ publisher: text(source.publisher || url.hostname, 100), title: text(source.title, 180), url: url.href });
    } catch {}
    if (links.length === 3) break;
  }
  return links;
}

function evidence({ title, excerpt, date, kind, href, sources, note = '' }) {
  const links = linksFor(sources);
  if (!links.length || !title || !excerpt) return null;
  return { title: text(title, 200), excerpt: text(excerpt, 400), date: text(date, 24), kind, href, links, note: text(note, 180) };
}

function milestoneEvidence(event, moment, note = '', groups = []) {
  return evidence({
    title: moment.title, excerpt: relevantPassage(moment.summary, groups), date: moment.datePrecision === 'month' ? moment.date.slice(0, 7) : moment.date,
    kind: moment.dateType === 'publication' ? 'Timeline · report date' : 'Timeline · event date',
    href: '/threads/' + encodeURIComponent(event.id), sources: asList(moment.sources), note
  });
}

function timelineEvidence(rows, features, eventId, canReadFull, now) {
  const { groups, timeline } = features;
  const items = [];
  for (const row of rows) {
    const event = parse(row.payload_json, {});
    if (!event.id) continue;
    const preview = canReadFull ? event : publicTimeline(event);
    const moments = asList(preview.milestones).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const topicMatches = matches([event.title, event.shortTitle, ...asList(event.keywords)].join(' '), groups);
    const ranked = moments.map((moment, index) => {
      const titleMatches = matches(moment.title, groups);
      const bodyMatches = matches(moment.summary, groups);
      // A match in a particular public milestone can be more useful than a
      // generic match in a timeline title. Rank only the allowed preview.
      const relevant = eventId || topicMatches || titleMatches || bodyMatches;
      const rank = 14 + topicMatches * 6 + titleMatches * 9 + bodyMatches * 5
        + dateRelevance(moment.date, features, now) + (moment.key ? 3 : 0)
        + (timeline && index === moments.length - 1 ? 8 : 0) + (eventId ? 17 : 0);
      return relevant ? { moment, rank } : null;
    }).filter(Boolean).sort((a, b) => b.rank - a.rank).slice(0, eventId ? 8 : 4);
    for (const { moment, rank } of ranked) {
      const item = milestoneEvidence(event, moment, preview.previewTruncated
        ? `Public timeline preview through ${preview.previewCutoff}` : `Timeline coverage through ${event.coverageEnd || moment.date}`, groups);
      if (item) items.push({ item, rank });
    }
  }
  return items;
}

const aliases = {
  US: /\b(united states|america|american|usa)\b|\bu\.s\.(?=\W|$)/i,
  GB: /\b(united kingdom|britain|british|uk)\b/i,
  KR: /\b(south korea|korea, rep\.|korea)\b/i,
  IN: /\bindian\b/i,
  EU: /\b(european union|eurozone)\b/i
};

function economyEvidence(payload, question, countryCode) {
  if (!countryCode && !/\b(gdp|growth|economy|economic|cpi|inflation|prices|output)\b/i.test(question)) return [];
  const tokens = ` ${words(question).join(' ')} `;
  const countries = asList(payload.countries).filter(country =>
    countryCode ? country.code === countryCode : tokens.includes(` ${words(country.name).join(' ')} `)
      || aliases[country.code]?.test(question) || (country.code === 'US' && /\bUS\b/.test(question))
  ).slice(0, 3);
  const requestedYear = Number(question.match(/\b(?:19|20)\d\d\b/)?.[0] || 0);
  const wantsGdp = /\b(gdp|growth|output)\b/i.test(question);
  const wantsPrices = /\b(cpi|inflation|prices)\b/i.test(question);
  const items = [];
  for (const c of countries) {
    const href = '/economy/' + encodeURIComponent(c.code);
    const add = (metric, point, source, label) => {
      if (!Number.isFinite(point?.value)) return;
      const period = String(point.period ?? point.year);
      const value = Number(point.value.toFixed(3));
      const item = evidence({
        title: `${c.name} · ${metric}`, excerpt: `${c.name}: ${metric} was ${value}% in ${period} (${label}).`,
        date: period, kind: 'Official economic data', href, sources: [source], note: point.provisional ? 'Provisional observation' : ''
      });
      if (item) items.push({ item, rank: 95 });
    };
    if (wantsGdp || !wantsPrices) {
      const gdp = requestedYear ? asList(c.gdpGrowth).find(p => p.year === requestedYear) : c.latestAnnualGdpGrowth;
      add('real GDP growth', gdp, c.gdpGrowthSource, 'annual percent change');
      const previous = !requestedYear && asList(c.gdpGrowth).find(p => p.year === gdp?.year - 1);
      add('real GDP growth', previous, c.gdpGrowthSource, 'annual percent change');
    }
    if (wantsPrices || !wantsGdp) {
      const cpi = requestedYear ? asList(c.inflation).find(p => p.year === requestedYear) : c.latestAnnualInflation;
      const latest = !requestedYear && c.latestInflation;
      if (latest) add('consumer price inflation', latest, latest.source, latest.measure || `${latest.frequency} year-on-year`);
      add('annual consumer price inflation', cpi, c.inflationSource, 'annual percent change');
    }
  }
  return items;
}

function articleEvidence(row, groups = []) {
  const source = parse(row.source_json, {});
  const headline = source.basis !== 'article' || !row.summary;
  return evidence({
    title: row.title, excerpt: headline ? row.title : relevantPassage(row.summary, groups), date: row.published_at?.slice(0, 10),
    kind: headline ? 'Headline · report date' : 'Sourced brief · report date',
    href: '/news/' + encodeURIComponent(row.id), sources: [source, ...asList(parse(row.official_sources_json, []))]
  });
}

export async function retrieveArticleSummaryEvidence(env, id) {
  const query = buildContentQuery(new URLSearchParams(), env, { cursor: false });
  const row = await env.DB.prepare(`SELECT id,title,original_headline,summary,published_at,source_json,official_sources_json,metadata_json
    FROM news${query.where} AND id=?`).bind(...query.args, id).first();
  if (!row) return null;
  const source = parse(row.source_json, {});
  const basis = parse(row.metadata_json, {})?.digestBasis;
  const summarized = source.basis === 'article' && row.summary?.trim() && ['article-reviewed','source-summary','source-extract','publisher-preview','official-primary-source'].includes(basis);
  const headline = row.original_headline || row.title;
  const record = evidence({
    title: headline, excerpt: summarized ? row.summary : headline, date: row.published_at.slice(0, 10),
    kind: summarized ? 'Stored source brief' : 'Publisher headline',
    href: '/news/' + encodeURIComponent(row.id), sources: [source]
  });
  return {
    basis: summarized ? 'source_brief' : 'headline',
    publishedSummary: summarized && ['source-summary','article-reviewed'].includes(basis),
    publisher: source.publisher || 'The publisher',
    text: summarized ? row.summary : headline,
    evidence: record ? [{ ...record, id: 1 }] : []
  };
}

async function newsEvidence(db, env, features, eventId, now) {
  const { groups } = features;
  if (!groups.length && !eventId) return [];
  const query = buildContentQuery(new URLSearchParams(), env, { cursor: false, now });
  const fields = 'id,title,summary,published_at,source_json,official_sources_json,keywords';
  const { results } = eventId
    ? await db.prepare(`SELECT ${fields} FROM news${query.where} AND event_id=?
      ORDER BY published_at DESC,id DESC LIMIT 36`).bind(...query.args, eventId).all()
    : await db.prepare(`WITH terms AS (SELECT value FROM json_each(?))
      SELECT * FROM (
        SELECT ${fields}, (SELECT COALESCE(SUM(CASE
          WHEN instr(lower(replace(title,'-',' ')), terms.value) > 0 THEN 5
          WHEN instr(lower(replace(keywords,'-',' ')), terms.value) > 0 THEN 3
          WHEN json_extract(source_json,'$.basis')='article'
            AND instr(lower(replace(summary,'-',' ')), terms.value) > 0 THEN 2
          ELSE 0 END),0) FROM terms) AS lexical_score
        FROM news${query.where}
      ) WHERE lexical_score > 0 ORDER BY lexical_score DESC,published_at DESC,id DESC LIMIT 60`)
      .bind(JSON.stringify([...new Set(groups.flat())]), ...query.args).all();
  const items = [];
  for (const row of asList(results)) {
    const source = parse(row.source_json, {});
    const headline = source.basis !== 'article' || !row.summary;
    const titleMatches = matches(row.title, groups);
    const bodyMatches = headline ? 0 : matches(row.summary, groups);
    const keywordMatches = matches(row.keywords, groups);
    if (!eventId && !titleMatches && !bodyMatches && !keywordMatches) continue;
    const item = articleEvidence(row, groups);
    const coverage = matches([row.title, row.keywords, headline ? '' : row.summary].join(' '), groups);
    const rank = (eventId ? 26 : 12) + titleMatches * 8 + bodyMatches * 6 + keywordMatches * 4 + coverage * 5
      + (headline ? 0 : 8) + dateRelevance(item?.date, features, now);
    if (item) items.push({ item, rank });
  }
  return items;
}

export function divideMilestones(event, since, through) {
  const ordered = asList(event.milestones)
    .filter(moment => typeof moment?.date === 'string' && moment.date <= through)
    .sort((a, b) => b.date.localeCompare(a.date));
  const recent = ordered.filter(moment => moment.date >= since);
  return {
    baseline: ordered.filter(moment => moment.date < since)
      .map(moment => milestoneEvidence(event, moment)).find(Boolean) || null,
    recent: recent.map(moment => {
      const item = milestoneEvidence(event, moment);
      return item ? { ...item, key: Boolean(moment.key) } : null;
    }).filter(Boolean),
  };
}

export async function retrieveStoryChanges(env, eventId, days, now) {
  const db = env.DB, asOf = now.toISOString(), through = asOf.slice(0, 10);
  const since = new Date(Date.parse(through) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const row = await db.prepare('SELECT payload_json FROM event_payloads WHERE id=?').bind(eventId).first();
  if (!row) return null;
  const full = parse(row.payload_json, {});
  const event = await hasPaidAccess(env, null, Math.floor(now.getTime() / 1000)) ? full : publicTimeline(full);
  const { baseline, recent } = divideMilestones(event, since, through);
  const query = buildContentQuery(new URLSearchParams(), env, { now, cursor: false });
  const reportSince = new Date(Math.max(Date.parse(since), now.getTime() - Math.min(query.feedDays, query.retentionDays) * 86400000)).toISOString();
  const { results } = await db.prepare(`SELECT id,title,summary,published_at,source_json,official_sources_json,
      COUNT(*) OVER() AS total FROM news${query.where} AND event_id=? AND published_at>=?
      ORDER BY published_at DESC,id DESC LIMIT 20`).bind(...query.args, eventId, reportSince).all();
  const records = [];
  const seen = new Set();
  for (const report of asList(results)) {
    const item = articleEvidence(report);
    if (!item) continue;
    const key = words(item.title).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(item);
    if (records.length === 3) break;
  }
  const selected = [
    ...(baseline ? [{ ...baseline, role: 'baseline', note: 'Last reviewed milestone before this range.' }] : []),
    ...recent.toSorted((a, b) => Number(b.key) - Number(a.key)).slice(0, 5)
      .map(({ key, ...item }) => ({ ...item, role: 'milestone' })),
    ...records.map(item => ({ ...item, role: 'report', note: 'Linked reporting · date of publication.' }))
  ];
  return {
    eventTitle: text(event.title, 200), since, through, reportSince, sampledAt: asOf,
    reviewedThrough: event.previewCutoff || event.coverageEnd || null,
    previewTruncated: Boolean(event.previewTruncated),
    counts: { milestones: recent.length, linkedReports: Number(results?.[0]?.total) || 0 },
    evidence: selected.map((item, index) => ({ id: index + 1, ...item }))
  };
}

export async function retrieveDailyEvidence(env, now) {
  const query = buildContentQuery(new URLSearchParams(), env, { now, cursor: false });
  const since = new Date(now.getTime() - 86400000).toISOString();
  const rows = await env.DB.prepare(`SELECT id,title,summary,published_at,source_json,official_sources_json,category
    FROM news${query.where} AND published_at>=?
    ORDER BY CASE WHEN json_extract(source_json,'$.basis')='article' AND source_type='Official source' THEN 0
      WHEN json_extract(source_json,'$.basis')='article' THEN 1 ELSE 2 END,
      published_at DESC,id DESC LIMIT 60`).bind(...query.args, since).all();
  const categories = new Map(), selected = [];
  for (const row of asList(rows.results)) {
    if ((categories.get(row.category) || 0) >= 2) continue;
    const item = articleEvidence(row);
    if (!item) continue;
    const tokens = new Set(words(item.title));
    if (selected.some(entry => {
      const overlap = [...tokens].filter(token => entry.tokens.has(token)).length;
      return overlap >= Math.max(3, Math.ceil(0.65 * Math.min(tokens.size, entry.tokens.size)));
    })) continue;
    selected.push({ item, tokens, recordId: row.id });
    categories.set(row.category, (categories.get(row.category) || 0) + 1);
    if (selected.length === 8) break;
  }
  return selected.map(({ item, recordId }, index) => ({ id: index + 1, recordId, ...item }));
}

export async function isDailyEvidencePublic(env, evidence, now) {
  if (!evidence.length) return true;
  const query = buildContentQuery(new URLSearchParams(), env, { now, cursor: false });
  const ids = evidence.map(item => item.recordId);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM news${query.where}
    AND id IN (SELECT value FROM json_each(?))`).bind(...query.args, JSON.stringify(ids)).first();
  return row?.total === ids.length;
}

export async function retrieveEvidenceCandidates(env, { question, eventId, countryCode }, now = new Date()) {
  const db = env.DB, features = questionFeatures(question);
  if (!eventId && !countryCode && !features.groups.length) {
    if (!features.recent) return [];
    return (await retrieveDailyEvidence(env, now)).map(({ id, recordId, ...item }, index) => ({ item, rank: 20 - index }));
  }
  const expectEconomy = countryCode || /\b(gdp|growth|economy|economic|cpi|inflation|prices|output|hicp|cost of living)\b/i.test(question);
  const [events, economy, news, canReadFull] = await Promise.all([
    countryCode ? null : eventId
      ? db.prepare('SELECT payload_json FROM event_payloads WHERE id=?').bind(eventId).all()
      : db.prepare('SELECT payload_json FROM event_payloads ORDER BY updated_at DESC LIMIT 24').all(),
    expectEconomy && !eventId ? db.prepare("SELECT payload_json FROM content_documents WHERE id='economy'").first() : null,
    countryCode ? [] : newsEvidence(db, env, features, eventId, now),
    countryCode ? false : hasPaidAccess(env, null, Math.floor(now.getTime() / 1000))
  ]);
  return shortlistEvidence([
    ...economyEvidence(parse(economy?.payload_json, {}), question, countryCode),
    ...timelineEvidence(asList(events?.results), features, eventId, canReadFull, now),
    ...news
  ]);
}

export async function retrieveEvidence(env, input, now) {
  return selectEvidence(await retrieveEvidenceCandidates(env, input, now));
}
