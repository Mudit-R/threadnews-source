import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { auditIngestion } from '../scripts/audit-ingestion.mjs';

const asOf = '2026-11-12T12:00:00Z';
const fresh = '2026-11-12T09:00:00.000Z';
const stale = '2026-11-11T11:00:00Z';

function database(t) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  t.after(() => db.close());
  for (const migration of ['0001_init.sql', '0002_content.sql']) {
    db.exec(readFileSync(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
  }
  return db;
}

function addArticle(db, { id, url, title = 'Source headline', published = fresh, source = JSON.stringify({ url, publisher: 'Publisher' }) }) {
  db.prepare(`INSERT INTO news
    (id, canonical_url, title, original_headline, summary, category, region, published_at, ingested_at, source_json, feed_id)
    VALUES (?, ?, ?, ?, '', 'Economy', 'Global', ?, ?, ?, 'sample-feed')`)
    .run(id, url, title, title, published, fresh, source);
}

test('audit detects canonical collisions, malformed metadata, and lineage gaps on the D1 schema', t => {
  const db = database(t);
  const url = 'https://example.org/article';
  const canonicalSource = JSON.stringify({ publisher: 'Publisher', url });
  addArticle(db, { id: 'article-a', url });
  addArticle(db, { id: 'article-b', url: url + '?utm_source=test#section' });
  addArticle(db, { id: 'article-c', url: 'https://example.org/broken', published: '2026-02-30T12:00:00Z', source: '{' });
  const insertLineage = db.prepare('INSERT INTO article_source_lineage VALUES (?, ?, ?, ?, ?, ?)');
  insertLineage.run('article-a', 'feed-a', url, canonicalSource, fresh, fresh);
  insertLineage.run('article-c', 'feed-a', url, canonicalSource, fresh, stale);
  db.prepare(`INSERT INTO article_revisions (news_id, recorded_at, content_hash, payload_json)
    VALUES ('missing-article', ?, 'hash', '{}')`).run(fresh);

  const report = auditIngestion(db, { asOf });
  assert.equal(report.articleCount, 3);
  assert.deepEqual(report.checks, {
    malformedArticles: { count: 1, sampleIds: ['article-c'] },
    noncanonicalUrls: { count: 1, sampleIds: ['article-b'] },
    duplicateCanonicalUrlRows: { count: 1, sampleIds: ['article-b'] },
    articlesWithoutMatchingLineage: { count: 2, sampleIds: ['article-b', 'article-c'] },
    invalidLineageRows: { count: 1, sampleIds: ['article-c'] },
    orphanRevisionRows: { count: 1, sampleIds: ['missing-article'] },
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM news').get().count, 3);
});

test('feed freshness uses the last success, independently of the latest attempt', t => {
  const db = database(t);
  const insert = db.prepare('INSERT INTO feed_state (id, last_attempt_at, last_success_at, error, item_count) VALUES (?, ?, ?, ?, ?)');
  insert.run('a-fresh', fresh, fresh, null, 18);
  insert.run('b-stale', fresh, stale, 'connection failure', 12);
  insert.run('c-never', fresh, null, 'connection failure', 0);
  insert.run('d-invalid', 'not-a-date', fresh, null, 0);

  assert.deepEqual(auditIngestion(db, { asOf }).feeds, [
    { id: 'a-fresh', status: 'fresh', hoursSinceSuccess: 3, lastAttemptFailed: false, lastSuccessfulItemCount: 18 },
    { id: 'b-stale', status: 'stale', hoursSinceSuccess: 25, lastAttemptFailed: true, lastSuccessfulItemCount: 12 },
    { id: 'c-never', status: 'never_succeeded', hoursSinceSuccess: null, lastAttemptFailed: true, lastSuccessfulItemCount: 0 },
    { id: 'd-invalid', status: 'invalid_timestamp', hoursSinceSuccess: 3, lastAttemptFailed: false, lastSuccessfulItemCount: 0 },
  ]);
  assert.equal(auditIngestion(db, { asOf, staleHours: 2 }).feeds[0].status, 'stale');
  assert.throws(() => auditIngestion(db, { asOf: '2026-02-30T12:00:00Z' }), /ISO 8601 UTC/);
  assert.throws(() => auditIngestion(db, { asOf, staleHours: 0 }), /positive number/);
});
