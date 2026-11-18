/* Account controls share the site's same-origin API; no provider tokens enter JS. */
globalThis.createAccountView=function createAccountView(options){
  'use strict';
  const {esc,toast,getSession,readLocal,applyLocal,onPreferences,onSignedOut,renderNav}=options;
  const connected=options.connected===true,apiBase=String(options.apiBase||'').replace(/\/$/,'');
  const GUEST_KEY='threadnews-guest-collection',OWNER_KEY='threadnews-reading-owner',QUEUE_KEY='threadnews-save-queue:';
  const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
  let account=null,notice=null,loading=false,loadPromise=null,syncing=false,error='',deleting=false,confirmDelete=false,lifecycle=0,revision=0,lastLoaded=0;
  const memory=new Map();
  const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return memory.get(key)??fallback;}};
  const write=(key,value)=>{memory.set(key,value);try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}};
  const remove=key=>{memory.delete(key);try{localStorage.removeItem(key);}catch{}};
  const ids=(value,max)=>Array.isArray(value)?[...new Set(value.filter(id=>typeof id==='string'&&ID.test(id)))].slice(0,max):[];
  const clean=value=>({articles:ids(value?.articles,500),events:ids(value?.events,200)});
  const userId=()=>getSession()?.user?.id||null;
  const owner=()=>{const value=read(OWNER_KEY,'guest');return typeof value==='string'?value:'guest';};
  const queue=id=>{const value=read(QUEUE_KEY+id,[]);return Array.isArray(value)?value.filter(x=>x&&['article','event'].includes(x.type)&&typeof x.id==='string'&&ID.test(x.id)&&typeof x.saved==='boolean'&&typeof x.revision==='string').slice(-700):[];};
  function updateQueue(id,value){write(QUEUE_KEY+id,value);}
  function overlay(collection,id){
    const result=clean(collection),sets={article:new Set(result.articles),event:new Set(result.events)};
    for(const item of queue(id)){if(item.saved)sets[item.type].add(item.id);else sets[item.type].delete(item.id);}
    return {articles:[...sets.article],events:[...sets.event]};
  }
  function redraw(){
    const page=location.hash.split('?')[0];
    if(page==='#/account')renderAccount();else if(page==='#/privacy')renderPrivacy();
    options.onChange?.();
  }
  function apply(collection){applyLocal?.(clean(collection));}
  async function request(path,{method='GET',body}={}){
    const response=await fetch(apiBase+path,{method,credentials:'same-origin',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
    let data;try{data=await response.json();}catch{data={};}
    if(!response.ok){const failure=new Error(data.error||'service_unavailable');failure.status=response.status;failure.data=data;throw failure;}
    return data;
  }
  function explain(failure){
    if(failure.message==='apple_reauthentication_required')return 'Sign in with Apple again before deleting this account so its Apple authorization can be revoked.';
    if(failure.message==='apple_revocation_unavailable')return 'Apple could not confirm revocation. Your account has not been deleted. Please retry shortly or contact ThreadNews.';
    return failure.status===401?'Your session has expired. Sign in again to sync your reading space.':failure.name==='TimeoutError'?'The account service timed out. Your browser saves are still available.':'The account service could not be reached. You can retry; pending saves stay in this browser.';
  }
  async function load(){
    const id=userId();if(!connected||!id)return null;
    if(loadPromise)return loadPromise;
    const generation=lifecycle,startRevision=revision;
    if(owner()!==id){
      if(owner()==='guest')write(GUEST_KEY,clean(readLocal?.()));
      write(OWNER_KEY,id);
      account=null;
      apply({articles:[],events:[]});
    }
    loading=true;error='';redraw();
    loadPromise=(async()=>{
      try{
        const result=await request('/api/account');
        if(generation!==lifecycle||id!==userId())return null;
        if(startRevision===revision||!account)account=result;
        else account={...result,collection:account.collection};
        write(OWNER_KEY,id);apply(overlay(account.collection,id));lastLoaded=Date.now();
        return result;
      }catch(failure){if(generation===lifecycle)error=explain(failure);return null;}
      finally{if(generation===lifecycle){loading=false;loadPromise=null;redraw();}}
    })();
    const result=await loadPromise;
    if(result&&queue(id).length)void flush();
    return result;
  }
  async function flush(){
    const id=userId();if(!connected||!id||syncing||!queue(id).length)return;
    const generation=lifecycle;syncing=true;error='';redraw();
    try{
      while(id===userId()&&generation===lifecycle&&queue(id).length){
        const item=queue(id)[0];
        let result;
        try{result=await request('/api/account/collection',{method:'PATCH',body:{type:item.type,id:item.id,saved:item.saved}});}
        catch(failure){
          if(failure.status!==404&&failure.status!==409)throw failure;
          result=failure.data;
          if(!result?.collection&&!account?.collection)result=await request('/api/account/collection');
          toast?.(failure.status===409?'Your account collection is full. Remove a save before adding another.':'This record is no longer available to add to your account.');
        }
        if(generation!==lifecycle||id!==userId())return;
        const remaining=queue(id).filter(entry=>entry.revision!==item.revision);updateQueue(id,remaining);
        revision++;
        if(result?.collection)account={...(account||{}),collection:result.collection};
        if(account?.collection)apply(overlay(account.collection,id));
        redraw();
      }
    }catch(failure){if(generation===lifecycle)error=explain(failure);}
    finally{if(generation===lifecycle){syncing=false;redraw();}}
  }
  function syncSave(type,id,saved){
    const uid=userId();if(!connected||!uid||!['article','event'].includes(type)||typeof id!=='string'||!ID.test(id))return;
    const items=queue(uid).filter(item=>item.type!==type||item.id!==id);
    if(items.length>=700){error='There are too many pending changes. Reconnect and retry sync before saving more stories.';redraw();return;}
    items.push({type,id,saved:!!saved,revision:crypto.randomUUID()});updateQueue(uid,items);
    return flush();
  }
  function signedOut(){
    lifecycle++;account=null;loading=false;loadPromise=null;syncing=false;error='';confirmDelete=false;
    apply(clean(read(GUEST_KEY,{articles:[],events:[]})));write(OWNER_KEY,'guest');
  }
  async function importGuest(){
    const id=userId();if(!id||loading||syncing)return;
    const guest=clean(read(GUEST_KEY,{articles:[],events:[]}));loading=true;error='';redraw();
    try{
      const result=await request('/api/account/collection/import',{method:'POST',body:guest});
      if(id!==userId())return;
      account={...(account||{}),collection:result.collection};revision++;apply(overlay(result.collection,id));
      const skipped=(result.notAdded?.articles?.length||0)+(result.notAdded?.events?.length||0);
      toast?.(skipped?`Browser saves imported. ${skipped} unavailable or over-limit records could not be added.`:'Your browser saves are now in your account.');
    }catch(failure){error=explain(failure);}finally{loading=false;redraw();}
  }
  async function exportData(){
    try{
      const result=await request('/api/account/export'),url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'})),link=document.createElement('a');
      link.href=url;link.download='threadnews-account.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast?.('Your account export is ready.');
    }catch(failure){error=explain(failure);redraw();}
  }
  async function deleteAccount(){
    if(document.getElementById('account-delete-confirm')?.value!=='DELETE'||deleting)return;
    const id=userId();deleting=true;error='';redraw();
    try{
      await request('/api/account',{method:'DELETE',body:{confirm:'DELETE'}});
      remove(QUEUE_KEY+id);signedOut();onSignedOut?.();location.hash='#/';toast?.('Your account and active account data have been deleted.');
    }catch(failure){error=explain(failure);}
    finally{deleting=false;redraw();}
  }
  async function logout(){
    try{await request('/api/auth/logout',{method:'POST'});signedOut();onSignedOut?.();location.hash='#/';toast?.('Signed out. Your guest reading space is restored.');}
    catch(failure){error=explain(failure);redraw();}
  }
  function errorBox(){return error?`<div class="account-alert" role="alert"><p>${esc(error)}</p><button class="button" data-action="account-retry">Retry sync</button>${error.includes('expired')?'<a class="button" href="#/signin">Sign in</a>':''}</div>`:'';}
  function editionPreferences(session) {
    const current=session.preferences?.newsCountry || '';
    const options=new Map([['','Global']]);
    for(const country of globalThis.ECONOMY_SNAPSHOT?.countries || []) {
      if(/^[A-Z]{2}$/.test(country.code || '')) options.set(country.code,country.name);
    }
    if(current&&!options.has(current))options.set(current,new Intl.DisplayNames('en',{type:'region'}).of(current));
    return `<article class="account-card account-edition"><h2>Top stories edition</h2><label for="account-news-country">Default country</label>
      <div><select id="account-news-country">${[...options].map(([code,name])=>`<option value="${esc(code)}"${code===current?' selected':''}>${esc(name)}</option>`).join('')}</select>
      <button class="button" type="button" data-action="account-news-country">Save</button></div>
      <p>Used when you open the Top 5 stories on any device where you are signed in.</p></article>`;
  }
  async function saveEdition(button) {
    const field=document.getElementById('account-news-country');
    if(!field)return;
    const id=userId();
    button.disabled=true;field.disabled=true;
    try {
      const result=await request('/api/preferences',{method:'PUT',body:{newsCountry:field.value}});
      if(id!==userId())return;
      onPreferences?.(result.preferences);
      toast?.('Default news edition saved.');
    } catch(failure) {
      toast?.(explain(failure));
    } finally {
      button.disabled=false;field.disabled=false;
    }
  }
  function renderAccount(){
    const main=document.getElementById('main');if(!main)return;
    const session=getSession(),user=session?.user;
    if(!user){main.innerHTML=`<section class="account-page"><div class="eyebrow">YOUR READING SPACE</div><h1>Keep your world<br><em>within reach.</em></h1><p class="account-intro">Reading is open. Sign in when a provider is available to carry your interests, saved articles and followed timelines across devices.</p><a class="button primary" href="#/signin">Sign in</a><a class="account-privacy-link" href="#/privacy">How ThreadNews uses your data ↗</a></section>`;renderNav?.();return;}
    const lists=clean(account?.collection||readLocal?.()),guest=clean(read(GUEST_KEY,{articles:[],events:[]})),pending=queue(user.id).length,guestCount=guest.articles.length+guest.events.length;
    main.innerHTML=`<section class="account-page"><div class="account-heading"><div><div class="eyebrow">YOUR READING SPACE</div><h1>A little more<br><em>your world.</em></h1><p class="account-intro">${esc(user.name||user.email||'Your account')} · ${loading?'Loading account…':syncing?'Syncing saves…':pending?`${pending} pending ${pending===1?'change':'changes'}`:account?'Account connected':'Waiting for account data'}</p></div><button class="button" data-action="account-logout">Sign out</button></div>${errorBox()}<div class="account-grid">${editionPreferences(session)}<article class="account-card"><h2>Your collection</h2><div class="account-counts"><a href="#/following"><strong>${lists.articles.length}</strong><span>saved articles</span></a><a href="#/following"><strong>${lists.events.length}</strong><span>followed timelines</span></a></div><p>Signed-in saves sync to this account. You can keep up to 500 articles and 200 timelines. An expired article stays listed as unavailable until you remove its save.</p><a class="text-button" href="#/following">Open your collection ↗</a></article><article class="account-card"><h2>Browser to account</h2><p>Guest saves stay separate from your account. Import them when you want to carry this browser’s reading list with you.</p><button class="button" data-action="account-import" ${!guestCount||loading||syncing?'disabled':''}>${guestCount?`Import ${guestCount} browser saves`:'No guest saves to import'}</button><small>Unavailable records and records above the account limit are reported after import.</small></article><article class="account-card"><h2>Your data, in your hands</h2><p>Download your profile, topic choices and saved identifiers as JSON. Your export contains no authentication credentials.</p><button class="button" data-action="account-export">Download account data</button><a class="account-privacy-link" href="#/privacy">Read the privacy notice ↗</a></article><article class="account-card account-danger"><h2>Delete your account</h2><p>This removes your active profile, interests, saved identifiers and every active sign-in session. You can keep reading as a guest.</p>${confirmDelete?`<div class="account-delete-form"><label for="account-delete-confirm">Type <strong>DELETE</strong> to confirm.</label><input id="account-delete-confirm" type="text" autocomplete="off" spellcheck="false" inputmode="text" maxlength="6" aria-describedby="account-delete-note"><small id="account-delete-note">This action cannot be undone. Your guest browser collection remains separate.</small><div class="account-delete-actions"><button class="button account-delete-button" data-action="account-delete" disabled>${deleting?'Deleting…':'Delete account permanently'}</button><button class="text-button" data-action="account-delete-cancel" ${deleting?'disabled':''}>Cancel</button></div></div>`:`<button class="text-button account-delete-button" data-action="account-delete-open">Delete account…</button>`}</article></div></section>`;document.title='Your account — ThreadNews';renderNav?.();
  }
  function renderPrivacy(){
    const main=document.getElementById('main');if(!main)return;
    main.innerHTML=`<article class="privacy-page"><a class="text-button" href="#/account">← Your reading space</a><div class="eyebrow">PRIVACY & ACCOUNT CONTROLS</div><h1>Your data<br><em>at ThreadNews.</em></h1>${notice?`<p class="account-intro">Updated ${esc(notice.updatedAt)}${notice.operator?` · Operated by ${esc(notice.operator)}`:''}.</p>${notice.sections.map(section=>`<section><h2>${esc(section.title)}</h2><p>${esc(section.text)}</p></section>`).join('')}<section><h2>Provider privacy notices</h2><ul>${notice.providers.map(provider=>`<li><a href="${esc(provider.url)}" target="_blank" rel="noopener noreferrer">${esc(provider.name)} ↗</a></li>`).join('')}</ul>${notice.contact?`<p><a class="text-button" href="${esc(notice.contact)}">Contact the operator about your data ↗</a></p>`:'<p>The operator has not published a contact channel here yet. Signed-in readers can export or delete their active account data directly from the account page.</p>'}</section>`:connected?`<p class="account-intro">${error?'The privacy details could not be loaded. Please retry.':'Loading the current privacy notice…'}</p>${errorBox()}`:'<p class="account-intro">This dated preview keeps interests and saves in this browser. Account services are available only on the connected deployment. You can remove browser data through your browser settings.</p>'}</article>`;document.title='Privacy — ThreadNews';renderNav?.();
    if(connected&&!notice&&!loading&&!error)void loadPrivacy();
  }
  async function loadPrivacy(){loading=true;try{notice=await request('/api/privacy');error='';}catch(failure){error=explain(failure);}finally{loading=false;redraw();}}
  function handleAction(event,button){
    const action=button.dataset.action;
    if(!action?.startsWith('account-'))return false;
    event.preventDefault();
    if(action==='account-retry'){error='';if(location.hash.split('?')[0]==='#/privacy')void loadPrivacy();else void load().then(()=>flush());}
    if(action==='account-import')void importGuest();
    if(action==='account-export')void exportData();
    if(action==='account-news-country')void saveEdition(button);
    if(action==='account-logout')void logout();
    if(action==='account-delete-open'){confirmDelete=true;renderAccount();document.getElementById('account-delete-confirm')?.focus();}
    if(action==='account-delete-cancel'){confirmDelete=false;renderAccount();}
    if(action==='account-delete')void deleteAccount();
    return true;
  }
  function handleInput(event){if(event.target.id!=='account-delete-confirm')return false;const button=document.querySelector('[data-action="account-delete"]');if(button)button.disabled=event.target.value!=='DELETE'||deleting;return true;}
  function refreshOnFocus(){if(connected&&userId()&&!syncing&&!loading&&Date.now()-lastLoaded>60000&&document.visibilityState==='visible')void load();}
  window.addEventListener('focus',refreshOnFocus);
  return {load,syncSave,signedOut,renderAccount,renderPrivacy,handleAction,handleInput,flush,importGuest};
};
