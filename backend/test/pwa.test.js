import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../web/public-routes.js';
import { verifyPwaDeployment } from '../scripts/verify-pwa-deployment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFile(resolve(root, path), 'utf8');
const manifest = JSON.parse(await read('web/manifest.webmanifest'));

test('web manifest describes an installable, standalone ThreadNews app', () => {
  assert.equal(manifest.name, 'ThreadNews');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));

  for (const shortcut of manifest.shortcuts) {
    const path = new URL(shortcut.url, 'https://threadnews.online').pathname;
    assert.notEqual(globalThis.ThreadNewsPublicRoutes.routeForPath(path).page, 'not-found');
  }
});

test('manifest and Apple touch icons exist as PNGs at their declared sizes', async () => {
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    const file = await readFile(resolve(root, 'web', icon.src.slice(1)));
    assert.equal(file.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(file.readUInt32BE(16), width, icon.src + ' width');
    assert.equal(file.readUInt32BE(20), height, icon.src + ' height');
  }

  const appleIcon = await readFile(resolve(root, 'web/icons/apple-touch-icon.png'));
  assert.equal(appleIcon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(appleIcon.readUInt32BE(16), 180);
  assert.equal(appleIcon.readUInt32BE(20), 180);
});

test('site shell links the install metadata, iOS home-screen icon and install help', async () => {
  const html = await read('web/index.html');
  assert.match(html, /rel=\"manifest\" href=\"\/manifest\.webmanifest\"/);
  assert.match(html, /rel=\"apple-touch-icon\" sizes=\"180x180\" href=\"\/icons\/apple-touch-icon\.png\"/);
  assert.match(html, /name=\"apple-mobile-web-app-capable\" content=\"yes\"/);
  assert.match(html, /id=\"install-app-button\"/);
  assert.match(html, /id=\"install-app-dialog\"/);
  assert.match(html, /src=\"install\.js\?/);
});

test('service worker gives failed navigations an offline page and leaves APIs online-only', async () => {
  const sw = await read('web/sw.js');
  assert.match(sw, /caches\.open\(CACHE_NAME\)[\s\S]*cache\.addAll\(PRECACHE_URLS\)/);
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(sw, /caches\.match\('\/offline\.html'\)/);
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /url\.pathname === '\/app-config\.js'/);
});

test('Cloudflare deployment packages the web folder and verifies the source release in CI', async () => {
  const config = JSON.parse(await read('backend/wrangler.jsonc'));
  const pkg = JSON.parse(await read('backend/package.json'));
  const workflow = await read('.github/workflows/check.yml');

  assert.equal(config.assets.directory, '../web');
  assert.match(pkg.scripts.check, /node --check \.\.\/web\/install\.js/);
  assert.match(pkg.scripts.check, /node --check \.\.\/web\/sw\.js/);
  assert.match(pkg.scripts['build:check'], /wrangler deploy --dry-run/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build:check/);
});

test('deployment smoke check reads the served install assets and validates their response types', async () => {
  const requested = [];
  const fakeFetch = async request => {
    const pathname = new URL(request).pathname;
    requested.push(pathname);
    const assetPath = pathname === '/' ? 'web/index.html' : 'web' + pathname;
    const type = pathname.endsWith('.png') ? 'image/png'
      : pathname.endsWith('.webmanifest') ? 'application/manifest+json'
        : pathname.endsWith('.html') || pathname === '/' ? 'text/html'
          : 'application/javascript';
    const body = pathname.endsWith('.png')
      ? await readFile(resolve(root, assetPath))
      : await read(assetPath);
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  };

  const result = await verifyPwaDeployment('http://localhost:8791', fakeFetch);
  assert.equal(result.base, 'http://localhost:8791');
  assert.equal(result.iconCount, 4);
  assert.ok(requested.includes('/manifest.webmanifest'));
  assert.ok(requested.includes('/sw.js'));
  assert.ok(requested.includes('/offline.html'));
  assert.ok(requested.includes('/icons/apple-touch-icon.png'));
});

test('deployment smoke check rejects insecure public origins before making requests', async () => {
  await assert.rejects(
    verifyPwaDeployment('http://threadnews.online', () => assert.fail('No request should be made.')),
    /must use HTTPS/
  );
});

test('deployment smoke check refuses cross-origin icon URLs from a deployed manifest', async () => {
  const requested = [];
  const fakeFetch = async request => {
    const url = new URL(request);
    requested.push(url.href);
    if (url.pathname === '/manifest.webmanifest') {
      const poisoned = {
        ...manifest,
        icons: [...manifest.icons, {
          src: 'https://outside.example/icon.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any'
        }]
      };
      return new Response(JSON.stringify(poisoned), {
        status: 200,
        headers: { 'content-type': 'application/manifest+json' }
      });
    }
    const assetPath = url.pathname === '/' ? 'web/index.html' : 'web' + url.pathname;
    const type = url.pathname.endsWith('.webmanifest') ? 'application/manifest+json'
      : url.pathname.endsWith('.html') || url.pathname === '/' ? 'text/html'
        : 'application/javascript';
    return new Response(await read(assetPath), { status: 200, headers: { 'content-type': type } });
  };

  await assert.rejects(
    verifyPwaDeployment('https://threadnews.online', fakeFetch),
    /same-origin absolute paths/
  );
  assert.ok(!requested.some(url => url.includes('outside.example')));
});
