import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { retrieveEvidence } from '../src/ai-evidence.js';

const now = new Date('2026-11-17T12:00:00Z');
const top = 5;
const publisher = (id, basis = 'article') => ({ publisher: 'Fixture Newsroom', url: `https://news.example/${id}`, basis });
const daysAgo = days => new Date(now.getTime() - days * 86400000).toISOString();
const db = new DatabaseSync(':memory:');

function binding() {
  return { prepare(query) {
    const statement = db.prepare(query);
    const bind = (...args) => ({
      bind,
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; }
    });
    return bind();
  } };
}

function seed() {
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const insert = db.prepare(`INSERT INTO news (id,canonical_url,title,original_headline,summary,category,region,
    published_at,ingested_at,source_json,metadata_json,event_id,feed_id)
    VALUES (?,?,?,?,?,?,'Everywhere',?,?,?,?,?,'fixture')`);
  const records = [
    ['monitor', 'Maritime envoys meet', 'The Navira ceasefire agreement calls for independent monitor visits.'],
    ['shipping', 'Navira harbor reopens after strike', 'Two commercial channels are open under port rules.'],
    ['price', 'Auroria revises customs duties', 'The finance ministry cut duties on imported grain.', { category: 'Economy' }],
    ['rate', 'Auroria central bank sets benchmark rate', 'The bank held its benchmark rate at 4 percent.', { category: 'Economy' }],
    ['rail', 'High speed rail opens procurement', 'The Northbay route opens a tender for two stations.', { event: 'northbay' }],
    ['headline', 'Northbay rail tender enters new phase', 'Fixture secret: bid prices and commuter counts are not in this headline.', { basis: 'headline', event: 'northbay' }],
    ['excluded', 'Navira ceasefire robotics proof', 'An excluded fixture must never be returned.', { excluded: true }],
    ['outdated', 'Navira ceasefire robotics proof', 'An expired fixture must never be returned in the public feed.', { age: 8 }],
    ['scheduled', 'Navira ceasefire robotics proof', 'A future fixture must never be returned.', { age: -1 }]
  ];
  for (const [id, title, summary, options = {}] of records) {
    const source = publisher(id, options.basis);
    insert.run(id, source.url, title, title, summary, options.category || 'World', daysAgo(options.age ?? 1),
      daysAgo(0), JSON.stringify(source), JSON.stringify({ editorialExcluded: !!options.excluded, digestBasis: 'article-reviewed' }), options.event || null);
  }
  const timeline = { id: 'northbay', title: 'Northbay rail project', coverageEnd: '2026-11-16', milestones: [
    { date: '2025-06-12', dateType: 'event', title: 'Northbay route approved', summary: 'The transport department approved the Northbay rail route.', sources: [publisher('route-record')] }
  ] };
  db.prepare(`INSERT INTO event_payloads (id,title,category,region,updated_at,payload_json,content_hash)
    VALUES (?,?,?,?,?,?,?)`).run(timeline.id, timeline.title, 'World', 'Everywhere', daysAgo(0), JSON.stringify(timeline), 'fixture');
  const gdp = { year: 2025, value: 2.4 };
  const economy = { countries: [{ code: 'AU', name: 'Australia', gdpGrowth: [gdp],
    latestAnnualGdpGrowth: gdp, gdpGrowthSource: publisher('gdp-release') }] };
  db.prepare("INSERT INTO content_documents (id,payload_json,updated_at,content_hash) VALUES ('economy',?,?,'fixture')")
    .run(JSON.stringify(economy), daysAgo(0));
}

const cases = [
  { name: 'truce synonym', question: 'What is the latest on the Navira truce?', relevant: ['/news/monitor'] },
  { name: 'dated report', question: 'Why did the Navira harbor reopen?', relevant: ['/news/shipping'] },
  { name: 'tariff synonym', question: 'What did Auroria do with tariffs?', relevant: ['/news/price'] },
  { name: 'policy rate synonym', question: 'Where do interest rates stand in Auroria?', relevant: ['/news/rate'] },
  { name: 'timeline and recent reporting', question: 'What is the Northbay timeline?', eventId: 'northbay', relevant: ['/threads/northbay', '/news/rail'] },
  { name: 'country-scoped official data', question: 'What was real GDP growth in 2025?', countryCode: 'AU', relevant: ['/economy/AU'] },
  { name: 'unrelated question', question: 'Where is an orchid greenhouse on Titan?', empty: true },
  { name: 'excluded, expired and future records', question: 'What is the Navira ceasefire robotics proof?', forbidden: ['/news/excluded', '/news/outdated', '/news/scheduled'] },
  { name: 'headline cannot expose a stored summary', question: 'What is in the Northbay rail tender?', eventId: 'northbay', headline: '/news/headline' }
];

try {
  seed();
  const env = { DB: binding(), NEWS_FEED_DAYS: '4' };
  const relevance = [], safety = [];
  for (const { name, relevant, forbidden, empty, headline, ...input } of cases) {
    const evidence = await retrieveEvidence(env, input, now);
    const paths = evidence.map(item => item.href);
    if (relevant) {
      const hits = new Set(paths.slice(0, top).filter(path => relevant.includes(path)));
      const first = paths.findIndex(path => relevant.includes(path));
      relevance.push({ case: name, recallAt5: hits.size / relevant.length, reciprocalRank: first < 0 ? 0 : 1 / (first + 1) });
    }
    if (empty || forbidden || headline) {
      const record = evidence.find(item => item.href === headline);
      const passed = empty ? evidence.length === 0 : forbidden ? forbidden.every(path => !paths.includes(path))
        : record?.kind.startsWith('Headline') && record.excerpt === record.title;
      safety.push({ case: name, passed: !!passed });
    }
  }
  const mean = key => Number((relevance.reduce((total, result) => total + result[key], 0) / relevance.length).toFixed(3));
  console.log(JSON.stringify({
    scope: 'Synthetic, deterministic fixture. Uses production lexical retrieval and context selection with local SQLite. No models, network requests, private data, or measurement of generated answers.',
    recallAt5: mean('recallAt5'), meanReciprocalRank: mean('reciprocalRank'), relevance, policyChecks: safety
  }, null, 2));
  if (safety.some(result => !result.passed) || relevance.some(result => result.recallAt5 !== 1)) process.exitCode = 1;
} finally {
  db.close();
}
