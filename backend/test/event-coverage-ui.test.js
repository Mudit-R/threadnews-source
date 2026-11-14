import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/event-coverage.js', import.meta.url), 'utf8');

test('historical coverage gate links readers to membership and recent coverage stays public-window scoped', async () => {
  const requests = [], listeners = {};
  const container = {
    innerHTML: '', isConnected: true,
    classList: { add() {} },
    setAttribute() {},
    addEventListener(name, callback) { listeners[name] = callback; },
    removeEventListener() {},
    contains() { return true; }
  };
  const context = vm.createContext({
    console, URL, Date, AbortController, Response,
    location: { origin: 'https://threadnews.online' },
    fetch: async () => Response.json({})
  });
  vm.runInContext(source, context);
  const mounted = context.ThreadNewsEventCoverage.mount(container, { id: 'rail-project' }, {
    apiBase: 'https://threadnews.online',
    fetchImpl: async url => {
      const parsed = new URL(url);
      requests.push(parsed);
      if (parsed.searchParams.get('since') === '1970-01-01') {
        return Response.json({ error: 'archive_access_required', message: 'Supporter access required.' }, { status: 403 });
      }
      return Response.json({ coverage: [], meta: { total: 0, since: '2026-11-01', hasMore: false, nextCursor: null } });
    }
  });
  await mounted.ready;
  assert.equal(requests[0].searchParams.has('since'), false);
  assert.match(container.innerHTML, /Recent coverage/);

  const button = { dataset: { coverageAction: 'all' }, closest() { return this; } };
  listeners.click({ target: { closest() { return button; } }, preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(requests[1].searchParams.get('since'), '1970-01-01');
  assert.match(container.innerHTML, /Full historical source coverage requires verified supporter access/);
  assert.match(container.innerHTML, /href="\/pricing"/);
  assert.doesNotMatch(container.innerHTML, /Source coverage could not be loaded/);
  mounted.destroy();
});
