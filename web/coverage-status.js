/* Public source checks describe collection health, not the truth of a claim. */
(() => {
  'use strict';
  const instances=new WeakMap();
  const escape=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const googleTopics={world:'World affairs',business:'Economy',technology:'Technology',science:'Science',health:'Health',sports:'Sport'};
  const number=value=>value!==null&&value!==undefined&&value!==''&&Number.isInteger(Number(value))&&Number(value)>=0?Number(value).toLocaleString():'—';
  const timestamp=value=>{const at=new Date(value||'');return Number.isFinite(at.getTime())?at:null;};
  function sourceLabel(id,sources){
    const source=sources.find(record=>record.id===id);
    if(source)return source.publisher;
    if(/^google-/.test(id))return 'Google News · '+(googleTopics[id.slice(7)]||'Headlines');
    return String(id||'Source').replace(/[-_]/g,' ');
  }
  function sourceRecord(id,sources){return sources.find(record=>record.id===id)||(/^google-/.test(id)?sources.find(record=>record.id==='google-world'):null);}
  function state(feed){
    if(!feed.enabled)return {kind:'inactive',label:'Not active'};
    if(feed.error)return {kind:'issue',label:'Check failed'};
    if(!timestamp(feed.lastAttemptAt))return {kind:'waiting',label:'Not checked yet'};
    if(!timestamp(feed.lastSuccessAt))return {kind:'waiting',label:'No successful check recorded'};
    if(timestamp(feed.lastAttemptAt)>timestamp(feed.lastSuccessAt))return {kind:'waiting',label:'Latest check not complete'};
    return {kind:'ok',label:'Checked successfully'};
  }
  function render({container,apiBase='',esc=escape}={}){
    const element=typeof container==='string'?document.querySelector(container):container;
    if(!element)throw new Error('A container is required for source coverage.');
    instances.get(element)?.destroy();
    let destroyed=false,loading=false,generation=0,controller=null,loadedAt=null;
    let pipeline=null,sources=[],policy=null,failures=[],requested=false;
    const connected=typeof apiBase==='string',base=connected?apiBase.replace(/\/$/,''):'';
    function time(value,empty='Not recorded'){
      const at=timestamp(value);if(!at)return esc(empty);
      return `<time datetime="${esc(at.toISOString())}" title="${esc(at.toISOString())}">${esc(at.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}))}</time>`;
    }
    function link(value,label){try{const url=new URL(value);if(!/^https?:$/.test(url.protocol)||url.username||url.password)return '';return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;}catch{return '';}}
    function sourceCard(feed){
      const status=state(feed),source=sourceRecord(feed.id,sources),official=source?.sourceType==='Official source',discovery=/^google-/.test(feed.id),gdelt=/^gdelt-/.test(feed.id);
      return `<article class="source-check-card"><div class="source-check-heading"><h3>${esc(sourceLabel(feed.id,sources))}</h3><span class="source-check-badge source-check-${status.kind}"><i aria-hidden="true"></i>${esc(status.label)}</span></div><p class="source-check-kind">${official?'Official account':discovery||gdelt?'Headline discovery':'Publisher reporting'}</p><dl><div><dt>Last check</dt><dd>${time(feed.lastAttemptAt,'Not checked yet')}</dd></div><div><dt>Last successful check</dt><dd>${time(feed.lastSuccessAt,'None recorded')}</dd></div><div><dt>Headlines in last successful check</dt><dd>${number(feed.itemCount)}</dd></div></dl>${status.kind==='issue'?'<p class="source-check-note source-check-problem">The latest attempt could not read this source. Earlier reports remain available within the retention window.</p>':''}<p class="source-check-note">${official?'An institution’s own announcements or data can reflect its position. Check independent reporting alongside it.':discovery?'Original publishers remain responsible for their reporting. Headlines and links are discovered through Google News.':gdelt?'Headlines and links are discovered through GDELT. Index times can differ from publication times.':'Open the original publisher’s article to read the reporting in full.'}</p>${source?.terms?`<div class="source-check-link">${link(source.terms,'Source information and terms')}</div>`:''}</article>`;
    }
    function economicStatus(){
      if(!pipeline?.economy)return '';
      const monthly=pipeline.economy.monthly,annual=pipeline.economy.annual,labels={updated:'Updated',partial:'Some sources updated',failed:'Latest check failed','requires-national-source-refresh':'Waiting for source checks','not-checked':'Not checked yet'};
      return `<section class="coverage-economy"><div><span class="eyebrow">THE ECONOMY</span><h2>Each series keeps its date.</h2><p>Annual statistics and monthly inflation releases have different reference periods. A recent check does not make every country’s latest observation the same age.</p></div><dl><div><dt>Annual history last refreshed</dt><dd>${time(annual?.lastSuccessAt)}</dd></div><div><dt>Monthly sources last checked</dt><dd>${time(monthly?.lastNationalSourceCheckAt)}</dd></div><div><dt>Monthly history check</dt><dd>${esc(labels[monthly?.status]||'Status unavailable')}</dd></div><div><dt>Latest saved economic edition</dt><dd>${time(pipeline.economy.storedAt)}</dd></div></dl><a class="text-button" href="#/economy">Explore the dated economic series ↗</a></section>`;
    }
    function draw(){
      if(destroyed)return;
      const meta=pipeline?.meta||{},feeds=Array.isArray(pipeline?.feeds)?pipeline.feeds:[],active=feeds.filter(feed=>feed.enabled),inactive=sources.filter(source=>!source.enabled&&!active.some(feed=>feed.id===source.id));
      const successful=active.filter(feed=>state(feed).kind==='ok').length,issues=active.filter(feed=>state(feed).kind==='issue').length;
      element.innerHTML=`<article class="coverage-page"><header class="coverage-heading"><div><div class="eyebrow">COVERAGE & SOURCE CHECKS</div><h1>Know where<br><em>the thread comes from.</em></h1><p>See which sources are being checked, when reports last arrived, and where coverage has gaps. A source check confirms collection, not the accuracy or neutrality of every claim.</p></div><button class="button" data-coverage-action="refresh" ${loading?'disabled':''}>${loading?'Checking…':'Refresh source checks'}</button></header>${!connected?'<div class="coverage-alert">This dated edition has no live source checks. Its source links and publication dates remain available on each report.</div>':''}${failures.length?`<div class="coverage-alert" role="alert"><strong>Some coverage details are unavailable.</strong><p>${failures.map(esc).join(' ')}</p><button class="text-button" data-coverage-action="refresh">Try again</button></div>`:''}${connected&&loading&&!pipeline?'<p class="coverage-loading" role="status">Loading source checks and coverage details…</p>':''}${pipeline?`<section class="coverage-stats" aria-label="News coverage window"><div><strong>${number(meta.total)}</strong><span>reports retained</span></div><div><strong>${number(meta.feedDays)} days</strong><span>in the daily news window</span></div><div><strong>${number(meta.retentionDays)} days</strong><span>of news metadata retention</span></div><div><strong>${number(active.length)}</strong><span>active source checks</span></div></section><div class="coverage-freshness"><p><span>Newest report date</span><strong>${time(meta.newestPublishedAt)}</strong></p><p><span>News last added</span><strong>${time(meta.lastStoredAt)}</strong></p><p><span>This page refreshed</span><strong>${time(loadedAt)}</strong></p></div><p class="coverage-window-note">Reports leave the daily view after ${number(meta.feedDays)} days. News metadata has a ${number(meta.retentionDays)}-day retention policy; historical timelines are kept separately. Publication dates, source-check dates and collection dates describe different things.</p><section class="coverage-sources"><div class="coverage-section-heading"><div><span class="eyebrow">CURRENT SOURCES</span><h2>The latest checks, plainly shown.</h2></div><p>${number(successful)} checked successfully${issues?` · ${number(issues)} with a failed latest check`:''}</p></div>${active.length?`<div class="source-check-grid">${active.map(sourceCard).join('')}</div>`:'<p class="coverage-empty">No active source checks were reported. Coverage has not been confirmed.</p>'}</section>${economicStatus()}`:''}${inactive.length?`<details class="coverage-directory"><summary>Other sources in the directory <span>${number(inactive.length)}</span></summary><p>These sources are not currently active. Their presence here does not mean their reporting is being collected.</p><div>${inactive.map(source=>`<article><h3>${esc(source.publisher)}</h3><span>Not active</span>${link(source.terms,'Source information')}</article>`).join('')}</div></details>`:''}${policy?`<section class="coverage-policy"><div class="coverage-section-heading"><div><span class="eyebrow">OUR EDITORIAL SCOPE</span><h2>News with a public impact.</h2></div></div><div><article><h3>What we cover</h3><p>${esc(policy.focus)}</p></article><article><h3>What we leave out</h3><p>${esc(policy.excluded)}</p></article><article><h3>How selection works</h3><p>${esc(policy.selection)}</p></article></div></section>`:''}<aside class="coverage-practice"><h2>Keep the evidence in view.</h2><p>Official releases are useful records of measurements, decisions and institutional positions. Reporting can corroborate or challenge them. Source counts do not establish independent confirmation; repeated accounts can share the same underlying source.</p><a class="text-button" href="#/about">Read our approach ↗</a></aside></article>`;
    }
    async function read(path){
      const response=await fetch(base+path,{credentials:'same-origin',redirect:'error',headers:{accept:'application/json'},signal:controller.signal});
      if(!response.ok)throw new Error('source_details_unavailable');
      const text=await response.text();if(text.length>2*1024*1024)throw new Error('source_details_oversized');
      return JSON.parse(text);
    }
    async function refresh(){
      if(destroyed||loading||!connected)return;
      requested=true;loading=true;failures=[];controller=new AbortController();const attempt=++generation,timer=setTimeout(()=>controller?.abort(),15000);draw();
      const results=await Promise.allSettled([read('/api/pipeline/status'),read('/api/sources'),read('/api/editorial-policy')]);clearTimeout(timer);
      if(destroyed||attempt!==generation)return;
      const [health,directory,editorial]=results;
      if(health.status==='fulfilled'&&Array.isArray(health.value?.feeds)&&health.value.meta){pipeline=health.value;loadedAt=new Date().toISOString();}else failures.push('Source-check times could not be loaded.');
      if(directory.status==='fulfilled'&&Array.isArray(directory.value?.sources))sources=directory.value.sources;else failures.push('The source directory could not be loaded.');
      if(editorial.status==='fulfilled'&&typeof editorial.value?.focus==='string'&&typeof editorial.value?.selection==='string')policy=editorial.value;else failures.push('The current editorial scope could not be loaded.');
      loading=false;draw();
    }
    function handle(event){const button=event.target.closest?.('[data-coverage-action]');if(!button||!element.contains(button))return false;event.preventDefault();if(button.dataset.coverageAction==='refresh')void refresh();return true;}
    function destroy(){destroyed=true;generation++;controller?.abort();element.removeEventListener('click',handle);if(instances.get(element)===view)instances.delete(element);}
    const view={handle,destroy,refresh};instances.set(element,view);element.addEventListener('click',handle);draw();if(!requested)void refresh();return view;
  }
  globalThis.ThreadNewsCoverageStatus={render};
})();
