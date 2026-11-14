import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { canonicalOrigin, handleSeo } from '../src/seo.js';

const host = 'https://threadnews.online';
const shell = '<!doctype html><html><head><title>ThreadNews — The whole story, unfolding</title><meta name="description" content="Old description"></head><body><main id="main" tabindex="-1"></main><script src="/app.js"></script></body></html>';
const event = {
  id: 'story-one', title: 'A selected history', shortTitle: 'A selected history', description: 'A source-linked event chronology.',
  coverageEnd: '2026-11-02', milestones: [{ date:'2026-11-02', title:'A documented update', summary:'The primary record describes a dated development.', kind:'Official record', sources:[{publisher:'Agency',title:'Original statement',type:'Government statement',url:'https://example.gov/release'}] }]
};
function assets(extra = {}) {
  const files = {
    '/': new Response(shell, { headers:{'content-type':'text/html'} }),
    '/timeline-data.json': Response.json({ events:[event] }),
    '/news-data.json': Response.json({ articles:[{id:'story-news',title:'A current headline',category:'Economy',publishedAt:'2026-11-03T12:00:00Z',source:{publisher:'Example News',url:'https://example.com/story',basis:'headline'}}] }),
    '/economy-data.json': Response.json({ countries:[{code:'IN',iso3:'IND',name:'India',region:'South Asia',gdpGrowth:[{year:2024,value:6.5},{year:2025,value:7.1}],inflation:[{year:2024,value:4.9}],latestInflation:{period:'2026-09',value:5.54,unit:'percent',status:'Provisional monthly observation',source:{publisher:'Statistics Office',url:'https://example.gov/cpi'}}}], meta:{asOf:'2026-11-03'} }),
    ...extra
  };
  return { async fetch(request) { return files[new URL(request.url).pathname] || new Response('not found',{status:404}); } };
}

test('canonical origin uses the configured custom host while OAuth origin stays separate', () => {
  assert.equal(canonicalOrigin(new Request('https://threadnews.example.com/'), { BASE_URL:'https://threadnews.online', CANONICAL_HOST:'threadnews.online' }), host);
  assert.equal(canonicalOrigin(new Request('http://127.0.0.1:4173/'), { BASE_URL:host, CANONICAL_HOST:'threadnews.online' }), 'http://127.0.0.1:4173');
});

