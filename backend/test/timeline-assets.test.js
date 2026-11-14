import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadContent } from '../scripts/import-content.mjs';

test('local seed and static fallback agree with the published timeline preview', async () => {
  const preview = JSON.parse(readFileSync(new URL('../../web/timeline-data.json', import.meta.url), 'utf8'));
  const script = {};
  vm.runInNewContext(readFileSync(new URL('../../web/data.js', import.meta.url), 'utf8'), script);
  const { events } = await loadContent();
  assert.ok(events.length > 0);
  assert.ok(events.every(event => event.milestones.length <= 10));
  assert.deepEqual(events, preview.events);
  assert.deepEqual(JSON.parse(JSON.stringify(script.STORIES)), preview.events);
});
