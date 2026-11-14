import { buildContentQuery, publicTimeline } from './content.js';

const STOP = new Set('the and what when how why who where which are was were has have had did does can could would should about into this that from with for will tell show give me of in a an it is to on at latest recent new changed change last please compare versus between since update updates'.split(' '));
const asList = value => Array.isArray(value) ? value : [];
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const words = text => (String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]{2,}/g) || []);
const stem = word => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
const termsFor = question => [...new Set(words(question).filter(word => !STOP.has(word)).map(stem))].slice(0, 10);
const hits = (haystack, terms) => {
  const tokens = new Set(words(haystack).map(stem));
  return terms.reduce((sum, word) => sum + Number(tokens.has(word)), 0);
};
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

function timelineEvidence(rows, question, terms, eventId) {
  const ranked = rows.map(row => {
    const event = parse(row.payload_json, {});
    const name = [event.title, event.shortTitle, ...asList(event.keywords)].join(' ');
    return { event, rank: hits(name, terms) * 3 + hits(event.description, terms) };
  }).filter(({ rank }) => eventId || rank >= 3).sort((a, b) => b.rank - a.rank).slice(0, 2);
  const recent = /\b(latest|recent|current|now|new|today|changed)\b/i.test(question);
  const years = new Set(question.match(/\b(?:19|20)\d\d\b/g) || []);
  const items = [];
  for (const { event, rank } of ranked) {
    if (!event.id) continue;
    const preview = publicTimeline(event);
    const moments = asList(preview.milestones).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const selected = moments.map((moment, index) => ({
      moment,
      rank: 3 * hits(moment.title, terms) + hits(moment.summary, terms) + (years.has(String(moment.date).slice(0, 4)) ? 20 : 0)
        + (moment.key ? 1 : 0) + (recent && index < 3 ? 7 - index : 0)
    })).sort((a, b) => b.rank - a.rank).slice(0, ranked.length === 1 ? 6 : 3);
    if (!recent && years.size === 0 && selected.length > 2 && !selected.some(({ moment }) => moment === moments.at(-1))) {
      selected[selected.length - 1] = { moment: moments.at(-1) };
    }
    for (const { moment } of selected) {
      const item = evidence({
        title: moment.title, excerpt: moment.summary, date: moment.date,
        kind: moment.dateType === 'publication' ? 'Timeline · report date' : 'Timeline · event date',
        href: '/threads/' + encodeURIComponent(event.id), sources: asList(moment.sources),
        note: preview.previewTruncated ? `Public timeline preview through ${preview.previewCutoff}` : `Timeline coverage through ${event.coverageEnd || moment.date}`
      });
      if (item) items.push({ item, rank: rank + 20 + Number(Boolean(eventId)) * 50 });
    }
  }
  return items;
}

const aliases = {
  US: /\b(united states|america|usa|u\.?s\.)\b|\bUS\b/i,
  GB: /\b(united kingdom|britain|british|uk)\b/i,
  KR: /\b(south korea|korea, rep\.|korea)\b/i,
  IN: /\bindian\b/i,
  EU: /\b(european union|eurozone)\b/i
};

function economyEvidence(payload, question, countryCode) {
  if (!countryCode && !/\b(gdp|growth|economy|economic|cpi|inflation|prices|output)\b/i.test(question)) return [];
  const tokens = ` ${words(question).join(' ')} `;
  const countries = asList(payload.countries).filter(country =>
    countryCode ? country.code === countryCode : tokens.includes(` ${words(country.name).join(' ')} `) || aliases[country.code]?.test(question)
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

async function newsEvidence(db, env, terms, eventId) {
  if (!terms.length && !eventId) return [];
  const query = buildContentQuery(new URLSearchParams(), env, { cursor: false });
  const conditions = terms.map(() => 'lower(title || \' \' || keywords) LIKE ?');
  const filter = eventId ? 'event_id=?' : '(' + conditions.join(' OR ') + ')';
  const matched = eventId ? [eventId] : terms.map(term => `%${term}%`);
  const { results } = await db.prepare(`SELECT id,title,summary,published_at,source_json,official_sources_json,keywords
    FROM news${query.where} AND ${filter} ORDER BY published_at DESC,id DESC LIMIT 36`)
    .bind(...query.args, ...matched).all();
  const items = [];
  for (const row of asList(results)) {
    const source = parse(row.source_json, {});
    const headline = source.basis !== 'article' || !row.summary;
    const match = hits(row.title, terms) * 2 + hits(row.keywords, terms);
    if (!eventId && match < 2) continue;
    const item = evidence({
      title: row.title, excerpt: headline ? row.title : row.summary, date: row.published_at?.slice(0, 10),
      kind: headline ? 'Headline · report date' : 'Sourced brief · report date',
      href: '/news/' + encodeURIComponent(row.id), sources: [source, ...asList(parse(row.official_sources_json, []))]
    });
    if (item) items.push({ item, rank: (eventId ? 45 : 10) + match * 4 + Number(!headline) * 4 });
  }
  return items.sort((a, b) => b.rank - a.rank).slice(0, eventId ? 3 : 6);
}

export async function retrieveEvidence(env, { question, eventId, countryCode }) {
  const db = env.DB, terms = termsFor(question);
  const expectEconomy = countryCode || /\b(gdp|growth|economy|economic|cpi|inflation|prices|output)\b/i.test(question);
  const [events, economy, news] = await Promise.all([
    countryCode ? null : eventId
      ? db.prepare('SELECT payload_json FROM event_payloads WHERE id=?').bind(eventId).all()
      : db.prepare('SELECT payload_json FROM event_payloads ORDER BY updated_at DESC LIMIT 24').all(),
    expectEconomy && !eventId ? db.prepare("SELECT payload_json FROM content_documents WHERE id='economy'").first() : null,
    countryCode ? [] : newsEvidence(db, env, terms, eventId)
  ]);
  const candidates = [
    ...economyEvidence(parse(economy?.payload_json, {}), question, countryCode),
    ...timelineEvidence(asList(events?.results), question, terms, eventId),
    ...news
  ].sort((a, b) => b.rank - a.rank);
  const seen = new Set();
  return candidates.filter(({ item }) => {
    const key = `${item.kind}|${item.title.toLowerCase()}|${item.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 9).map(({ item }, index) => ({ id: index + 1, ...item }));
}
