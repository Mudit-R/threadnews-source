(() => {
  const modelKey = 'threadnews.recommendations.v1';
  const date = value => new Intl.DateTimeFormat(undefined,{ dateStyle:'medium' }).format(new Date(value));
  function el(tag,text,className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function button(text, run, className = 'button') {
    const element = el('button',text,className);
    element.type='button';
    element.addEventListener('click',run);
    return element;
  }
  function link(text, href) {
    const anchor = el('a',text);
    anchor.href=href;
    return anchor;
  }
  function mountRecommendations(container,loadCandidates) {
    const section=el('section',null,'reader-lab');
    section.append(el('h2','Learn my interests'));
    section.append(el('p','Rate a few headlines and see your recommendations adapt. Training and ranking happen on this device.'));
    const state=el('p',null,'reader-lab-status');
    state.setAttribute('role','status');
    const cards=el('div',null,'reader-lab-grid');
    const controls=el('div',null,'reader-lab-controls');
    const remember=el('input');
    remember.type='checkbox';
    const label=el('label');
    label.append(remember,' Remember my feedback on this device');
    let history=[], articles=[], worker, sequence=0, request;
    try {
      const stored=localStorage.getItem(modelKey);
      if (stored) { history=JSON.parse(stored); remember.checked=true; }
    } catch { history=[]; }

    function persist() {
      try {
        if (remember.checked) localStorage.setItem(modelKey,JSON.stringify(history));
        else localStorage.removeItem(modelKey);
      } catch { state.textContent='Device storage is unavailable. Feedback works for this visit.'; }
    }
    function rank(feedback) {
      if (!worker) {
        worker=new Worker('/article-ranker-worker.js?v=1');
        worker.addEventListener('error',() => {
          state.textContent='Recommendations could not start on this device.';
          worker?.terminate(); worker=null;
        });
        worker.addEventListener('message',({ data }) => {
          if (data.request!==sequence) return;
          history=data.history;
          state.textContent=history.length ? `${history.length} feedback ${history.length===1?'example':'examples'} used on this device.` : 'Choose a headline to train your recommendations.';
          if (remember.checked) persist();
          cards.replaceChildren(...data.ranked.map(({ article,reason }) => {
            const card=el('article');
            card.append(el('p',article.source?.publisher,'reader-lab-meta'));
            const title=el('h3'); title.append(link(article.title,`/news/${encodeURIComponent(article.id)}`));
            const feedback=el('div',null,'reader-lab-controls');
            feedback.append(button('More like this',() => rank({ id:article.id,label:1 })),button('Less like this',() => rank({ id:article.id,label:0 })));
            card.append(title,el('p',reason,'reader-lab-meta'),feedback);
            return card;
          }));
          if (!data.ranked.length) state.textContent='You’ve rated all the stories in this selection. Try again after the next edition.';
        });
      }
      for (const control of cards.querySelectorAll('button')) control.disabled=true;
      worker.postMessage({ request:++sequence, articles, history, feedback });
    }
    async function load() {
      request?.abort();
      const active=new AbortController(); request=active;
      start.disabled=true;
      state.textContent='Loading recent headlines…';
      try {
        articles=await loadCandidates({signal:active.signal});
        if (request!==active) return;
        rank();
        start.textContent='Refresh headlines';
      } catch { if (request===active) state.textContent='Recommendations are unavailable. Try again.'; }
      finally { if (request===active) { request=null; start.disabled=false; } }
    }
    const start=button('Try recommendations',load,'button primary');
    const reset=button('Reset feedback',() => {
      history=[]; remember.checked=false; persist();
      if (articles.length&&worker) rank();
      else state.textContent='Feedback cleared.';
    });
    remember.addEventListener('change',persist);
    controls.append(start,label,reset);
    section.append(controls,state,cards);
    container.replaceChildren(section);
  }

  function mountWatchlist(container,apiBase) {
    const section=el('section',null,'reader-lab');
    section.append(el('h2','New in your followed stories'));
    section.append(el('p','Check recent reports added to timelines you follow. Your read position syncs with your account.'));
    const status=el('p',null,'reader-lab-status');
    status.setAttribute('role','status');
    const list=el('div',null,'reader-lab-grid');
    let generation=0;
    async function load() {
      const turn=++generation;
      list.replaceChildren();
      refresh.disabled=true;
      status.textContent='Checking followed stories…';
      try {
        const res=await fetch(apiBase+'/api/watchlist',{signal:AbortSignal.timeout(10000)});
        if (turn!==generation) return;
        if (res.status===401) { status.replaceChildren(link('Sign in to see your followed story updates','/signin')); return; }
        if (res.status===403) { status.replaceChildren(link('Unlock followed story updates with a Supporter plan','/pricing')); return; }
        if (!res.ok) throw Error('unavailable');
        const snapshot=await res.json();
        if (turn!==generation) return;
        status.textContent=snapshot.events.length ? 'Up to three recent reports per story.'
          : snapshot.followed ? 'You’re caught up with the recent edition.' : 'Follow a timeline to start tracking updates.';
        list.replaceChildren(...snapshot.events.map(event => {
          const card=el('article');
          const title=el('h3'); title.append(link(event.title,`/threads/${encodeURIComponent(event.id)}`));
          const reports=el('ul');
          for (const item of event.reports) {
            const row=el('li'); row.append(link(item.title,`/news/${encodeURIComponent(item.id)}`),el('small',[item.publisher,date(item.publishedAt)].filter(Boolean).join(' · ')));
            reports.append(row);
          }
          const mark=button('Mark story checked',async () => {
            mark.disabled=true;
            try {
              const result=await fetch(apiBase+'/api/watchlist/ack',{method:'POST',headers:{'content-type':'application/json'},
                body:JSON.stringify({eventId:event.id,through:snapshot.through}),signal:AbortSignal.timeout(10000)});
              if (!result.ok) throw Error('not saved');
              await load();
            } catch { status.textContent='Could not mark the story checked. Try again.'; mark.disabled=false; }
          });
          card.append(title,el('p',`${event.unread} new ${event.unread===1?'report':'reports'}`,'reader-lab-meta'),reports,mark);
          return card;
        }));
      } catch { if (turn===generation) status.textContent='Updates could not be loaded. Try again.'; }
      finally { if (turn===generation) refresh.disabled=false; }
    }
    const refresh=button('Check for updates',load);
    section.append(refresh,status,list);
    container.replaceChildren(section);
    void load();
    return load;
  }
  globalThis.ThreadNewsReaderLab=Object.freeze({mountRecommendations,mountWatchlist});
})();
