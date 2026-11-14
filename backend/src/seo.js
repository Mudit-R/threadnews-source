import { handleContent } from './content.js';
import { privacyNotice } from './auth.js';
import { runtimeNewsFeeds } from './refresh.js';
import { publicPlans } from './paypal.js';
import { termsMarkup } from './terms.js';

const STATIC_ROUTES = new Set(['/','/news','/threads','/economy','/ask','/sources','/method','/about','/privacy','/corrections','/pricing','/billing','/terms','/404','/account','/following','/coverage','/signin','/robots.txt','/sitemap.xml']);
const PAGE_CACHE_SECONDS = 60;
const SITEMAP_CACHE_SECONDS = 3600;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const escapeXml = value => escapeHtml(value);
const validHttpUrl = value => { try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) ? url.href : null; } catch { return null; } };

function canonicalHost(env) {
  if (typeof env.CANONICAL_HOST !== 'string' || !env.CANONICAL_HOST.trim()) return null;
  const raw = env.CANONICAL_HOST.trim();
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.host.toLowerCase();
  } catch { return null; }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function canonicalOrigin(request, env = {}) {
  const host = canonicalHost(env);
  const requestUrl = new URL(request.url);
  if (isLocalHost(requestUrl.hostname)) return requestUrl.origin;
  if (host) return `https://${host}`;
  for (const candidate of [env.BASE_URL, env.APP_ORIGIN, requestUrl.origin]) {
    try {
      const url = new URL(candidate);
      if (['https:','http:'].includes(url.protocol) && !url.username && !url.password) return url.origin;
    } catch {}
  }
  return new URL(request.url).origin;
}

function publicPath(path) {
  return STATIC_ROUTES.has(path) || /^\/(?:news|threads)\/[A-Za-z0-9][A-Za-z0-9_.:%-]{0,179}$/.test(path) || /^\/economy\/[A-Za-z0-9-]{2,80}$/.test(path);
}

function canonicalRedirect(request, env, path) {
  const host = canonicalHost(env);
  if (!host || !['GET','HEAD'].includes(request.method) || !publicPath(path)) return null;
  const current = new URL(request.url);
  if (isLocalHost(current.hostname)) return null;
  if (current.host.toLowerCase() === host && current.protocol === 'https:') return null;
  const target = new URL(`https://${host}`);
  target.pathname = current.pathname;
  target.search = current.search;
  return Response.redirect(target.href, 301);
}

