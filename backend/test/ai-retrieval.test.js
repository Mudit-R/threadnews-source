import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { retrieveEvidence } from '../src/ai-evidence.js';
import { validateClaims } from '../src/ai-provider.js';
import { handleAsk } from '../src/ai.js';

const now = new Date();
const day = 86400000;
const appOrigin = 'https://threadnews.online';
const publisher = { publisher: 'Fixture Press', url: 'https://publisher.example/truce', basis: 'article' };

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  const DB = {
    prepare(query) {
      const statement = sqlite.prepare(query);
      const bind = (...args) => ({
        bind,
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; }
      });
      return bind();
    }
  };
  return { sqlite, env: { DB, APP_ORIGIN: appOrigin, NEWS_FEED_DAYS: '4' } };
}

function report(sqlite, { id, title, summary, source = publisher, when = now.getTime() - 60000, hidden = false, eventId = null }) {
  sqlite.prepare(`INSERT INTO news (id,canonical_url,title,original_headline,summary,category,region,
    published_at,ingested_at,source_json,metadata_json,event_id,feed_id)
    VALUES (?,?,?,?,?,'World','Everywhere',?,?,?,?,?,'fixture')`)
    .run(id, `https://publisher.example/${id}`, title, title, summary, new Date(when).toISOString(),
      now.toISOString(), JSON.stringify(source), JSON.stringify({ editorialExcluded: hidden }), eventId);
}

test('RAG finds a synonym in the original brief and returns the matching passage within public feed policy', async t => {
  const { sqlite, env } = database(t);
  const summary = 'The delegations arrived at separate airports. '.repeat(12)
    + 'Japan faces a disputed ceasefire enforcement deadline. The envoy described the next meeting.';
  report(sqlite, { id: 'relevant', title: 'Envoy briefs both delegations', summary });
  report(sqlite, { id: 'withdrawn', title: 'Japan truce', summary, hidden: true });
  report(sqlite, { id: 'expired', title: 'Japan truce', summary, when: now.getTime() - 7 * day });
  report(sqlite, { id: 'scheduled', title: 'Japan truce', summary, when: now.getTime() + day });
  report(sqlite, { id: 'headline-only', title: 'Talks open', summary, source: { ...publisher, basis: 'headline' } });

  const evidence = await retrieveEvidence(env, { question: 'What is the latest on the Japan truce?' }, now);
  assert.deepEqual(evidence.map(item => item.href), ['/news/relevant']);
  assert.match(evidence[0].excerpt, /ceasefire enforcement deadline/);
  assert.equal(evidence[0].links[0].url, publisher.url);
});

test('a current edition question retrieves public articles without requiring a topic keyword', async t => {
  const { sqlite, env } = database(t);
  report(sqlite, { id: 'brief', title: 'Shenzhen summit schedule', summary: 'The APEC meetings open on Thursday.' });
  const evidence = await retrieveEvidence(env, { question: 'What is happening around the world today?' }, now);
  assert.deepEqual(evidence.map(item => item.href), ['/news/brief']);
});

test('RAG preserves anonymous timeline previews after configured billing begins', async t => {
  const { sqlite, env } = database(t);
  Object.assign(env, {
    BILLING_ENABLED: 'true',
    PAYPAL_ENV: 'sandbox',
    PAYPAL_CLIENT_ID: 'sandbox-id',
    PAYPAL_CLIENT_SECRET: 'sandbox-secret',
    PAYPAL_WEBHOOK_ID: 'WH-FIXTURE',
    PAYPAL_SUBSCRIPTIONS_ACCESS: 'true',
    PAYPAL_PLAN_MONTHLY_ID: 'P-MONTHLY',
    PAYPAL_PLAN_ANNUAL_ID: 'P-ANNUAL'
  });
  const event = {
    id: 'fixture', title: 'Harbor negotiations',
    milestones: Array.from({ length: 11 }, (_, i) => ({
      date: `2025-11-${String(i + 1).padStart(2, '0')}`,
      title: i === 10 ? 'Private verdict' : `Public milestone ${i + 1}`,
      summary: i === 10 ? 'Secret arbitrator text.' : 'The negotiation continued.',
      sources: [publisher]
    }))
  };
  sqlite.prepare('INSERT INTO event_payloads (id,title,category,region,updated_at,payload_json,content_hash) VALUES (?,?,?,?,?,?,?)')
    .run(event.id, event.title, 'World', 'Everywhere', now.toISOString(), JSON.stringify(event), 'fixture');
  const evidence = await retrieveEvidence(env, { question: 'What was the private verdict?', eventId: event.id }, new Date('2027-01-01T00:00:00Z'));
  assert.ok(evidence.length > 0);
  assert.ok(evidence.every(item => !item.title.includes('Private') && !item.excerpt.includes('Secret')));
  assert.ok(evidence.every(item => item.note.includes('Public timeline preview')));
});

test('Ask uses semantic rank before generation and citations reference the final evidence order', async t => {
  const { sqlite, env } = database(t);
  report(sqlite, { id: 'first', title: 'Japan truce talks', summary: 'The Japan truce is still under discussion.' });
  report(sqlite, { id: 'second', title: 'Delegations set agenda', summary: 'Japan ceasefire monitors will meet on Thursday.' });
  const calls = [];
  env.AI = { async run(model, request) {
    calls.push(model);
    if (model.includes('reranker')) {
      assert.match(request.contexts[0].text, /Japan truce talks/);
      return { response: [{ id: 1, score: 3 }, { id: 0, score: 1 }] };
    }
    const input = JSON.parse(request.messages[1].content);
    assert.match(input.evidence[0].excerpt, /ceasefire monitors/);
    return { response: JSON.stringify({ claims: [{ text: 'Japan ceasefire monitors will meet on Thursday.', citations: [1] }] }) };
  } };
  const response = await handleAsk(new Request(appOrigin + '/api/ai/ask', {
    method: 'POST',
    headers: { origin: appOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What is the latest on the Japan truce?' })
  }), env);
  const answer = await response.json();
  assert.equal(answer.status, 'answered');
  assert.deepEqual(calls, ['@cf/baai/bge-reranker-base', '@cf/meta/llama-3.1-8b-instruct']);
  assert.equal(answer.retrieval.semanticRerank, true);
  assert.equal(answer.evidence[0].href, '/news/second');
  assert.deepEqual(answer.claims[0].citations, [answer.evidence[0].id]);
});

test('a model claim cannot flip the direction of a cited numeric value', () => {
  const evidence = [{ id: 1, title: 'Official release', date: '2026-11-17', excerpt: 'The annual reading was −2.5%.' }];
  assert.equal(validateClaims({ claims: [{ text: 'The reading was 2.5%.', citations: [1] }] }, evidence), null);
  assert.ok(validateClaims({ claims: [{ text: 'The reading was -2.5%.', citations: [1] }] }, evidence));
});