test('legacy workers.dev public URLs redirect to the canonical host and preserve the path/query', async () => {
  const response = await worker.fetch(new Request('https://threadnews.example.com/threads/story-one?source=share'), { BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  assert.equal(response.status,301);
  assert.equal(response.headers.get('location'),`${host}/threads/story-one?source=share`);
  assert.equal(await handleSeo(new Request('https://threadnews.example.com/api/auth/google/start'), { CANONICAL_HOST:'threadnews.online' }, {}), null);
  const signIn = await worker.fetch(new Request('https://threadnews.example.com/signin'), { BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  assert.equal(signIn.status,301);
  assert.equal(signIn.headers.get('location'),`${host}/signin`);
});

test('robots.txt points to the canonical sitemap and excludes private/API routes', async () => {
  const response = await worker.fetch(new Request(`${host}/robots.txt`), { BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  const body = await response.text();
  assert.equal(response.status,200);
  assert.match(body,/Disallow: \/api\//);
  assert.match(body,/Disallow: \/account/);
  assert.match(body,/Disallow: \/following/);
  assert.match(body,/Disallow: \/signin/);
  assert.match(body,/Sitemap: https:\/\/threadnews\.online\/sitemap\.xml/);
});

test('sitemap includes current edition records with canonical public paths', async () => {
  const response = await worker.fetch(new Request(`${host}/sitemap.xml`), { NEWS_STORAGE:'static', ASSETS:assets(), BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  const body = await response.text();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/xml; charset=utf-8');
  assert.match(body,/<loc>https:\/\/threadnews\.online\/threads\/story-one<\/loc>/);
  assert.match(body,/<loc>https:\/\/threadnews\.online\/news\/story-news<\/loc>/);
  assert.match(body,/<loc>https:\/\/threadnews\.online\/economy\/IND<\/loc>/);
  assert.doesNotMatch(body,/workers\.dev/);
});

test('timeline path returns server-rendered content, canonical metadata and the interactive app shell', async () => {
  const response = await worker.fetch(new Request(`${host}/threads/story-one`), { NEWS_STORAGE:'static', ASSETS:assets(), BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  const body = await response.text();
  assert.equal(response.status,200);
  assert.match(body,/<title>A selected history — ThreadNews<\/title>/);
  assert.match(body,/rel="canonical" href="https:\/\/threadnews\.online\/threads\/story-one"/);
  assert.match(body,/A documented update/);
  assert.match(body,/https:\/\/example\.gov\/release/);
  assert.match(body,/<script src="\/app\.js"><\/script>/);
});

test('news home has meaningful HTML before client scripts execute', async () => {
  const response = await worker.fetch(new Request(`${host}/`), { NEWS_STORAGE:'static', ASSETS:assets(), BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  const body = await response.text();
  assert.equal(response.status,200);
  assert.match(body,/<h1>Recent news, with the source close\.<\/h1>/);
  assert.match(body,/A current headline/);
  assert.match(body,/Read at Example News/);
});

test('pricing is server-rendered from the shared plan catalog and keeps checkout visibly disabled by default', async () => {
  const response = await worker.fetch(new Request(`${host}/pricing`), { ASSETS:assets(), BASE_URL:host, CANONICAL_HOST:'threadnews.online', BILLING_ENABLED:'false' }, {});
  const body = await response.text();
  assert.equal(response.status,200);
  assert.match(body,/<h1>Membership<\/h1>/);
  assert.match(body,/\$2\.00 USD/);
  assert.match(body,/\$20\.00 USD/);
  assert.match(body,/free through 30 November 2026/);
  assert.match(body,/Checkout is currently unavailable/);
  assert.match(body,/href="\/terms"/);
});

test('billing alias redirects to pricing and draft terms and explicit 404 have correct status', async () => {
  const alias = await worker.fetch(new Request(`${host}/billing?plan=annual`), { BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  assert.equal(alias.status,301);
  assert.equal(alias.headers.get('location'),`${host}/pricing?plan=annual`);
  const terms = await worker.fetch(new Request(`${host}/terms`), { ASSETS:assets(), BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  assert.equal(terms.status,200);
  const termsBody = await terms.text();
  assert.match(termsBody,/Draft — operator review is still required; live checkout is not active/);
  assert.match(termsBody,/free for everyone through 30 November 2026/);
  assert.match(termsBody,/\$2 USD per month and \$20 USD per year/);
  const notFound = await worker.fetch(new Request(`${host}/404`), { ASSETS:assets(), BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  assert.equal(notFound.status,404);
});

test('news article paths render the source record without claiming a headline-only digest', async () => {
  const response = await worker.fetch(new Request(`${host}/news/story-news`), { NEWS_STORAGE:'static', ASSETS:assets(), BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  const body = await response.text();
  assert.equal(response.status,200);
  assert.match(body,/<h1>A current headline<\/h1>/);
  assert.match(body,/href="https:\/\/example\.com\/story" rel="noopener noreferrer">Read at Example News/);
  assert.doesNotMatch(body,/Headline-based discovery item/);
});

test('production SSR does not substitute the bundled snapshot when D1 is missing', async () => {
  const response = await worker.fetch(new Request(`${host}/`), { NEWS_STORAGE:'d1', ASSETS:assets(), BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  const body = await response.text();
  assert.equal(response.status,503);
  assert.match(body,/live news archive is temporarily unavailable/);
  assert.doesNotMatch(body,/A current headline/);
});

test('country economy path server-renders sourced annual history and the latest-period CPI label', async () => {
  const response = await worker.fetch(new Request(`${host}/economy/IND`), { NEWS_STORAGE:'static', ASSETS:assets(), BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  const body = await response.text();
  assert.equal(response.status,200);
  assert.match(body,/<h1>India: economic history<\/h1>/);
  assert.match(body,/2026-09/);
  assert.match(body,/Provisional monthly observation/);
  assert.match(body,/Annual percent change; missing values are not estimates/);
});

test('HEAD for crawler endpoints sends headers without a response body', async () => {
  const response = await worker.fetch(new Request(`${host}/robots.txt`, { method:'HEAD' }), { BASE_URL:host, CANONICAL_HOST:'threadnews.online' }, {});
  assert.equal(response.status,200);
  assert.equal(await response.text(),'');
});