async function assetJson(request, env, path) {
  if (!env.ASSETS) return null;
  try {
    const url = new URL(path, request.url);
    const response = await env.ASSETS.fetch(new Request(url));
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

async function apiJson(request, env, ctx, path) {
  const internal = new Request(new URL(path, request.url), { method: 'GET' });
  const response = await handleContent(internal, env, ctx, { canAccessArchive: false });
  if (!response?.ok) return { error: response?.status === 404 ? 'not_found' : 'unavailable', status: response?.status || 503 };
  try { return await response.json(); } catch { return { error: 'unavailable', status: 503 }; }
}

async function newsData(request, env, ctx, limit = 12) {
  if (env.NEWS_STORAGE === 'static') {
    const snapshot = await assetJson(request, env, '/news-data.json');
    const records = Array.isArray(snapshot) ? snapshot : snapshot?.articles || snapshot?.items || [];
    return { articles: records.slice(0, limit), meta: snapshot?.meta || {} };
  }
  if (!env.DB) return { error:'unavailable', status:503 };
  return apiJson(request, env, ctx, `/api/news?limit=${limit}`);
}

async function singleNews(request, env, ctx, id) {
  if (env.NEWS_STORAGE === 'static') {
    const snapshot = await assetJson(request, env, '/news-data.json');
    const records = Array.isArray(snapshot) ? snapshot : snapshot?.articles || snapshot?.items || [];
    const article = records.find(record => record?.id === id);
    return article ? { article } : { error:'not_found', status:404 };
  }
  return env.DB ? apiJson(request, env, ctx, `/api/news/${encodeURIComponent(id)}`) : { error:'unavailable', status:503 };
}

async function eventData(request, env, ctx, id) {
  if (env.NEWS_STORAGE === 'static') {
    const snapshot = await assetJson(request, env, '/timeline-data.json');
    const events = Array.isArray(snapshot) ? snapshot : snapshot?.events || [];
    const event = events.find(record => record?.id === id);
    return event ? { event } : { error: 'not_found', status: 404 };
  }
  return env.DB ? apiJson(request, env, ctx, `/api/events/${encodeURIComponent(id)}`) : { error:'unavailable', status:503 };
}

async function eventList(request, env, ctx) {
  if (env.NEWS_STORAGE === 'static') {
    const snapshot = await assetJson(request, env, '/timeline-data.json');
    const events = Array.isArray(snapshot) ? snapshot : snapshot?.events || [];
    return { events, meta: snapshot?.meta || {} };
  }
  return env.DB ? apiJson(request, env, ctx, '/api/events?limit=100') : { error:'unavailable', status:503 };
}

async function economyData(request, env, ctx) {
  if (env.NEWS_STORAGE !== 'static') {
    if (!env.DB) return null;
    const response = await handleContent(new Request(new URL('/api/economy', request.url)), env, ctx, { canAccessArchive: false });
    if (response?.ok) { try { return await response.json(); } catch {} }
    return null;
  }
  return assetJson(request, env, '/economy-data.json');
}

function digest(article) {
  const basis = article?.digestBasis ?? article?.metadata?.digestBasis ?? article?.metadata?.digest_basis;
  if (['headline-only','headline_only'].includes(basis)) return '';
  const summary = typeof article?.summary === 'string' ? article.summary.trim() : '';
  if (!summary || /^(?:Headline-based discovery item\.|Official-source headline\.|Headline discovered through GDELT\.)/i.test(summary)) return '';
  if (!['article-reviewed','full_text','abstract','feed-description'].includes(basis) || summary.split(/\s+/).length > 40) return '';
  return summary;
}

function articleHref(article) {
  const source = article?.source || {};
  for (const value of [source.publisherArticleUrl, source.articleUrl, source.url]) {
    const href = validHttpUrl(value);
    if (!href) continue;
    const url = new URL(href);
    if (url.hostname === 'threadnews.online' || url.hostname.endsWith('.threadnews.online') || url.hostname.endsWith('.workers.dev')) continue;
    return href;
  }
  return '#';
}

function dateText(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function articleMarkup(article) {
  const id = String(article.id || '');
  const title = escapeHtml(article.title || article.originalHeadline || 'Untitled story');
  const source = article.source || {};
  const href = articleHref(article);
  const viaGoogle = (() => { try { return new URL(href).hostname === 'news.google.com'; } catch { return false; } })();
  const published = dateText(article.publishedAt || article.published_at);
  const summary = digest(article);
  return `<article class="seo-news-item"><h2><a href="/news/${encodeURIComponent(id)}">${title}</a></h2><p class="seo-meta"><strong>${escapeHtml(source.publisher || article.publisher || 'Publisher not recorded')}</strong>${published ? ` · <time datetime="${escapeHtml(published)}">${escapeHtml(published.slice(0,10))}</time>` : ''}${article.category ? ` · ${escapeHtml(article.category)}` : ''}</p>${summary ? `<p>${escapeHtml(summary)}</p>` : ''}<p><a href="${escapeHtml(href)}" rel="noopener noreferrer">${viaGoogle ? 'Open this item via Google News' : `Read at ${escapeHtml(source.publisher || article.publisher || 'the publisher')}`}</a>${article.eventId ? ` · <a href="/threads/${encodeURIComponent(article.eventId)}">Open the related timeline</a>` : ''}</p></article>`;
}

function eventMarkup(event) {
  const title = escapeHtml(event.title || event.shortTitle || 'Timeline');
  const milestones = Array.isArray(event.milestones) ? event.milestones : [];
  const entries = milestones.map((item, index) => {
    const sources = Array.isArray(item.sources) ? item.sources : [];
    const label = item.datePrecision === 'month' ? item.date?.slice(0, 7) : item.date;
    return `<li><article><p class="seo-meta"><time datetime="${escapeHtml(label || '')}">${escapeHtml(label || 'Date not recorded')}</time> · ${escapeHtml(item.kind || 'Timeline entry')}</p><h2>${escapeHtml(item.title || `Development ${index + 1}`)}</h2>${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}${sources.length ? `<ul>${sources.map(source => { const href=validHttpUrl(source.url); return href ? `<li><a href="${escapeHtml(href)}" rel="noopener noreferrer">${escapeHtml(source.publisher || source.title || 'Original source')}: ${escapeHtml(source.title || 'Read the record')}</a>${source.type ? ` · ${escapeHtml(source.type)}` : ''}</li>` : ''; }).join('')}</ul>` : ''}</article></li>`;
  }).join('');
  return `<article class="seo-timeline"><p>${escapeHtml(event.description || '')}</p><p class="seo-meta">${milestones.length} selected developments${event.coverageEnd ? ` · chronology through ${escapeHtml(event.coverageEnd)}` : ''}</p>${event.limitation ? `<p>${escapeHtml(event.limitation)}</p>` : ''}<ol>${entries}</ol><p><a href="/threads">Browse all timelines</a> · <a href="/news">Latest news</a></p></article>`;
}

function economyMarkup(data) {
  const countries = Array.isArray(data?.countries) ? data.countries : [];
  const rows = countries.map(country => {
    const latest = records => (Array.isArray(records) ? records : []).filter(record => Number.isFinite(Number(record?.value))).sort((a,b) => String(b.year || b.period || '').localeCompare(String(a.year || a.period || '')))[0];
    const gdp = latest(country.gdpGrowth), inflation = latest(country.inflation);
    const value = record => record ? `${escapeHtml(record.value)}% (${escapeHtml(record.year || record.period || '')})` : 'No observation in this snapshot';
    const code = String(country.iso3 || country.code || '');
    return `<tr><th scope="row"><a href="/economy/${encodeURIComponent(code)}">${escapeHtml(country.name || code)}</a></th><td>${value(gdp)}</td><td>${value(inflation)}</td></tr>`;
  }).join('');
  const asOf = data?.meta?.asOf || data?.meta?.asOfDate || '';
  return `<section><p>Officially sourced economic history. Values have different release dates and national definitions; do not read the latest rows as a like-for-like country ranking.</p>${asOf ? `<p class="seo-meta">Snapshot checked ${escapeHtml(asOf)}.</p>` : ''}<div class="seo-table-wrap"><table><caption>Latest annual observations in the available history</caption><thead><tr><th>Economy</th><th>Real GDP growth</th><th>Consumer-price inflation</th></tr></thead><tbody>${rows}</tbody></table></div><p><a href="/economy">Open the interactive economy view</a></p></section>`;
}

function countryEconomyMarkup(country, data) {
  const years = [...new Set([...(country.gdpGrowth || []), ...(country.inflation || [])].map(record => Number(record.year)).filter(Number.isInteger))].sort((a,b)=>a-b);
  const gdp = new Map((country.gdpGrowth || []).map(record => [Number(record.year), record.value]));
  const inflation = new Map((country.inflation || []).map(record => [Number(record.year), record.value]));
  const cell = value => typeof value === 'number' && Number.isFinite(value) ? `${escapeHtml(value)}%` : 'Not reported';
  const rows = years.map(year => `<tr><th scope="row">${year}</th><td>${cell(gdp.get(year))}</td><td>${cell(inflation.get(year))}</td></tr>`).join('');
  const latest = country.latestInflation;
  const latestCard = latest && typeof latest.value === 'number' ? `<section><h2>Latest national CPI readout</h2><p><strong>${escapeHtml(latest.value)}% · ${escapeHtml(latest.period || 'period not recorded')}</strong> · ${escapeHtml(latest.status || latest.measure || 'CPI observation')}</p><p>${escapeHtml(latest.series || '')}${latest.releaseDate ? ` · release ${escapeHtml(latest.releaseDate)}` : ''}</p>${latest.comparabilityNotes ? `<p>${escapeHtml(latest.comparabilityNotes)}</p>` : ''}${validHttpUrl(latest.source?.url) ? `<p><a href="${escapeHtml(latest.source.url)}" rel="noopener noreferrer">${escapeHtml(latest.source.publisher || 'Read the official release')}${latest.source.title ? `: ${escapeHtml(latest.source.title)}` : ''}</a></p>` : ''}</section>` : '<section><h2>Latest national CPI readout</h2><p>No monthly or quarterly observation is recorded in this snapshot.</p></section>';
  const sourceRows = [country.gdpGrowthSource, country.inflationSource].filter(source => validHttpUrl(source?.url)).map(source => `<li><a href="${escapeHtml(source.url)}" rel="noopener noreferrer">${escapeHtml(source.publisher || source.title || 'Source')}</a>${source.title ? ` · ${escapeHtml(source.title)}` : ''}</li>`).join('');
  return `<p>${escapeHtml(country.note || '')}</p><p class="seo-meta">${escapeHtml(country.region || '')} · latest annual history: ${years.filter(year => typeof gdp.get(year)==='number' || typeof inflation.get(year)==='number').at(-1) || 'not recorded'} · snapshot ${escapeHtml(data.meta?.asOf || data.meta?.asOfDate || 'date not recorded')}</p>${latestCard}<section><h2>Annual history</h2><div class="seo-table-wrap"><table><caption>Annual percent change; missing values are not estimates</caption><thead><tr><th>Year</th><th>Real GDP growth</th><th>Consumer-price inflation</th></tr></thead><tbody>${rows}</tbody></table></div></section>${sourceRows ? `<section><h2>Definitions and source records</h2><ul>${sourceRows}</ul></section>` : ''}<p><a href="/economy">Compare G20 economic history</a></p>`;
}

function staticMarkup(path, env) {
  if(path==='/terms')return termsMarkup(env);
  if (path === '/' || path === '/news') return null;
  if (path === '/threads' || path === '/economy') return null;
  const pages = {
    '/ask': ['Ask ThreadNews', 'Ask about current reporting, documented timelines or official economic data and inspect the sources behind the answer.', '<p>Ask a question about news, a tracked story or a G20 economy. Ask ThreadNews looks up relevant public records and links each answer to the evidence it used.</p><p>Enable JavaScript to ask a question, or browse <a href="/threads">timelines</a> and <a href="/economy">official economic data</a>.</p>'],
    '/sources': ['Sources and evidence', 'How ThreadNews distinguishes publisher reporting, discovery links and official records.', `<p>ThreadNews links to publisher reporting and primary records. An official statement represents its issuer’s account; it is not independent verification. Feed inclusion does not imply a partnership or permission to reproduce full articles.</p><h2>Currently enabled feeds</h2><ul>${runtimeNewsFeeds(env).feeds.map(feed=>`<li>${escapeHtml(feed.publisher || feed.id)} · ${escapeHtml(feed.sourceType || 'Reporting')}</li>`).join('')}</ul><p><a href="/api/sources">Inspect the configured source registry</a>.</p>`],
    '/method': ['How ThreadNews works', 'Our approach to dates, source roles, timelines and evidence limits.', '<p>Current news begins with an attributed headline and its publisher link. A timeline groups selected, dated developments when historical context helps. Publication dates and event dates remain separate.</p><p>Source counts are not proof of independent corroboration. Official releases are labelled as institutional accounts. Coverage gaps and uncertainty should remain visible.</p>'],
    '/about': ['About ThreadNews', 'Recent news first, with source-linked timelines when a story has a longer history.', '<p>ThreadNews is a news publication focused on economic, political, international, infrastructure, health and energy developments that affect people. It pairs current coverage with longer-running timelines where reviewed records are available.</p><p>It does not claim perfect neutrality. It aims to make sources, dates, institutional roles and coverage limits inspectable.</p>'],
    '/privacy': ['Privacy at ThreadNews', 'What ThreadNews stores and what controls are available to readers.', null],
    '/corrections': ['Corrections', 'How to report a factual error in a ThreadNews record.', '<p>ThreadNews keeps source links and dates with its records. If you find an error or missing context, contact <a href="mailto:contactus@threadnews.online">contactus@threadnews.online</a> with the page link and the correction you are proposing.</p><p>A public correction log is not connected to the content database yet.</p>'],
    '/terms': ['Terms of use — draft', 'Draft membership terms and subscription timing for ThreadNews readers.', '<p><strong>Draft — operator review is still required; live checkout is not active.</strong> ThreadNews is free for everyone through 30 November 2026. The current proposed supporter prices are $2 USD per month and $20 USD per year. A subscription approved before 1 December 2026 is scheduled to begin recurring billing at 00:00 India Standard Time on 1 December. If approved on or after that date, billing begins according to the PayPal plan shown at checkout. Subscriptions renew automatically until cancelled. Readers can cancel in their ThreadNews account before a future charge. The operator must publish final refund, tax, governing-law and other required terms before enabling live checkout.</p><p>PayPal processes payment instruments; ThreadNews does not store card or bank details. ThreadNews links to independent publishers and public records. Those external sources retain their own content, rights and terms. ThreadNews does not republish full publisher articles.</p><p>Contact <a href="mailto:contactus@threadnews.online">contactus@threadnews.online</a> with questions about this draft.</p>']
  };
  const page = pages[path];
  if (!page) return null;
  if (path === '/privacy') {
    const notice = privacyNotice(env);
    const sections = notice.sections.map(section => `<section><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.text)}</p></section>`).join('');
    const contact = notice.contact ? `<p>Privacy contact: <a href="${escapeHtml(notice.contact)}">${escapeHtml(notice.contact.replace(/^mailto:/,''))}</a></p>` : '';
    return [notice.title, 'What ThreadNews stores and what controls are available to readers.', `<p>Updated ${escapeHtml(notice.updatedAt)}.${notice.operator ? ` Operator: ${escapeHtml(notice.operator)}.` : ''}</p>${contact}${sections}<p>Provider policies: ${notice.providers.map(provider => `<a href="${escapeHtml(provider.url)}" rel="noopener noreferrer">${escapeHtml(provider.name)}</a>`).join(' · ')}</p>`];
  }
  if (path === '/404') return ['Page not found', 'This ThreadNews page could not be found.', '<p>The link may have changed or the page may no longer be available.</p><p><a href="/news">Browse recent news</a> or <a href="/threads">open timelines</a>.</p>'];
  return page;
}

function pageDocument({ title, description, canonical, content, type = 'website', jsonLd = null, status = 200, template = '', includeApp = false }) {
  const titleText = `${title} — ThreadNews`;
  const safeJsonLd = jsonLd ? JSON.stringify(jsonLd).replace(/</g, '\\u003c') : '';
  const extraHead = `<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="${escapeHtml(type)}"><meta property="og:site_name" content="ThreadNews"><meta property="og:title" content="${escapeHtml(titleText)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escapeHtml(titleText)}"><meta name="twitter:description" content="${escapeHtml(description)}">${safeJsonLd ? `<script type="application/ld+json">${safeJsonLd}</script>` : ''}<style>.seo-content{max-width:1080px;margin:2rem auto;padding:0 1.5rem 4rem;color:#173e35}.seo-content h1{font-size:clamp(2rem,5vw,4rem);line-height:1.05}.seo-content h2{margin:1.5rem 0 .4rem}.seo-content a{color:#174f3c;text-decoration:underline;text-underline-offset:.18em}.seo-meta{color:#52655c}.seo-news-item,.seo-timeline li article{padding:1rem 0;border-bottom:1px solid #dce4dd}.seo-timeline ol{padding-left:1.3rem}.seo-table-wrap{overflow-x:auto}.seo-content table{width:100%;border-collapse:collapse}.seo-content th,.seo-content td{padding:.7rem;text-align:left;border-bottom:1px solid #dce4dd}.seo-content caption{text-align:left;margin:.6rem 0;font-weight:600}.seo-error{color:#8a271b}</style>`;
  let shell;
  if (includeApp && template) {
    shell = template
      .replace(/\b(src|href)="((?![a-z]+:|[\/#])[^"]+\.(?:css|js)(?:\?[^"]*)?)"/gi, '$1="/$2"')
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(titleText)}</title>`)
      .replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${escapeHtml(description)}">`)
      .replace('</head>', `${extraHead}</head>`)
      .replace(/<main id="main" tabindex="-1">[\s\S]*?<\/main>/i, `<main id="main" tabindex="-1">${content}</main>`);
  } else {
    shell = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(titleText)}</title><meta name="description" content="${escapeHtml(description)}">${extraHead}<link rel="stylesheet" href="/styles.css"></head><body><a class="skip-link" href="#main">Skip to content</a><main id="main" class="seo-content" tabindex="-1">${content}</main></body></html>`;
  }
  return new Response(shell, { status, headers: { 'content-type':'text/html; charset=utf-8', 'cache-control':`public, max-age=0, s-maxage=${PAGE_CACHE_SECONDS}, stale-while-revalidate=300`, 'x-content-type-options':'nosniff', 'referrer-policy':'strict-origin-when-cross-origin' } });
}

async function renderPage(request, env, ctx, path, origin) {
  const canonical = `${origin}${path}`;
  if (path === '/billing') return Response.redirect(`${origin}/pricing${new URL(request.url).search}`, 301);
  let template = '';
  if (env.ASSETS) {
    try { template = await (await env.ASSETS.fetch(new Request(new URL('/', request.url)))).text(); } catch {}
  }
  if (path === '/' || path === '/news') {
    const data = await newsData(request, env, ctx, 12);
    const articles = Array.isArray(data?.articles) ? data.articles : [];
    const content = `<p>Recent reporting, with publisher links. Open a story to see available source details and any related timeline.</p>${data?.error ? '<p class="seo-error">The live news archive is temporarily unavailable.</p>' : ''}<section aria-label="Recent news">${articles.map(articleMarkup).join('') || '<p>No news records are available in this edition.</p>'}</section>`;
    const description = 'Recent economic, political, international, infrastructure, health and energy news with publisher links and longer timelines where available.';
    const jsonLd = articles.slice(0,5).map(article => ({ '@context':'https://schema.org', '@type':'NewsArticle', headline:String(article.title || article.originalHeadline || '').slice(0,110), datePublished:dateText(article.publishedAt || article.published_at) || undefined, mainEntityOfPage:`${origin}/news/${encodeURIComponent(String(article.id || ''))}`, publisher:{'@type':'Organization',name:String(article.source?.publisher || article.publisher || 'Publisher')} }));
    return pageDocument({ title:'Recent news', description, canonical, content:`<h1>Recent news, with the source close.</h1>${content}`, jsonLd:jsonLd.length ? jsonLd : null, template, includeApp:true, status:data?.error ? data.status || 503 : 200 });
  }
  if (path === '/pricing') {
    let catalog;
    try { catalog = await publicPlans(env); } catch { catalog = { enabled:false, environment:'disabled', plans:[] }; }
    const cards = (catalog.plans || []).map(plan => {
      const interval = plan.interval === 'month' ? 'per month' : plan.interval === 'year' ? 'per year' : plan.interval;
      const checkoutStatus = plan.available && catalog.enabled
        ? catalog.environment === 'sandbox' ? 'Sandbox checkout is configured for this plan.' : 'Live PayPal checkout is configured for this plan.'
        : 'Checkout is currently unavailable for this plan.';
      return `<article class="seo-news-item"><h2>${escapeHtml(plan.name)}</h2><p><strong>${escapeHtml(plan.formattedPrice || plan.price)} ${escapeHtml(plan.currency || 'USD')}</strong> ${escapeHtml(interval)}</p><ul>${(plan.features || []).map(feature => `<li>${escapeHtml(feature)}</li>`).join('')}</ul><p>${checkoutStatus}</p></article>`;
    }).join('');
    const startLabel = escapeHtml(catalog.billing?.billingStartLabel || '1 December 2026 at 00:00 IST');
    const rawFreeThrough = String(catalog.billing?.freeThroughDate || '2026-11-30');
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawFreeThrough);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const freeThrough = escapeHtml(dateParts && months[Number(dateParts[2]) - 1]
      ? `${Number(dateParts[3])} ${months[Number(dateParts[2]) - 1]} ${dateParts[1]}`
      : rawFreeThrough);
    const state = catalog.enabled
      ? catalog.environment === 'sandbox'
        ? '<p>Sandbox mode is active. Transactions are confined to PayPal sandbox accounts.</p>'
        : `<p>Live checkout is available. Reading is free through ${freeThrough}; any subscription approved before then is scheduled to begin recurring charges on ${startLabel}.</p>`
      : `<p>ThreadNews is free through ${freeThrough}. If live PayPal checkout is not ready by then, reading stays open until it is.</p>`;
    const content = `<h1>Membership</h1><p>Read the current edition for free. Supporter membership currently offers $2 USD monthly or $20 USD yearly for full timelines and the long-term source-coverage archive.</p>${state}${cards ? `<section aria-label="Membership plans">${cards}</section>` : '<p>Plan details are temporarily unavailable.</p>'}<p><a href="/terms">Read draft terms and cancellation information</a> · <a href="/privacy">Privacy</a></p>`;
    return pageDocument({ title:'ThreadNews membership', description:'Membership plans and their current availability. Live billing remains disabled until setup and review are complete.', canonical, content, template, includeApp:true });
  }
  if (path === '/threads') {
    const data = await eventList(request, env, ctx);
    const events = Array.isArray(data?.events) ? data.events : [];
    const content = `<h1>Timelines and ongoing stories</h1><p>Selected histories connect current coverage to dated developments. A milestone’s sources and coverage limits remain visible.</p>${data?.error ? '<p class="seo-error">The timeline archive is temporarily unavailable.</p>' : ''}<section>${events.map(event => `<article class="seo-news-item"><h2><a href="/threads/${encodeURIComponent(String(event.id || ''))}">${escapeHtml(event.title || event.shortTitle || 'Untitled timeline')}</a></h2><p>${escapeHtml(event.description || '')}</p><p class="seo-meta">${Number(event.milestoneCount ?? event.milestones?.length) || 0} selected developments${event.coverageEnd ? ` · through ${escapeHtml(event.coverageEnd)}` : ''}</p></article>`).join('') || (!data?.error ? '<p>No reviewed timelines are available in this edition.</p>' : '')}</section>`;
    return pageDocument({ title:'Timelines', description:'Source-linked timelines for selected ongoing stories, with dates and coverage limits.', canonical, content, template, includeApp:true, status:data?.error ? data.status || 503 : 200 });
  }
  if (path.startsWith('/news/')) {
    const id = decodeURIComponent(path.slice('/news/'.length));
    if (!SAFE_ID.test(id)) return pageDocument({ title:'Story not found', description:'This story is not available in the current news edition.', canonical, content:'<h1>This story is not available.</h1><p><a href="/news">Browse recent news</a>.</p>', status:404, template, includeApp:true });
    const data = await singleNews(request, env, ctx, id);
    const article = data?.article;
    if (!article) return pageDocument({ title:'Story not found', description:'This story is not available in the current news edition.', canonical, content:'<h1>This story is not available.</h1><p><a href="/news">Browse recent news</a>.</p>', status:data?.status || 404, template, includeApp:true });
    const source = article.source || {};
    const publisher = source.publisher || article.publisher || 'Publisher not recorded';
    const title = article.title || article.originalHeadline || 'News story';
    const summary = digest(article);
    const href = articleHref(article);
    const viaGoogle = (() => { try { return new URL(href).hostname === 'news.google.com'; } catch { return false; } })();
    const published = dateText(article.publishedAt || article.published_at);
    const official = Array.isArray(article.officialSources) ? article.officialSources : [];
    const content = `<article data-news-story="${escapeHtml(id)}"><p class="seo-meta">${escapeHtml(article.category || 'News')} · ${escapeHtml(article.region || 'Region not recorded')} · ${escapeHtml(publisher)}${published ? ` · <time datetime="${escapeHtml(published)}">${escapeHtml(published.slice(0,10))}</time>` : ''}</p><section class="article-summary" aria-label="Summary"><h2>Summary</h2>${summary ? '' : '<span class="article-summary-label">Based on the publisher headline</span>'}<div class="article-summary-body"><p>${escapeHtml(summary || article.originalHeadline || title)}</p></div></section><p><a href="${escapeHtml(href)}" rel="noopener noreferrer">${viaGoogle ? `Open ${escapeHtml(publisher)} via Google News` : `Read at ${escapeHtml(publisher)}`}</a></p>${official.length ? `<section><h2>Official records attached</h2>${official.map(record => {const url=validHttpUrl(record.url);return `<article><h3>${url?`<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(record.title || record.publisher || 'Official record')}</a>`:escapeHtml(record.title || record.publisher || 'Official record')}</h3><p>${escapeHtml(record.publisher || '')}${record.publishedAt ? ` · ${escapeHtml(record.publishedAt)}` : ''}</p><p>${escapeHtml(record.note || 'This is an institutional source and does not independently verify every related claim.')}</p></article>`;}).join('')}</section>` : ''}${article.eventId ? `<p><a href="/threads/${encodeURIComponent(article.eventId)}">Open the related timeline</a></p>` : ''}<p><a href="/news">Back to recent news</a></p></article>`;
    const description = summary || `Source-linked news from ${publisher}. Read the original reporting and check the source details.`;
    const disclosure=source.freeAccessDisclosure?`<p class="source-disclosure">${escapeHtml(source.freeAccessDisclosure)}</p>`:'';
    const jsonLd = { '@context':'https://schema.org', '@type':'NewsArticle', headline:String(title).slice(0,110), datePublished:published || undefined, mainEntityOfPage:canonical, publisher:{ '@type':'Organization', name:String(publisher) } };
    return pageDocument({ title, description:String(description).slice(0,240), canonical, content:`<h1>${escapeHtml(title)}</h1>${disclosure}${content}`, type:'article', jsonLd, template, includeApp:true });
  }
  if (path.startsWith('/threads/')) {
    const id = decodeURIComponent(path.slice('/threads/'.length));
    if (!SAFE_ID.test(id)) return pageDocument({ title:'Story not found', description:'This timeline is not in the published collection.', canonical, content:'<h1>This timeline is not available.</h1><p><a href="/threads">Browse published timelines</a>.</p>', status:404, template, includeApp:true });
    const data = await eventData(request, env, ctx, id);
    const event = data?.event;
    if (!event) return pageDocument({ title:'Story not found', description:'This timeline is not in the published collection.', canonical, content:'<h1>This timeline is not available.</h1><p><a href="/threads">Browse published timelines</a>.</p>', status:data?.status === 503 ? 503 : 404, template, includeApp:true });
    const title = event.shortTitle || event.title || 'Timeline';
    const description = String(event.description || event.limitation || 'A dated, source-linked chronology.').slice(0,240);
    const jsonLd = { '@context':'https://schema.org', '@type':'Article', headline:String(title).slice(0,110), description, dateModified:dateText(event.updatedAt || event.coverageEnd) || undefined, mainEntityOfPage:canonical };
    return pageDocument({ title, description, canonical, content:`<h1>${escapeHtml(title)}</h1>${eventMarkup(event)}`, jsonLd, template, includeApp:true });
  }
  if (path === '/economy') {
    const data = await economyData(request, env, ctx);
    const content = data ? economyMarkup(data) : '<p class="seo-error">Economic history is temporarily unavailable.</p>';
    const description = 'Compare historical G20 GDP growth and consumer-price inflation with dates, source definitions and limits.';
    const jsonLd = data ? { '@context':'https://schema.org', '@type':'Dataset', name:'ThreadNews G20 economic history', description, dateModified:dateText(data.meta?.asOfDate || data.meta?.asOf) || undefined, mainEntityOfPage:canonical } : null;
    return pageDocument({ title:'G20 economy', description, canonical, content:`<h1>Economic indicators in historical context</h1>${content}`, jsonLd, template, includeApp:true, status:data ? 200 : 503 });
  }
  if (path.startsWith('/economy/')) {
    const code = decodeURIComponent(path.slice('/economy/'.length));
    const data = await economyData(request, env, ctx);
    const country = (data?.countries || []).find(item => item.iso3?.toLowerCase() === code.toLowerCase() || item.code?.toLowerCase() === code.toLowerCase() || item.name?.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') === code.toLowerCase());
    if (!country) return pageDocument({ title:'Economy not found', description:'No country series is available for this path.', canonical, content:'<h1>No country series is available.</h1><p><a href="/economy">Browse G20 economic history</a>.</p>', status:data ? 404 : 503, template, includeApp:true });
    const description = `${country.name} historical GDP growth and consumer-price inflation with reference dates and official source records.`;
    const jsonLd = { '@context':'https://schema.org', '@type':'Dataset', name:`${country.name} economic history`, description, dateModified:dateText(data.meta?.asOfDate || data.meta?.asOf) || undefined, mainEntityOfPage:canonical };
    return pageDocument({ title:`${country.name} economy`, description, canonical, content:`<h1>${escapeHtml(country.name)}: economic history</h1>${countryEconomyMarkup(country,data)}`, jsonLd, template, includeApp:true });
  }
  const page = staticMarkup(path, env);
  if (page) return pageDocument({ title:page[0], description:page[1], canonical, content:`<h1>${escapeHtml(page[0])}</h1>${page[2]}`, template, includeApp:!['/corrections','/terms','/404'].includes(path), status:path==='/404'?404:200 });
  return null;
}

async function sitemapResponse(request, env, ctx, origin) {
  const cache = globalThis.caches?.default;
  const key = new Request(`${new URL(request.url).origin}/sitemap.xml`);
  if (cache) { const cached = await cache.match(key); if (cached) return cached; }
  const urls = new Map();
  for (const path of ['/', '/news', '/threads', '/economy', '/ask', '/sources', '/method', '/about', '/privacy', '/corrections', '/pricing', '/terms']) urls.set(path, '');
  if (env.DB && env.NEWS_STORAGE !== 'static') {
    try {
      const [events, news] = await Promise.all([
        env.DB.prepare('SELECT id,updated_at FROM event_payloads ORDER BY updated_at DESC,id LIMIT 500').all(),
        env.DB.prepare("SELECT id,published_at FROM news WHERE published_at>=? AND COALESCE(json_extract(metadata_json,'$.editorialExcluded'),0)=0 ORDER BY published_at DESC,id DESC LIMIT 500").bind(new Date(Date.now()-4*86400000).toISOString()).all()
      ]);
      for (const event of events.results || []) urls.set(`/threads/${encodeURIComponent(event.id)}`, dateText(event.updated_at));
      for (const article of news.results || []) urls.set(`/news/${encodeURIComponent(article.id)}`, dateText(article.published_at));
      const economyResponse = await handleContent(new Request(new URL('/api/economy', request.url)), env, ctx, { canAccessArchive:false });
      if (economyResponse?.ok) {
        const economy = await economyResponse.json();
        for (const country of economy.countries || []) if (SAFE_ID.test(String(country.iso3 || country.code || ''))) urls.set(`/economy/${encodeURIComponent(country.iso3 || country.code)}`, dateText(economy.meta?.asOfDate || economy.meta?.asOf));
      }
    } catch { /* A partial sitemap remains useful when D1 is unavailable. */ }
  } else if (env.NEWS_STORAGE === 'static') {
    const [timelines, snapshot] = await Promise.all([assetJson(request, env, '/timeline-data.json'), assetJson(request, env, '/news-data.json')]);
    const economy = await assetJson(request, env, '/economy-data.json');
    for (const event of (Array.isArray(timelines) ? timelines : timelines?.events || [])) if (SAFE_ID.test(String(event.id || ''))) urls.set(`/threads/${encodeURIComponent(event.id)}`, dateText(event.updatedAt || event.coverageEnd));
    for (const article of (Array.isArray(snapshot) ? snapshot : snapshot?.articles || [])) if (SAFE_ID.test(String(article.id || ''))) urls.set(`/news/${encodeURIComponent(article.id)}`, dateText(article.publishedAt));
    for (const country of economy?.countries || []) if (SAFE_ID.test(String(country.iso3 || country.code || ''))) urls.set(`/economy/${encodeURIComponent(country.iso3 || country.code)}`, dateText(economy.meta?.asOfDate || economy.meta?.asOf));
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...urls.entries()].map(([path,lastmod])=>`<url><loc>${escapeXml(origin + path)}</loc>${lastmod?`<lastmod>${escapeXml(lastmod.slice(0,10))}</lastmod>`:''}</url>`).join('')}</urlset>`;
  const response = new Response(body, { headers:{ 'content-type':'application/xml; charset=utf-8', 'cache-control':`public, max-age=0, s-maxage=${SITEMAP_CACHE_SECONDS}, stale-while-revalidate=86400`, 'x-content-type-options':'nosniff' } });
  if (cache) { const pending = cache.put(key, response.clone()); if (ctx?.waitUntil) ctx.waitUntil(pending); else await pending; }
  return response;
}

function robotsResponse(origin) {
  const body = `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /account\nDisallow: /following\nDisallow: /signin\nDisallow: /coverage\nSitemap: ${origin}/sitemap.xml\n`;
  return new Response(body, { headers:{ 'content-type':'text/plain; charset=utf-8', 'cache-control':'public, max-age=3600', 'x-content-type-options':'nosniff' } });
}

function maybeHead(request, response) {
  return request.method === 'HEAD' ? new Response(null, { status:response.status, statusText:response.statusText, headers:response.headers }) : response;
}

export async function handleSeo(request, env, ctx) {
  if (!['GET','HEAD'].includes(request.method)) return null;
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, '') || '/';
  const isSitemap = path === '/sitemap.xml', isRobots = path === '/robots.txt';
  if (!isSitemap && !isRobots && !publicPath(path)) return null;
  const redirect = canonicalRedirect(request, env, path);
  if (redirect) return redirect;
  const origin = canonicalOrigin(request, env);
  if (isRobots) return maybeHead(request, robotsResponse(origin));
  if (isSitemap) return maybeHead(request, await sitemapResponse(request, env, ctx, origin));

  const cache = globalThis.caches?.default;
  const key = new Request(`${url.origin}${path}`);
  if (cache) { const cached = await cache.match(key); if (cached) return maybeHead(request, cached); }
  let response;
  try { response = await renderPage(request, env, ctx, path, origin); }
  catch { response = pageDocument({ title:'Temporarily unavailable', description:'ThreadNews could not load this record right now.', canonical:`${origin}${path}`, content:'<h1>This page is temporarily unavailable.</h1><p>Please try again shortly.</p>', status:503 }); }
  if (!response) return null;
  if (cache && response.status === 200) {
    const pending = cache.put(key, response.clone());
    if (ctx?.waitUntil) ctx.waitUntil(pending); else await pending;
  }
  return maybeHead(request, response);
}

export const seoInternals = Object.freeze({ canonicalHost, publicPath, digest, escapeHtml });
