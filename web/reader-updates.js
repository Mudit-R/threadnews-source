(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let status = null, statusAt = 0, pending = false, error = '', generation = 0;
  const accountPath = () => location.pathname.replace(/\/$/,'') === '/account' || /^#\/account(?:\?|$)/.test(location.hash);
  const eventId = () => {
    const match = location.pathname.match(/^\/threads\/([A-Za-z0-9_.:-]+)\/?$/) || location.hash.match(/^#\/event\/([A-Za-z0-9_.:-]+)/);
    return match ? match[1] : null;
  };
  async function api(path, options = {}) {
    const response = await fetch(path, {credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000),...options,
      headers:{...(options.body?{'content-type':'application/json'}:{}),...(options.headers||{})}});
    const data = await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.message || (data.error==='confirmation_rate_limited'?'Please wait five minutes before requesting another confirmation.':data.error==='sign_in_required'?'Sign in to manage email updates.':'Updates could not be saved. Please retry.'));
    return data;
  }
  function renderAccount(panel) {
    if(!status) {panel.innerHTML='<h2>Updates, on your terms</h2><p>'+esc(error||'Loading your update preferences…')+'</p>';return;}
    const subscription=status.subscription, enabled=status.delivery.enabled;
    const description=subscription.status==='confirmed'?'Your email address is confirmed.':subscription.status==='pending'?'Check your inbox, open the confirmation link, and choose Confirm email updates.':'Email updates are off until you choose them and confirm your email.';
    const feeds=status.feeds;
    panel.innerHTML=`<div class="reader-updates-heading"><span class="eyebrow">KEEP THE THREAD</span><h2>Updates, on your terms.</h2><p>Choose email updates for this account${subscription.email?' ('+esc(subscription.email)+')':''}. Your saved events decide which event alerts you receive.</p></div><form data-reader-updates-form><label><input type="checkbox" name="alerts" ${subscription.alerts?'checked':''} ${!enabled||pending?'disabled':''}>New reporting on followed events</label><label><input type="checkbox" name="weekly" ${subscription.weekly?'checked':''} ${!enabled||pending?'disabled':''}>A weekly headline brief based on my interests</label><p class="reader-update-status" role="status">${esc(description)}</p>${!enabled?'<p class="reader-update-note">'+esc(status.delivery.reason)+'</p>':''}<p>Nothing is sent before confirmation. Each email includes an unsubscribe link. Unsubscribing keeps your saved stories and follows.</p><button class="button" type="submit" ${!enabled||pending?'disabled':''}>${pending?'Saving…':subscription.status==='confirmed'?'Save email choices':'Save and send confirmation'}</button>${subscription.status!=='unsubscribed'?'<button type="button" class="text-button" data-reader-stop '+(pending?'disabled':'')+'>Turn off all emails</button>':''}</form>${error?'<p role="alert" class="reader-update-error">'+esc(error)+'</p>':''}<div class="reader-private-feeds"><h3>Read your follows elsewhere.</h3><p>RSS contains recent source coverage. Calendar entries show documented historical dates, not future reminders. These private links reveal your followed events to anyone you share them with.</p>${feeds?`<label>Private RSS feed<input readonly value="${esc(feeds.rss)}" aria-label="Private RSS feed URL"></label><label>Private calendar feed<input readonly value="${esc(feeds.calendar)}" aria-label="Private calendar feed URL"></label><a class="text-button" href="${esc(feeds.calendar)}">Download calendar (.ics)</a><button type="button" class="text-button" data-reader-revoke ${pending?'disabled':''}>Regenerate private links</button><p class="reader-update-note">Regenerating revokes previous private links. Add the new URL to your reader or calendar afterwards.</p>`:'<p>Private feeds will become available when the site owner connects the signing key. Public event feeds remain available on each timeline.</p>'}</div>`;
  }
  async function load(panel, force=false) {
    const current=++generation;
    if(status&&Date.now()-statusAt<30000&&!force){renderAccount(panel);return;}
    try { const result=await api('/api/account/email-updates');if(current!==generation)return;status=result;statusAt=Date.now();error=''; }
    catch(failure){if(current===generation)error=failure.message;}
    if(current===generation&&panel.isConnected)renderAccount(panel);
  }
  function mount() {
    const root=document.getElementById('main');if(!root)return;
    if(accountPath()&&root.querySelector('.account-heading')&&!root.querySelector('#reader-account-updates')) {
      status=null;statusAt=0;generation++;
      const panel=document.createElement('section');panel.id='reader-account-updates';panel.className='reader-account-updates';
      root.querySelector('.account-page')?.append(panel);renderAccount(panel);void load(panel);
    }
    const id=eventId();
    if(id&&root.querySelector('#event-panel')&&!root.querySelector('#reader-event-feeds')) {
      const panel=document.createElement('section');panel.id='reader-event-feeds';panel.className='reader-event-feeds';
      panel.innerHTML=`<div><span class="eyebrow">TAKE THE THREAD WITH YOU</span><h2>Follow the record.</h2><p>Subscribe to source coverage in your RSS reader, or add the documented timeline dates to your calendar. Calendar entries describe historical events, not appointments or predictions.</p></div><div class="reader-feed-actions"><a class="button" href="/api/events/${encodeURIComponent(id)}/feed.rss">RSS source coverage ↗</a><a class="button" href="/api/events/${encodeURIComponent(id)}/calendar.ics">Download timeline calendar</a></div>`;
      root.append(panel);
    }
  }
  document.addEventListener('submit',async event=>{
    const form=event.target.closest('[data-reader-updates-form]');if(!form)return;event.preventDefault();if(pending)return;
    const body={alerts:form.elements.alerts.checked,weekly:form.elements.weekly.checked};
    pending=true;error='';const panel=document.getElementById('reader-account-updates');renderAccount(panel);
    try{const result=await api('/api/account/email-updates',{method:'PUT',body:JSON.stringify(body)});statusAt=0;if(result.status==='pending')error=result.confirmation==='sent'?'Confirmation email sent. Open it to activate your updates.':'Confirmation is queued for delivery. Open the email when it arrives to activate your updates.';const notice=error;await load(panel,true);error=notice;}
    catch(failure){error=failure.message;}finally{pending=false;if(panel.isConnected)renderAccount(panel);}
  });
  document.addEventListener('click',async event=>{
    const stop=event.target.closest('[data-reader-stop]'),revoke=event.target.closest('[data-reader-revoke]');if(!stop&&!revoke)return;if(pending)return;
    const panel=document.getElementById('reader-account-updates');pending=true;error='';renderAccount(panel);
    try{if(stop){await api('/api/account/email-updates',{method:'PUT',body:JSON.stringify({alerts:false,weekly:false})});await load(panel,true);}else{const result=await api('/api/account/feed-links',{method:'POST',body:'{}'});status.feeds=result.links;error='Previous private feed links are revoked.';}}
    catch(failure){error=failure.message;}finally{pending=false;if(panel.isConnected)renderAccount(panel);}
  });
  document.addEventListener('click',event=>{if(event.target.closest('[data-action="account-logout"], [data-action="logout"], [data-action="account-delete"]')){status=null;statusAt=0;generation++;}});
  function start(){if(globalThis.THREADLINE_CONFIG?.mode!=='production')return;new MutationObserver(mount).observe(document.getElementById('main')||document.body,{childList:true,subtree:true});mount();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
}());
