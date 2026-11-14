/* Stable public paths shared by the app router and legacy hash-link migration. */
(function(root) {
  'use strict';
  const safeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
  const staticPaths = new Set([
    '/', '/news', '/threads', '/economy', '/sources', '/method', '/about', '/ask',
    '/privacy', '/corrections', '/account', '/following', '/coverage', '/signin', '/pricing', '/billing'
  ]);
  function decodePathId(value) {
    try {
      const id = decodeURIComponent(value);
      return safeId.test(id) ? id : null;
    } catch { return null; }
  }

  function normalizedPath(pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.includes('//')) return null;
    return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0,-1) : pathname;
  }

  function appPath(pathname) {
    const path=normalizedPath(pathname);
    if (!path) return false;
    if (staticPaths.has(path) || /^\/economy\/[A-Za-z0-9-]{2,80}$/.test(path)) return true;
    const recordPath = /^\/(?:news|threads)\/([^/]+)$/.exec(path);
    return Boolean(recordPath && decodePathId(recordPath[1]));
  }

  function legacyHashPath(hash) {
    if (typeof hash !== 'string' || !hash.startsWith('#/')) return null;
    const fragment = hash.slice(2);
    const queryAt = fragment.indexOf('?');
    const routeText = queryAt < 0 ? fragment : fragment.slice(0, queryAt);
    const search = queryAt < 0 ? '' : `?${fragment.slice(queryAt + 1)}`;
    if(routeText.includes('//'))return null;
    const parts = routeText ? routeText.split('/') : [];
    const page = parts[0] || 'explore';
    if (parts.length > 2) return null;
    let id = null;
    if (parts[1]) {
      try { id = decodeURIComponent(parts[1]); } catch { return null; }
      if (!safeId.test(id)) return null;
    }
    let path;
    if (page === 'explore') path = '/';
    else if (page === 'event') path = id ? `/threads/${encodeURIComponent(id)}` : null;
    else if (page === 'timelines' || page === 'threads') path = id ? `/threads/${encodeURIComponent(id)}` : '/threads';
    else if (page === 'news') path = id ? `/news/${encodeURIComponent(id)}` : '/news';
    else if (page === 'economy') path = id ? `/economy/${encodeURIComponent(id)}` : '/economy';
    else if (['sources','method','about','privacy','corrections','account','following','coverage','signin','pricing','billing','ask'].includes(page) && !id) path = `/${page}`;
    else return null;
    return `${path}${search}`;
  }

  // A legacy URL can carry meaningful parameters before its route fragment,
  // as PayPal does for checkout returns: /?checkout=...#/pricing. Preserve
  // those parameters when replacing the hash route with its clean path.
  function legacyLocationPath(hash, browserSearch) {
    const path = legacyHashPath(hash);
    if (!path) return null;
    const queryAt = path.indexOf('?');
    const pathname = queryAt < 0 ? path : path.slice(0, queryAt);
    const params = new URLSearchParams(queryAt < 0 ? '' : path.slice(queryAt + 1));
    const incoming = new URLSearchParams(typeof browserSearch === 'string' ? browserSearch.replace(/^\?/, '') : '');
    for (const [key, value] of incoming) if (!params.has(key)) params.append(key, value);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function routeForPath(pathname) {
    const path=normalizedPath(pathname || '/');
    if(!path||!appPath(path))return {page:'not-found'};
    const parts = path === '/' ? [] : path.slice(1).split('/');
    if (!parts.length) return { page:'explore' };
    const [section, rawId] = parts;
    const id = rawId ? decodePathId(rawId) : null;
    if (section === 'news') return id ? { page:'news', id } : { page:'explore' };
    if (section === 'threads') return id ? { page:'event', id } : { page:'timelines' };
    if (section === 'economy') return { page:'economy', id };
    if (section === 'following') return { page:'following' };
    if (['sources','about','privacy','corrections','account','coverage','signin','ask'].includes(section) && parts.length===1) return { page:section };
    if (['pricing','billing'].includes(section) && parts.length===1) return { page:'billing' };
    if(section==='following'&&parts.length===1)return {page:'following'};
    if (section === 'method') return { page:'about' };
    return { page:'not-found' };
  }

  const api = Object.freeze({ appPath, legacyHashPath, legacyLocationPath, routeForPath });
  root.ThreadNewsPublicRoutes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
