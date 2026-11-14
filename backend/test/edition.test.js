import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { serializeEdition } from '../src/edition.js';

test('JSON and browser fallback editions preserve the same metadata and safe text',()=>{
  const payload={articles:[{title:'A literal </script> and \u2028 separator'}],meta:{mode:'automatic',generatedAt:'2026-11-03T10:00:00Z'}};
  const {json,js}=serializeEdition(payload),context={};vm.runInNewContext(js,context);
  assert.deepEqual(JSON.parse(json),JSON.parse(JSON.stringify(context.NEWS_SNAPSHOT)));assert.equal(context.NEWS_SNAPSHOT.meta.generatedAt,payload.meta.generatedAt);assert(!js.includes('</script>'));
});
