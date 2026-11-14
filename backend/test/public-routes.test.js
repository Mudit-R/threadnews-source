import test from 'node:test';
import assert from 'node:assert/strict';
import '../../web/public-routes.js';
const routes = globalThis.ThreadNewsPublicRoutes;

test('legacy hash routes map to clean public paths and retain sign-in query flags', () => {
  assert.equal(routes.legacyHashPath('#/'), '/');
  assert.equal(routes.legacyHashPath('#/event/mumbai-ahmedabad-rail'), '/threads/mumbai-ahmedabad-rail');
  assert.equal(routes.legacyHashPath('#/news/story%3A123'), '/news/story%3A123');
  assert.equal(routes.legacyHashPath('#/timelines'), '/threads');
  assert.equal(routes.legacyHashPath('#/economy/IND'), '/economy/IND');
  assert.equal(routes.legacyHashPath('#/signin?auth_error=1'), '/signin?auth_error=1');
  assert.equal(routes.legacyHashPath('#/pricing'), '/pricing');
  assert.equal(routes.legacyHashPath('#/billing'), '/billing');
});

test('legacy route normalization preserves PayPal query parameters before the hash', () => {
  assert.equal(routes.legacyLocationPath('#/pricing', '?checkout=order-approved&token=ORDER-123'), '/pricing?checkout=order-approved&token=ORDER-123');
  assert.equal(routes.legacyLocationPath('#/pricing?tab=plans', '?checkout=cancelled'), '/pricing?tab=plans&checkout=cancelled');
  assert.equal(routes.legacyLocationPath('#/pricing?checkout=hash-value', '?checkout=browser-value'), '/pricing?checkout=hash-value');
  assert.equal(routes.legacyLocationPath('#main', '?checkout=order-approved'), null);
});

test('invalid and non-route fragments are not converted to application paths', () => {
  assert.equal(routes.legacyHashPath('#main'), null);
  assert.equal(routes.legacyHashPath('#/unknown'), null);
  assert.equal(routes.legacyHashPath('#/event/%2Fprivate'), null);
  assert.equal(routes.legacyHashPath('#/event/one/two'), null);
});

test('clean application paths resolve to the matching interactive views', () => {
  assert.deepEqual(routes.routeForPath('/'), { page:'explore' });
  assert.deepEqual(routes.routeForPath('/news/story-one'), { page:'news', id:'story-one' });
  assert.deepEqual(routes.routeForPath('/threads/story-one'), { page:'event', id:'story-one' });
  assert.deepEqual(routes.routeForPath('/threads'), { page:'timelines' });
  assert.deepEqual(routes.routeForPath('/economy/IND'), { page:'economy', id:'IND' });
  assert.deepEqual(routes.routeForPath('/following'), { page:'following' });
  assert.deepEqual(routes.routeForPath('/pricing'), { page:'billing' });
  assert.deepEqual(routes.routeForPath('/billing'), { page:'billing' });
  assert.deepEqual(routes.routeForPath('/corrections'), { page:'corrections' });
  assert.deepEqual(routes.routeForPath('/threads/story-one/'), { page:'event', id:'story-one' });
  assert.deepEqual(routes.routeForPath('/news/story-one/extra'), { page:'not-found' });
  assert.deepEqual(routes.routeForPath('/sources/extra'), { page:'not-found' });
  assert.deepEqual(routes.routeForPath('/news//story-one'), { page:'not-found' });
});

test('only known application routes are intercepted for in-app navigation', () => {
  assert.equal(routes.appPath('/threads/story-one'), true);
  assert.equal(routes.appPath('/economy/IND'), true);
  assert.equal(routes.appPath('/threads/story-one/'), true);
  assert.equal(routes.appPath('/api/health'), false);
  assert.equal(routes.appPath('/unknown/path'), false);
});
