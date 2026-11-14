import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyPwaDeployment(appOrigin = process.env.APP_ORIGIN || 'https://threadnews.online', fetchImpl = fetch) {
  let origin;
  try {
    origin = new URL(appOrigin);
  } catch {
    throw new Error('APP_ORIGIN must be a valid URL.');
  }

  const hostname = origin.hostname.replace(/^\[|\]$/g, '');
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  if (!['https:', 'http:'].includes(origin.protocol) || (origin.protocol !== 'https:' && !isLocal)) {
    throw new Error('APP_ORIGIN must use HTTPS, except for localhost smoke checks.');
  }
  if (origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('APP_ORIGIN must be an origin without a path, query, or fragment.');
  }

  const base = origin.origin;
  const fetchAsset = async path => {
    const response = await fetchImpl(new URL(path, base), {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
    return { response, body: Buffer.from(await response.arrayBuffer()) };
  };

  const requireType = (path, response, allowed) => {
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!allowed.includes(type)) {
      throw new Error(path + ' returned unexpected Content-Type: ' + (type || '(missing)'));
    }
  };

  const [{ response: pageResponse, body: pageBody }, { response: manifestResponse, body: manifestBody }, { response: workerResponse, body: workerBody }, { response: offlineResponse }, { response: installResponse }] = await Promise.all([
    fetchAsset('/'),
    fetchAsset('/manifest.webmanifest'),
    fetchAsset('/sw.js'),
    fetchAsset('/offline.html'),
    fetchAsset('/install.js')
  ]);

  requireType('/', pageResponse, ['text/html']);
  requireType('/manifest.webmanifest', manifestResponse, ['application/manifest+json', 'application/json', 'text/json']);
  requireType('/sw.js', workerResponse, ['application/javascript', 'text/javascript', 'application/x-javascript']);
  requireType('/offline.html', offlineResponse, ['text/html']);
  requireType('/install.js', installResponse, ['application/javascript', 'text/javascript', 'application/x-javascript']);

  const page = pageBody.toString('utf8');
  if (!page.includes('rel="manifest"') || !page.includes('apple-touch-icon') || !page.includes('install.js')) {
    throw new Error('The deployed page does not link its PWA manifest, Apple icon, and install helper.');
  }

  const manifest = JSON.parse(manifestBody.toString('utf8'));
  if (manifest.display !== 'standalone' || manifest.start_url !== '/' || manifest.scope !== '/') {
    throw new Error('The deployed manifest does not define the expected standalone app scope.');
  }

  if (!Array.isArray(manifest.icons)) throw new Error('The deployed manifest has no icon list.');
  const iconHas = (size, purpose) => manifest.icons.some(icon => {
    const purposes = (icon.purpose || 'any').split(/\s+/);
    return icon.type === 'image/png'
      && icon.sizes.split(/\s+/).includes(size)
      && purposes.includes(purpose);
  });
  if (!iconHas('192x192', 'any') || !iconHas('512x512', 'any') || !iconHas('512x512', 'maskable')) {
    throw new Error('The deployed manifest is missing standard Android or maskable app icons.');
  }

  const iconPaths = manifest.icons.map(icon => {
    if (typeof icon.src !== 'string' || !icon.src.startsWith('/') || icon.src.startsWith('//')) {
      throw new Error('PWA icon paths must be same-origin absolute paths.');
    }
    return icon.src;
  });
  const pngPaths = new Set([
    '/icons/apple-touch-icon.png',
    ...iconPaths
  ]);
  for (const path of pngPaths) {
    const { response, body } = await fetchAsset(path);
    requireType(path, response, ['image/png']);
    if (body.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error(path + ' is not a PNG image.');
    }
    const icon = manifest.icons.find(candidate => candidate.src === path);
    if (icon) {
      const dimensions = body.readUInt32BE(16) + 'x' + body.readUInt32BE(20);
      if (!icon.sizes.split(/\s+/).includes(dimensions)) {
        throw new Error(path + ' does not match its declared manifest size.');
      }
    } else if (body.readUInt32BE(16) !== 180 || body.readUInt32BE(20) !== 180) {
      throw new Error(path + ' must be 180x180 for the iOS home-screen icon.');
    }
  }

  const worker = workerBody.toString('utf8');
  if (!worker.includes("request.mode === 'navigate'") || !worker.includes("caches.match('/offline.html')")) {
    throw new Error('The deployed service worker does not provide the offline navigation fallback.');
  }

  return { base, iconCount: pngPaths.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await verifyPwaDeployment();
    console.log('Verified the deployed ThreadNews PWA at ' + result.base + ' (manifest, icons, install helper, service worker and offline page).');
  } catch (error) {
    console.error('PWA deployment check failed: ' + error.message);
    process.exitCode = 1;
  }
}
