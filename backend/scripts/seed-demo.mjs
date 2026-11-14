import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContent } from './import-content.mjs';

const { events, economy } = await loadContent();
const quote = value => "'" + String(value ?? '').replaceAll("'", "''") + "'";
const hash = value => createHash('sha256').update(value).digest('hex');
const now = new Date().toISOString();
const sql = events.map(event => {
  const payload = JSON.stringify(event);
  const args = [event.id, event.title, event.category, event.region, event.coverageEnd, now, payload, hash(payload)].map(quote).join(',');
  return 'INSERT OR IGNORE INTO event_payloads (id,title,category,region,coverage_end,updated_at,payload_json,content_hash) VALUES (' + args + ');';
});
const econ = JSON.stringify(economy);
sql.push("INSERT OR IGNORE INTO content_documents (id,updated_at,payload_json,content_hash) VALUES ('economy'," + [now, econ, hash(econ)].map(quote).join(',') + ');');
const directory = mkdtempSync(join(tmpdir(), 'threadnews-demo-'));
const sqlFile = join(directory, 'demo.sql');
try {
  writeFileSync(sqlFile, sql.join('\n'));
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', '--local', '--file', sqlFile], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit'
  });
  if (result.error || result.status !== 0) throw result.error || new Error('Local D1 import failed');
  console.log('Imported public timelines and economic observations into local D1.');
} finally {
  rmSync(sqlFile, { force: true });
  rmdirSync(directory);
}
