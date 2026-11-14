(() => {
  'use strict';
  const stories = globalThis.STORIES;
  let newsroom, eventCoverageHandle;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl = value => {try{const u=new URL(value,location.origin);return /^https?:$/.test(u.protocol)?esc(u.href):'#';}catch{return '#';}};
  const icons = {
    compass:'<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5Z"/>',
    bookmark:'<path d="M6 4h12v17l-6-4-6 4Z"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    train:'<rect x="6" y="3" width="12" height="15" rx="4"/><path d="M6 10h12M9 21l2-3m4 3-2-3M10 6h4"/><path d="M9 14h.01M15 14h.01"/>',
    orbit:'<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-40 12 12)"/><path d="M8 4c3-2 8 3 10 8s2 8 0 9"/>',
    arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
    up:'<path d="M6 18 18 6M6 6h12v12"/>',
    back:'<path d="m12 5-7 7 7 7M5 12h15"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    layers:'<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
    grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list:'<path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    link:'<path d="m10 13 4-4m-6 5-2 2a3 3 0 0 0 4 4l4-4m-4-8 4-4a3 3 0 0 1 4 4l-2 2"/>',
    chevron:'<path d="m8 5 7 7-7 7"/>'
  };
  const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.globe}</svg>`;
  const logo = `<svg class="brand-icon" viewBox="0 0 36 40" fill="none" aria-hidden="true"><path d="M5 5v19a8 8 0 0 0 16 0V5M15 35V16a8 8 0 0 1 16 0v19" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg>`;
  const date = (s, opts) => new Date(s+'T12:00:00Z').toLocaleDateString('en-GB',opts || {day:'numeric',month:'short',year:'numeric'});
  const year = s => s.slice(0,4);
  const sourceList = s => [...new Map(s.milestones.flatMap(m=>m.sources).map(x=>[x.url,x])).values()];
  const publishers = s => [...new Set(sourceList(s).map(x=>x.publisher))];
  let saved;
  try { const v=JSON.parse(localStorage.getItem('threadline-following') || '[]'); saved=new Set(Array.isArray(v)?v.filter(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id)):[]); } catch { saved=new Set(); }
  const state = {category:'All events',region:'Everywhere',query:'',view:'grid',sort:'editorial',tab:'timeline',reverse:true,keyOnly:false,currentId:null,range:'all',detail:'developments',selectedMoment:null};
  let toastTimer;
  const categoryIcon = c => ({'World affairs':'globe','Infrastructure':'train','Space & science':'orbit'}[c] || 'compass');
  function toast(message) { $('#toast').textContent=message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3200); }
  function route() {
    const legacyPath=globalThis.ThreadNewsPublicRoutes?.legacyLocationPath(location.hash,location.search);
    return globalThis.ThreadNewsPublicRoutes?.routeForPath(legacyPath?.split('?')[0]||location.pathname)||{page:'explore'};
  }
  function normalizeInternalLinks(){
    const routes=globalThis.ThreadNewsPublicRoutes;
    if(!routes)return;
    document.querySelectorAll('a[href^="#/"]').forEach(anchor=>{
      const path=routes.legacyHashPath(anchor.getAttribute('href'));
      if(path)anchor.setAttribute('href',path);
    });
  }
  const internalLinkObserver=new MutationObserver(normalizeInternalLinks);
  internalLinkObserver.observe($('#main'),{childList:true,subtree:true});
  internalLinkObserver.observe($('#sidebar'),{childList:true,subtree:true});
  function navigate(pathOrHash){
    const routes=globalThis.ThreadNewsPublicRoutes;
    const path=pathOrHash.startsWith('#/')?routes?.legacyHashPath(pathOrHash):pathOrHash;
    if(!path)return;
    const target=new URL(path,location.href);
    if(target.origin!==location.origin||!routes?.appPath(target.pathname))return;
    const next=`${target.pathname}${target.search}`;
    if(`${location.pathname}${location.search}`===next){render();return;}
    history.pushState(history.state,'',next);
    render();scrollTo(0,0);
    $('#sidebar').classList.remove('mobile-open');$('#menu-button').setAttribute('aria-expanded','false');syncMobileNav();
  }
  function handleInternalNavigation(e){
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    const anchor=e.target.closest?.('a[href]');
    if(!anchor||anchor.closest('[data-action]')||anchor.target||anchor.hasAttribute('download'))return;
    let target;
    try{target=new URL(anchor.href,location.href);}catch{return;}
    if(target.origin!==location.origin)return;
    if(target.hash.startsWith('#/')){
      const path=globalThis.ThreadNewsPublicRoutes?.legacyLocationPath(target.hash,target.search);
      if(path){e.preventDefault();navigate(path);}
    }else if(globalThis.ThreadNewsPublicRoutes?.appPath(target.pathname)){
      e.preventDefault();navigate(`${target.pathname}${target.search}`);
    }
  }
  function nav() {
    if(newsroom){newsroom.renderNav();return;}
    const r=route();
    $('#sidebar').innerHTML=`<a class="brand" href="#/" aria-label="ThreadNews home">${logo}<span>ThreadNews</span></a>
      <div class="sidebar-label">YOUR WORLD, IN CONTEXT</div>
      <nav><a class="nav-item ${r.page==='explore' || r.page==='event'?'active':''}" href="#/">${icon('compass')}<span>Explore</span>${icon('arrow','nav-arrow')}</a>
      <a class="nav-item ${r.page==='following'?'active':''}" href="#/following">${icon('bookmark')}<span>Following</span><span class="nav-count">${saved.size}</span></a></nav>
      <div class="sidebar-divider"></div><div class="sidebar-label topic-label">EXPLORE BY TOPIC</div>
      <nav class="topic-nav">${['World affairs','Infrastructure','Space & science'].map(c=>`<button data-action="category" data-value="${c}" class="nav-item ${state.category===c && r.page==='explore'?'topic-active':''}">${icon(categoryIcon(c))}<span>${c}</span></button>`).join('')}</nav>
      <div class="sidebar-bottom"><div class="context-drawing" aria-hidden="true"><span></span><span></span><span></span><span></span></div><h3>Headlines pass.<br>Context stays.</h3><p>Understand how we got here,<br>one development at a time.</p><button data-action="about">Meet ThreadNews ${icon('up')}</button></div>
      <button class="sidebar-method" data-action="about">${icon('info')} Our approach to sources</button>`;
  }
  function followButton(s, compact=false) {
    const on=saved.has(s.id);
    return `<button class="${compact?'save-button':'button follow-button'} ${on?'is-saved':''}" data-action="follow" data-id="${s.id}" aria-pressed="${on}" aria-label="${on?'Unfollow':'Follow'} ${esc(s.shortTitle)}">${icon(on?'check':'bookmark')}${compact?'':`<span>${on?'Following':'Follow story'}</span>`}</button>`;
  }
  function card(s) {
    return `<article class="story-card"><a class="card-image" href="#/event/${s.id}" tabindex="-1" aria-hidden="true"><img src="${safeUrl(s.image)}" alt="" loading="lazy"><span class="image-shade"></span><span class="image-label">${esc(s.location)}</span><span class="image-open">${icon('up')}</span></a>
      <div class="card-body"><div class="card-kicker">${icon(categoryIcon(s.category))}${esc(s.category)}${followButton(s,true)}</div><a class="card-title" href="#/event/${s.id}"><h3>${esc(s.title)}</h3></a><p class="card-description">${esc(s.description)}</p>
      <div class="mini-timeline" aria-label="${s.milestones.length} selected milestones, ${year(s.milestones[0].date)} to ${year(s.coverageEnd)}"><div class="mini-rail">${s.milestones.map(()=>'<i></i>').join('')}</div><div class="mini-years"><span>${date(s.milestones[0].date,{month:'short',year:'numeric'})}</span><span>${date(s.coverageEnd,{month:'short',year:'numeric'})}</span></div></div>
      <div class="card-bottom"><span>${s.milestones.length} milestones <span>·</span> ${sourceList(s).length} ${sourceList(s).length===1?'source':'sources'}</span><a href="#/event/${s.id}" aria-label="Open timeline: ${esc(s.shortTitle)}">View timeline ${icon('arrow')}</a></div></div></article>`;
  }
  function feature() {
    const s=stories[0];
    return `<section class="featured-layout" aria-label="Featured stories"><article class="feature-story"><img src="${safeUrl(s.image)}" alt="${esc(s.imageAlt)}" fetchpriority="high"><div class="feature-overlay"></div><div class="feature-top"><span class="feature-label"><i></i> THE LONG VIEW</span><span class="feature-location">${icon('globe')} India</span></div><div class="feature-content"><div class="eyebrow">INFRASTRUCTURE · 2017–2025</div><h2><a href="#/event/${s.id}">India’s high-speed<br>rail journey</a></h2><p>From the first foundation stone to 300 km of viaducts.<br>Follow the developments that connect the dots.</p><div class="feature-bottom"><span class="source-stack"><b>N</b><b>PIB</b><b>+</b></span><span>${s.milestones.length} milestones <i>·</i> ${sourceList(s).length} sources</span><a class="feature-cta" href="#/event/${s.id}"><span>Explore timeline</span>${icon('up')}</a></div></div></article>
      <aside class="radar"><div class="radar-heading"><h2>On the radar</h2>${icon('layers')}</div><p class="radar-sub">Different stories. A wider perspective.</p>${stories.slice(1).map((s,i)=>`<a class="radar-item" href="#/event/${s.id}"><span class="radar-number">0${i+1}</span><div><span class="radar-category">${esc(s.category)}</span><h3>${esc(s.shortTitle)}</h3><span class="radar-meta">${s.milestones.length} milestones ${icon('arrow')}</span></div><img src="${safeUrl(s.image)}" alt="" loading="lazy"></a>`).join('')}<div class="radar-foot">${icon('clock')} Historical stories, with their context intact.</div></aside></section>`;
  }
  function filtered(following) {
    const terms=state.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let found=stories.filter(s=>(!following || saved.has(s.id)) && (state.category==='All events' || s.category===state.category) && (state.region==='Everywhere' || s.region===state.region) && terms.every(t=>`${s.title} ${esc(s.category)} ${s.region} ${s.keywords} ${s.description} ${s.milestones.map(m=>m.title+' '+m.summary).join(' ')}`.toLowerCase().includes(t)));
    if(state.sort==='latest') found.sort((a,b)=>b.coverageEnd.localeCompare(a.coverageEnd));
    if(state.sort==='earliest') found.sort((a,b)=>a.milestones[0].date.localeCompare(b.milestones[0].date));
    return found;
  }
  function renderHome(following=false) {
    const found=filtered(following), neutral=!following && !state.query && state.category==='All events' && state.region==='Everywhere';
    const catCounts=c=>stories.filter(s=>(!following || saved.has(s.id)) && (c==='All events'||s.category===c)).length;
    $('#main').innerHTML=`<div class="page-heading"><div><div class="eyebrow"><span class="small-line"></span>${following?'YOUR READING SPACE':'A WORLD OF STORIES. A THREAD THROUGH EACH.'}</div><h1>${following?'Keep the story <em>close.</em>':state.query?'Find the thread.':'The world moves.<br>See the <em>whole story.</em>'}</h1><p>${following?'The events you follow, together in one place.':state.query?`Searching this curated collection for “${esc(state.query)}”.`:'Go beyond the latest headline. Explore how the events shaping<br class="desktop-break"> our world began, unfolded, and connect.'}</p></div><div class="heading-note"><span class="note-orbit" aria-hidden="true">${icon('globe')}</span><span>${stories.length} curated stories<br><strong>Countless connections.</strong></span></div></div>
      <section class="discovery" aria-label="Browse events"><div class="filter-row"><div class="category-tabs" aria-label="Topic filter">${['All events','World affairs','Infrastructure','Space & science'].map(c=>`<button class="category-tab ${state.category===c?'selected':''}" data-action="category" data-value="${c}" aria-pressed="${state.category===c}">${c==='All events'?icon('compass'):''}${c}<span>${catCounts(c)}</span></button>`).join('')}</div><label class="region-filter">${icon('globe')}<select id="region" aria-label="Filter by region">${['Everywhere','Asia','Europe','Middle East','Global'].map(c=>`<option ${state.region===c?'selected':''}>${c}</option>`).join('')}</select></label></div></section>
      ${neutral?feature():''}
      <section class="stories-section" aria-label="Event collection"><div class="section-heading"><div><span class="eyebrow">${following?'YOUR COLLECTION':state.query?'SEARCH RESULTS':'FOLLOW THE THREAD'}</span><h2>${following?'Stories you’re following':state.query?`${found.length} ${found.length===1?'story':'stories'} found`:neutral?'There’s more to every headline.':state.category==='All events'?'Explore the collection':state.category}<span class="result-count">${neutral?stories.length-1:found.length}</span></h2></div><div class="collection-controls"><select id="sort" aria-label="Sort events"><option value="editorial" ${state.sort==='editorial'?'selected':''}>Editor’s selection</option><option value="latest" ${state.sort==='latest'?'selected':''}>Latest coverage</option><option value="earliest" ${state.sort==='earliest'?'selected':''}>Earliest beginning</option></select><div class="view-controls"><button class="icon-button ${state.view==='grid'?'selected':''}" data-action="view" data-value="grid" aria-label="Grid view" aria-pressed="${state.view==='grid'}">${icon('grid')}</button><button class="icon-button ${state.view==='list'?'selected':''}" data-action="view" data-value="list" aria-label="List view" aria-pressed="${state.view==='list'}">${icon('list')}</button></div></div></div>
      <div class="story-grid ${state.view==='list'?'list-view':''}">${(neutral?found.filter(s=>s.id!=='bullet-train'):found).map(card).join('')}</div>${!found.length?`<div class="empty-state">${icon(following?'bookmark':'search')}<h3>${following&&!saved.size?'Your next rabbit hole is waiting.':'No stories match just yet.'}</h3><p>${following&&!saved.size?'Follow an event to keep its timeline in this collection.':'Try “India”, “grain”, “Moon” or “shipping”, or broaden your filters.'}</p><button class="button primary" data-action="reset">Explore all events ${icon('arrow')}</button></div>`:''}</section>
      <aside class="collection-note">${icon('info')}<p><strong>Context takes care.</strong> This preview contains selected historical timelines, not a live news feed. Each story shows its coverage date and the reporting behind it.</p><button data-action="about">How we work ${icon('up')}</button></aside>`;
    nav(); bindImages();
  }
  function evidenceTag(m) { return `<span class="evidence-tag ${m.kind==='Involved-party account'?'party':''}"><span></span>${esc(m.kind)}</span>`; }
  function milestone(m,i,s) {
    return `<article class="milestone ${m.key?'key-milestone':''} ${state.selectedMoment===i?'highlight':''}" id="milestone-${i}" tabindex="-1"><div class="milestone-date"><span>${date(m.date,{day:'numeric',month:'short'})}</span><strong>${year(m.date)}</strong>${m.dateType==='publication'?'<small>REPORT DATE</small>':'<small>EVENT DATE</small>'}</div><div class="milestone-node"><i></i></div><div class="milestone-body"><div class="milestone-labels">${evidenceTag(m)}${m.key?'<span class="key-label">KEY MOMENT</span>':''}${m.date>=recentBoundary()?'<span class="recent-badge">RECENT DETAIL</span>':''}</div><h3>${esc(m.title)}</h3><p>${esc(m.summary)}</p>${m.correction?`<div class="milestone-correction">${icon('info')} ${esc(m.correction)}</div>`:''}${m.note?`<details class="milestone-note" ${s.id==='air-india-171'&&m.date==='2025-07-12'?'open':''}><summary>Attribution & limits ${icon('chevron')}</summary><p>${esc(m.note)}</p></details>`:''}<div class="milestone-footer"><span>${[...new Set(m.sources.map(x=>x.publisher))].map(esc).join(' · ')}</span><button data-action="sources" data-id="${s.id}" data-idx="${i}">${icon('layers')}${m.sources.length===1?'View source':`Compare ${m.sources.length} sources`}${icon('up')}</button></div></div></article>`;
  }
  function sourceCard(src) {
    return `<article class="source-card"><div class="source-publisher"><span class="publisher-logo">${esc(src.publisher.slice(0,2).toUpperCase())}</span><div><strong>${esc(src.publisher)}</strong><span>${esc(src.type)}</span></div>${icon('up')}</div><h3><a href="${safeUrl(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.title)}</a></h3><p>${src.published?`Published ${date(src.published)}`:src.updated?`Retrospective · updated ${date(src.updated)}`:'Retrospective / reference · publication date not listed'}</p><a class="source-link" href="${safeUrl(src.url)}" target="_blank" rel="noopener noreferrer">Read original source ${icon('up')}</a></article>`;
  }
  function timelineAsOf(){return globalThis.THREADLINE_CONFIG?.mode==='production'?new Date().toISOString().slice(0,10):(globalThis.TIMELINE_META?.asOf||new Date().toISOString().slice(0,10));}
  function recentBoundary(){const asOf=timelineAsOf(),d=new Date(asOf+'T12:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-2);d.setUTCDate(Math.min(day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));return d.toISOString().slice(0,10);}
  function monthLabel(value){return date(value.slice(0,7)+'-01',{month:'long',year:'numeric'});}
  function timelineBody(s,sources,pubs){
    const recentStart=recentBoundary(),asOf=timelineAsOf();
    const recentCount=s.milestones.filter(m=>m.date>=recentStart&&m.date<=asOf).length;
    let entries=s.milestones.map((m,i)=>({m,i})).filter(({m})=>(!state.keyOnly||m.key)&&(state.range!=='recent'||m.date>=recentStart));
    if(state.reverse)entries.reverse();
    const groups=new Map();for(const entry of entries){const k=entry.m.date.slice(0,7);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(entry);}
    const picked=Math.min(s.milestones.length-1,Math.max(0,state.selectedMoment??s.milestones.length-1));
    const selected=s.milestones[picked];
    const grouped=state.detail==='months'?[...groups].map(([month,items],i)=>`<details class="timeline-month-group" ${i<2||items.some(x=>x.m.date>=recentStart)?'open':''}><summary><span><strong>${monthLabel(month)}</strong><small>${items.length} ${items.length===1?'development':'developments'}${items.some(x=>x.m.date>=recentStart)?' · recent detail':''}</small></span>${icon('chevron')}</summary><div class="timeline-list">${items.map(({m,i})=>milestone(m,i,s)).join('')}</div></details>`).join(''):[...groups].map(([month,items])=>`<section class="development-month" aria-label="${monthLabel(month)}"><div class="month-divider"><span>${monthLabel(month)}</span><i></i>${items.some(x=>x.m.date>=recentStart)?'<small>RECENT DETAIL</small>':''}</div><div class="timeline-list">${items.map(({m,i})=>milestone(m,i,s)).join('')}</div></section>`).join('');
    return `<div class="event-body expanded-timeline"><section class="timeline-column" aria-label="Development timeline"><div class="timeline-intro"><div><div class="eyebrow">MAJOR DEVELOPMENTS, IN CONTEXT</div><h2>Follow what changed.</h2></div><select id="timeline-order" aria-label="Timeline order"><option value="newest" ${state.reverse?'selected':''}>Latest → beginning</option><option value="oldest" ${!state.reverse?'selected':''}>Beginning → latest</option></select></div>
    <div class="timeline-range-row"><div class="timeline-range" aria-label="Timeline date range"><button data-action="timeline-range" data-value="all" aria-pressed="${state.range==='all'}" class="${state.range==='all'?'selected':''}">${s.previewTruncated?'Public preview':'Full story'} <span>${s.milestones.length}</span></button><button data-action="timeline-range" data-value="recent" aria-pressed="${state.range==='recent'}" class="${state.range==='recent'?'selected':''}">Last 2 months <span>${recentCount}</span></button></div><div class="timeline-detail" aria-label="Timeline presentation"><button data-action="timeline-detail" data-value="developments" aria-pressed="${state.detail==='developments'}" class="${state.detail==='developments'?'selected':''}">Developments</button><button data-action="timeline-detail" data-value="months" aria-pressed="${state.detail==='months'}" class="${state.detail==='months'?'selected':''}">By month</button></div></div>
    <div class="timeline-window-note">${s.previewTruncated?`This public preview shows the first ${s.milestones.length} selected milestones. The complete chronology may require supporter access. <a href="#/pricing">Membership details</a>. `:''}${state.range==='recent'?`Closer tracking · ${date(recentStart)}–${date(asOf)}. `:''}Stops mark documented developments. The time between them varies.</div>
    <div class="timeline-scrubber development-scrubber"><div class="scrubber-top"><span>Travel through the story</span><span id="scrub-date">${date(selected.date)}</span></div><input id="scrubber" type="range" min="0" max="${s.milestones.length-1}" step="1" value="${picked}" aria-label="Jump between documented developments" aria-valuetext="${esc(selected.title)}, ${date(selected.date)}"><div class="moment-strip" aria-label="Jump to a specific development">${s.milestones.map((m,i)=>`<button class="${i===picked?'moment-selected':''}" data-action="jump" data-idx="${i}" aria-label="Jump to ${esc(m.title)}, ${date(m.date)}"><span>${date(m.date,{day:'numeric',month:'short'})}</span><strong>${year(m.date)}</strong><small>${esc(m.title)}</small></button>`).join('')}</div><span class="scrubber-note">One stop per development · slider positions are evenly spaced</span></div>
    <div class="timeline-filter"><span>${entries.length} ${entries.length===1?'development':'developments'} shown</span><label><input type="checkbox" id="key-only" ${state.keyOnly?'checked':''}><span class="switch"></span> Key moments only</label></div>
    ${entries.length?grouped:`<div class="timeline-gap">${icon('clock')}<h3>No documented milestone in this range.</h3><p>${s.previewTruncated?'The public preview does not include later milestones. The absence of a recent point here does not establish that no development occurred.':s.id==='artemis'?'This timeline covers the completed 2022 Artemis I mission. Later Artemis programmes are different stories.':'The reviewed sources in this collection do not establish a new major development during this period. This is a coverage limit, not proof that nothing happened.'}</p><button class="button" data-action="timeline-range" data-value="all">${s.previewTruncated?'Show the public preview':'Read the full story'} ${icon('arrow')}</button></div>`}
    <div class="timeline-end">${icon('clock')} Selected chronology, checked through ${date(s.checkedThrough||asOf)}. Gaps remain visible.</div></section>
    <aside class="story-aside"><div class="aside-context"><div class="eyebrow">THE PAST TWO MONTHS</div><h3>${recentCount?`${recentCount} documented developments`:'No new milestone established'}</h3><p>${recentCount?`Closer tracking from ${date(recentStart)} to ${date(asOf)}. Important changes get individual stops; quieter periods do not get invented entries.`:s.id==='artemis'?'This is a completed mission timeline. Later Artemis programmes are different stories.':'The latest verified record in this chronology is older. See the coverage statement for what was checked and what remains unknown.'}</p><button data-action="timeline-range" data-value="${recentCount?'recent':'all'}">${recentCount?'Focus on recent detail':'Read the documented history'} ${icon('arrow')}</button></div><div class="aside-sources"><div class="eyebrow">BEHIND THIS CHRONOLOGY</div><div class="aside-stat"><strong>${sources.length}</strong><span>source documents</span><strong>${pubs.length}</strong><span>${pubs.length===1?'publisher':'publishers'}</span></div><p>Reports can repeat an original account. Counts describe the collection, not independent confirmation.</p><button data-action="event-tab" data-value="sources">Inspect the sources ${icon('up')}</button></div><div class="aside-context context-secondary"><div class="eyebrow">THE BIGGER PICTURE</div><p>${esc(s.context)}</p><button data-action="event-tab" data-value="context">More context ${icon('arrow')}</button></div><div class="aside-question">${icon('info')}<p><strong>Event date</strong> marks a documented event. <strong>Report date</strong> marks publication when the event date is not separately established. Targets and preliminary findings remain labelled in the source notes.</p></div></aside></div>`;
  }
  let eventLoad={id:null,status:'idle',error:''};
  function renderEvent(id) {
    const s=stories.find(x=>x.id===id);
    if(!s&&globalThis.THREADLINE_CONFIG?.mode==='production'&&newsroom?.loadEvent){
      if(eventLoad.id!==id){const pending={id,status:'loading',error:''};eventLoad=pending;newsroom.loadEvent(id).then(record=>{pending.status=record?'ready':'missing';}).catch(error=>{pending.status='error';pending.error=error.message;}).finally(()=>{if(eventLoad===pending&&route().page==='event'&&route().id===id)render();});}
      $('#main').innerHTML=`<div class="empty-state" role="status">${icon('clock')}<h1>${eventLoad.status==='loading'?'Opening the story…':eventLoad.status==='error'?'This story is unavailable.':'That thread isn’t here.'}</h1><p>${esc(eventLoad.error||'Timeline records come from the publication’s database.')}</p>${eventLoad.status==='error'?'<button class="button" data-action="event-retry">Try again</button>':''}<a class="button primary" href="#/timelines">Explore timelines</a></div>`;nav();return;
    }
    if(!s){$('#main').innerHTML=`<div class="empty-state">${icon('search')}<h1>That thread isn’t here.</h1><p>This event isn’t in the published collection.</p><a class="button primary" href="#/timelines">Explore timelines</a></div>`;nav();return;}
    if(state.currentId!==id){state.tab='timeline';state.reverse=true;state.keyOnly=false;state.currentId=id;state.range='all';state.detail='developments';state.selectedMoment=s.milestones.length-1;}
    const sources=sourceList(s), pubs=publishers(s);
    const entries=s.milestones.map((m,i)=>({m,i})).filter(({m})=>!state.keyOnly||m.key); if(state.reverse)entries.reverse();
    $('#main').innerHTML=`<a class="back-link" href="#/">${icon('back')} Back to the big picture</a>
      <section class="event-heading"><div><div class="event-category">${icon(categoryIcon(s.category))}${esc(s.category)}<span>·</span>${esc(s.location)}</div><h1>${esc(s.title)}</h1><p>${esc(s.description)}</p><div class="event-actions">${followButton(s)}<button class="button" data-action="share" data-id="${s.id}">${icon('link')} Copy link</button>${globalThis.ThreadNewsAsk?`<a class="button ask-context-link" href="${esc(globalThis.ThreadNewsAsk.eventLink(s.id,s.shortTitle||s.title))}">${globalThis.ThreadNewsAsk.glyph} Ask about this timeline</a>`:''} </div></div><figure class="event-picture"><img src="${safeUrl(s.image)}" alt="${esc(s.imageAlt)}"><figcaption><a href="${safeUrl(s.imagePage)}" target="_blank" rel="noopener noreferrer">${esc(s.imageCredit)} ↗</a></figcaption></figure></section>
      <div class="coverage-banner">${icon('clock')}<div><strong>Selected chronology · latest documented milestone ${date(s.coverageEnd)}</strong><span>${esc(s.limitation)}</span></div></div>
      ${s.statusCheck?`<section class="investigation-status"><div>${icon('layers')}<span class="eyebrow">PUBLIC STATUS CHECK · ${date(s.statusCheck.date)}</span></div><h2>What can be established now.</h2><p>${esc(s.statusCheck.observation)}</p><p>${esc(s.context)}</p><a href="${safeUrl(s.statusCheck.url)}" target="_blank" rel="noopener noreferrer">Inspect the ${esc(s.statusCheck.publisher)} public index ${icon('up')}</a>${(s.statusCheck.sources||[]).map(source=>`<p><a href="${safeUrl(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title||source.publisher)} ${icon('up')}</a></p>`).join('')}</section>`:''}${newsroom?.related(s.id)||''}<div class="event-tabs" role="tablist" aria-label="Story sections">${[['timeline','The timeline',s.milestones.length],['sources','Source library',sources.length],['context','The bigger picture','']].map(([v,t,n])=>`<button id="tab-${v}" role="tab" aria-selected="${state.tab===v}" aria-controls="event-panel" tabindex="${state.tab===v?'0':'-1'}" data-action="event-tab" data-value="${v}" class="${state.tab===v?'selected':''}">${t}${n?`<span>${n}</span>`:''}</button>`).join('')}</div>
      <div id="event-panel" role="tabpanel" aria-labelledby="tab-${state.tab}">${state.tab==='timeline'?timelineBody(s,sources,pubs):state.tab==='sources'?`<section class="source-library"><div class="eyebrow">READ BEYOND THE SUMMARY</div><h2>Nothing without a source.</h2><p class="library-intro">${sources.length} source documents from ${pubs.length} ${pubs.length===1?'publisher':'publishers'}. These are the records used in this curated timeline. Official accounts have an institutional perspective; multiple articles may repeat one announcement.</p><div class="source-grid">${sources.map(sourceCard).join('')}</div></section>`:`<section class="context-page"><div class="eyebrow">TAKE A STEP BACK</div><h2>The story around the story.</h2><div class="context-grid"><article><span>01 / CONTEXT</span><h3>What helps make sense of it</h3><p>${esc(s.context)}</p></article><article><span>02 / THE OPEN QUESTIONS</span><h3>What to keep in mind</h3><p>${esc(s.watch)}</p></article><article><span>03 / COVERAGE LIMITS</span><h3>What this edition leaves out</h3><p>${esc(s.limitation)}</p></article><article><span>04 / SOURCE TRANSPARENCY</span><h3>Trace the original account</h3><p>Read each source in its own words. Attribution identifies who reported something; it does not make a claim independently verified.</p><button class="text-button" data-action="event-tab" data-value="sources">Open source library ${icon('arrow')}</button></article></div></section>`}</div>`;
    if (globalThis.ThreadNewsStoryChanges && globalThis.THREADLINE_CONFIG?.mode === 'production') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button ask-context-link';
      button.textContent = 'What changed?';
      button.setAttribute('aria-haspopup', 'dialog');
      button.addEventListener('click', () => globalThis.ThreadNewsStoryChanges.open(s.id, s.shortTitle || s.title));
      $('.event-actions').append(button);
    }
    nav();bindImages();
    eventCoverageHandle?.destroy();
    if(s.tracking?.enabled&&globalThis.ThreadNewsEventCoverage){const container=document.createElement('section');container.id='automatic-event-coverage';$('#event-panel').after(container);eventCoverageHandle=globalThis.ThreadNewsEventCoverage.mount(container,s,{apiBase:globalThis.THREADLINE_CONFIG?.apiBase,showStatusCheck:false});}
  }
  function renderAbout() {
    $('#main').innerHTML=`<div class="about-page"><a class="back-link" href="#/">${icon('back')} Back to exploring</a><div class="eyebrow">The ThreadNews approach</div><h1>More context.<br><em>Clearer perspective.</em></h1><p class="about-lead">A headline is one moment. Understanding comes from seeing what led to it, what changed, and who reported it.</p><div class="about-principles">${[
      ['01','Events come first.','Each event has one continuing timeline. Related developments belong together, so you can pick up the story without starting from scratch.'],
      ['02','Keep the source close.','Every milestone links to its source documents. Event dates and publication dates are shown separately. Summaries are short paraphrases; original articles remain with their publishers.'],
      ['03','Show the limits.','A government statement, company announcement and independent investigation are different kinds of evidence. We label the source relationship and avoid treating repeated reports as independent confirmation.'],
      ['04','Fairness is a practice.','No aggregator can promise perfect neutrality. The approach is to attribute claims, seek independent perspectives, preserve corrections and make uncertainty visible. Equal weight is not automatically equal evidence.']
    ].map(([n,t,p])=>`<article><span>${n}</span><div><h2>${t}</h2><p>${p}</p></div></article>`).join('')}</div><div class="preview-explainer"><span class="eyebrow">ABOUT THIS FIRST EDITION</span><h2>A small collection.<br>A working idea.</h2><p>This prototype has ${stories.length} researched historical stories and ${stories.reduce((n,s)=>n+s.milestones.length,0)} selected milestones. Search covers this collection. Following is stored in this browser, with no account or cross-device sync.</p><p>It does not fetch breaking news, monitor events or send alerts. Worldwide coverage needs licensed feeds, event clustering, duplicate detection and editorial review. This edition tests the reading experience.</p><a class="button primary" href="#/">Find your first thread ${icon('arrow')}</a></div></div>`;nav();
  }
  function render() { const r=route(); if(newsroom?.renderRoute(r)){syncMobileNav();normalizeInternalLinks();return;}if(r.page==='event')renderEvent(r.id);else if(r.page==='about'){
    renderAbout();
    $('.about-page').insertAdjacentHTML('beforeend',`<section class="photo-credits"><div class="eyebrow">IMAGE CREDITS</div><h2>Acknowledging the photographers.</h2>${stories.map(s=>`<p><a href="${safeUrl(s.imagePage)}" target="_blank" rel="noopener noreferrer">${esc(s.shortTitle)} — ${esc(s.imageCredit)} ↗</a>${s.imageLicense?` · <a href="${safeUrl(s.imageLicense)}" target="_blank" rel="noopener noreferrer">Licence</a>`:''}</p>`).join('')}<p>City and satellite imagery provides historical context; it does not depict the latest conditions.</p></section>`);
  }else renderHome(r.page==='following'); document.title=r.page==='event'?`${stories.find(s=>s.id===r.id)?.shortTitle||'Event'} — ThreadNews`:'ThreadNews — The whole story, unfolding'; syncMobileNav();normalizeInternalLinks(); }
  function syncMobileNav(){ $('#sidebar').inert=matchMedia('(max-width:620px)').matches&&!$('#sidebar').classList.contains('mobile-open'); }
  function bindImages() { document.querySelectorAll('img').forEach(img=>{img.addEventListener('error',()=>{img.classList.add('image-unavailable');img.alt=img.alt||'Event photograph unavailable';},{once:true});}); }
  function openSources(id,idx) { const s=stories.find(x=>x.id===id), m=s?.milestones[idx]; if(!m)return;
    $('#dialog-content').innerHTML=`<button class="dialog-close icon-button" data-action="close-dialog" aria-label="Close sources" autofocus>${icon('close')}</button><div class="eyebrow">THE REPORTING BEHIND THE MOMENT</div><h2 id="dialog-title">${esc(m.title)}</h2><p class="dialog-date">${m.dateType==='publication'?'Report publication date':'Event date'}: ${date(m.date)}</p>${evidenceTag(m)}<p class="evidence-note">${esc(m.note||'This entry draws on the source below. An official record reflects its institution’s account and is not a claim of independent verification.')}</p><div class="dialog-sources">${m.sources.map(sourceCard).join('')}</div><p class="dialog-foot">Article dates can differ from event dates. A report date is used when an event date is not separately established. Source links open the original publisher in a new tab.</p>`;
    $('#source-dialog').showModal();
  }
  function jump(idx) {
    const s=stories.find(s=>s.id===state.currentId);if(!s?.milestones[idx])return;
    state.selectedMoment=idx;
    if((state.keyOnly&&!s.milestones[idx].key)||(state.range==='recent'&&s.milestones[idx].date<recentBoundary())){state.keyOnly=false;state.range='all';renderEvent(s.id);}
    $('#scrubber').value=idx; $('#scrubber').setAttribute('aria-valuetext',s.milestones[idx].title);$('#scrub-date').textContent=date(s.milestones[idx].date);
    const el=$(`#milestone-${idx}`);const group=el?.closest('details');if(group)group.open=true;el?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});el?.focus({preventScroll:true}); document.querySelectorAll('.milestone.highlight').forEach(el=>el.classList.remove('highlight'));el?.classList.add('highlight');document.querySelectorAll('.moment-strip button').forEach(b=>b.classList.toggle('moment-selected',Number(b.dataset.idx)===idx));
  }
  async function action(e) { const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;
    if(newsroom?.handleAction(e,b))return;
    if(a==='event-retry'){eventLoad={id:null,status:'idle',error:''};render();return;}
    if(a==='timeline-range'||a==='timeline-detail'){const y=scrollY;state[a==='timeline-range'?'range':'detail']=b.dataset.value;renderEvent(state.currentId);scrollTo(0,y);document.querySelector(`[data-action="${a}"][data-value="${b.dataset.value}"]`)?.focus({preventScroll:true});return;}
    if(a==='category'){state.category=b.dataset.value;state.query='';$('#search').value='';if(route().page==='explore'||route().page==='following'){renderHome(route().page==='following');}else{navigate('/');}nav();}
    else if(a==='follow') {if(saved.has(b.dataset.id))saved.delete(b.dataset.id);else saved.add(b.dataset.id);void newsroom?.syncTimelineSave(b.dataset.id,saved.has(b.dataset.id));let stored=true;try{localStorage.setItem('threadline-following',JSON.stringify([...saved]));}catch{stored=false;}const y=scrollY;render();scrollTo(0,y);document.querySelector(`[data-action="follow"][data-id="${b.dataset.id}"]`)?.focus({preventScroll:true});toast(stored?(saved.has(b.dataset.id)?'Story followed. Find it in your collection.':'Story removed from your collection.'):'Following saved for this session; browser storage is unavailable.');}
    else if(a==='view'){state.view=b.dataset.value;renderHome(route().page==='following');}
    else if(a==='reset'){state.query='';state.category='All events';state.region='Everywhere';$('#search').value='';if(route().page==='explore')renderHome();else navigate('/');}
    else if(a==='about')navigate('/about');
    else if(a==='event-tab'){const wasTab=b.getAttribute('role')==='tab';state.tab=b.dataset.value;const y=scrollY;renderEvent(state.currentId);if(wasTab){$(`#tab-${state.tab}`).focus();scrollTo(0,y);}else $('.event-tabs').scrollIntoView({behavior:'smooth',block:'start'});}
    else if(a==='sources')openSources(b.dataset.id,Number(b.dataset.idx));
    else if(a==='close-dialog')$('#source-dialog').close();
    else if(a==='jump')jump(Number(b.dataset.idx));
    else if(a==='share'){const url=new URL(`/threads/${encodeURIComponent(b.dataset.id)}`,location.origin);try{await navigator.clipboard.writeText(url.href);toast('Timeline link copied.');}catch{toast('Copy the timeline URL from your browser’s address bar.');}}
    if(a==='category'||a==='about'||a==='reset'){$('#sidebar').classList.remove('mobile-open');$('#menu-button').setAttribute('aria-expanded','false');syncMobileNav();}
  }
  document.addEventListener('click',handleInternalNavigation,true);
  document.addEventListener('click',action);
  $('.skip-link').addEventListener('click',e=>{e.preventDefault();$('#main').focus();});
  $('#source-dialog').addEventListener('click',e=>{if(e.target===$('#source-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  document.addEventListener('change',e=>{if(newsroom?.handleChange(e))return;if(e.target.id==='region'){state.region=e.target.value;renderHome(route().page==='following');}if(e.target.id==='sort'){state.sort=e.target.value;renderHome(route().page==='following');}if(e.target.id==='timeline-order'){state.reverse=e.target.value==='newest';renderEvent(state.currentId);}if(e.target.id==='key-only'){state.keyOnly=e.target.checked;renderEvent(state.currentId);$('#key-only').focus();}if(e.target.id==='scrubber')jump(Number(e.target.value));});
  document.addEventListener('input',e=>{if(newsroom?.handleInput(e))return;if(e.target.id==='scrubber'){const m=stories.find(s=>s.id===state.currentId).milestones[e.target.value];$('#scrub-date').textContent=date(m.date);e.target.setAttribute('aria-valuetext',m.title);}});
  $('#search-form').addEventListener('submit',e=>{if(newsroom?.submit(e))return;e.preventDefault();});
  document.addEventListener('keydown',e=>{if(e.key==='/'&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)&&!$('#source-dialog').open){e.preventDefault();$('#search').focus();}if(e.target.matches('[role="tab"]')&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const tabs=['timeline','sources','context'];let i=tabs.indexOf(state.tab);i=e.key==='Home'?0:e.key==='End'?2:(i+(e.key==='ArrowRight'?1:2))%3;state.tab=tabs[i];renderEvent(state.currentId);$(`#tab-${state.tab}`).focus();}if(e.key==='Escape'){$('#sidebar').classList.remove('mobile-open');$('#menu-button').setAttribute('aria-expanded','false');}});
  $('#search-icon').innerHTML=icon('search');$('#menu-button').innerHTML=icon('menu');$('#menu-button').addEventListener('click',()=>{const on=$('#sidebar').classList.toggle('mobile-open');$('#menu-button').setAttribute('aria-expanded',String(on));syncMobileNav();});
  matchMedia('(max-width:620px)').addEventListener('change',syncMobileNav);
  function handleLocationChange(){
    const oldPath=globalThis.ThreadNewsPublicRoutes?.legacyLocationPath(location.hash,location.search);
    if(oldPath)history.replaceState(history.state,'',oldPath);
    render();scrollTo(0,0);$('#sidebar').classList.remove('mobile-open');$('#menu-button').setAttribute('aria-expanded','false');syncMobileNav();
  }
  window.addEventListener('hashchange',handleLocationChange);
  window.addEventListener('popstate',handleLocationChange);
  const initialLegacyPath=globalThis.ThreadNewsPublicRoutes?.legacyLocationPath(location.hash,location.search);
  if(initialLegacyPath)history.replaceState(history.state,'',initialLegacyPath);
  newsroom=globalThis.createNewsroom({icon,logo,esc,stories,date,card,toast,route,navigate,getTimelineSaved:()=>[...saved],setTimelineSaved:ids=>{saved.clear();ids.forEach(id=>saved.add(id));try{localStorage.setItem('threadline-following',JSON.stringify([...saved]));}catch{}},refresh:render,syncMobileNav});
  render();newsroom.boot();
})();
