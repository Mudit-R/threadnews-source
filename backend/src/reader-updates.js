import { appOrigin, currentSession, sameOriginMutation } from './auth.js';
import { readLimited, sha256 } from './feed.js';
import { hasPaidAccess } from './paypal.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const TOKEN = /^[A-Za-z0-9_-]{40,60}$/;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/[&<>"']/g, x => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[x]));
const epoch = () => Math.floor(Date.now() / 1000);
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const base64 = value => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unbase64 = value => new Uint8Array(Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)));
const text = value => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 600);

export function deliveryConfig(env) {
  const sender = String(env.EMAIL_FROM || '').trim();
  const tokenReady = typeof env.EMAIL_TOKEN_SECRET === 'string' && env.EMAIL_TOKEN_SECRET.length >= 32;
  const senderReady = /^[^\r\n<>\s]+@[^\r\n<>\s]+\.[^\r\n<>\s]+$/.test(sender);
  const address = String(env.EMAIL_POSTAL_ADDRESS || env.LEGAL_SELLER_ADDRESS || '').trim();
  const enabled = env.EMAIL_SEND_ENABLED === 'true' && !!env.RESEND_API_KEY && tokenReady && senderReady && address.length>=6 && address.length<=1000 && !!appOrigin(env);
  return { enabled, feedsEnabled: tokenReady && !!appOrigin(env), sender: senderReady ? sender : null,
    reason: enabled ? null : 'Email delivery is not connected yet. Your follows and downloadable feeds still work.',
    dailyLimit: Math.max(1, Math.min(10000, Number(env.EMAIL_DAILY_LIMIT) || 80)) };
}
async function signingKey(env) { return crypto.subtle.importKey('raw', new TextEncoder().encode(env.EMAIL_TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']); }
async function signedToken(env, purpose, data) {
  const body = base64(JSON.stringify(data)), signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), new TextEncoder().encode(purpose + ':' + body)));
  return body + '.' + btoa(String.fromCharCode(...signature)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function verifyToken(env, purpose, value) {
  if (typeof env.EMAIL_TOKEN_SECRET !== 'string' || env.EMAIL_TOKEN_SECRET.length < 32 || typeof value !== 'string' || value.length > 1000) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await signingKey(env), unbase64(parts[1]), new TextEncoder().encode(purpose + ':' + parts[0]))) return null;
    const data = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    return typeof data.u === 'string' && ID.test(data.u) ? data : null;
  } catch { return null; }
}
async function ensureReader(env, user, now = epoch()) {
  await env.DB.prepare(`INSERT OR IGNORE INTO reader_updates (user_id,feed_version,created_at,updated_at) VALUES (?,?,?,?)`)
    .bind(user.id, crypto.randomUUID(), now, now).run();
  return env.DB.prepare('SELECT * FROM reader_updates WHERE user_id=?').bind(user.id).first();
}
async function privateLinks(env, row) {
  if (!deliveryConfig(env).feedsEnabled) return null;
  const value = await signedToken(env, 'feed', { u: row.user_id, v: row.feed_version });
  const root = appOrigin(env) + '/api/reader/following';
  return { rss: root + '.rss?token=' + value, calendar: root + '.ics?token=' + value };
}
function htmlPage(title, content, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${xml(title)} — ThreadNews</title><style>body{font:18px/1.6 system-ui;max-width:640px;margin:12vh auto;padding:24px;color:#18352f;background:#f6f5ef}h1{font:2.5em Georgia}button,a{color:inherit}button{padding:12px 20px;cursor:pointer}</style></head><body><h1>${xml(title)}</h1>${content}<p><a href="/account">Return to your account</a></p></body></html>`, { status, headers: { 'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}
async function bodyJson(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('json_required');
  try { return JSON.parse(await readLimited(request, 4096)); } catch { throw new Error('invalid_request'); }
}
async function queueMessage(env, { id, userId, kind, payload, now }) {
  await env.DB.prepare('INSERT OR IGNORE INTO reader_email_outbox (id,user_id,kind,payload_json,created_at,next_attempt_at) VALUES (?,?,?,?,?,?)')
    .bind(id, userId, kind, JSON.stringify(payload), now, now).run();
}
async function unsubscribeUrl(env, userId) { return appOrigin(env) + '/api/email/unsubscribe?token=' + await signedToken(env, 'unsubscribe', { u: userId }); }
function emailPayload(env, email, subject, lines, unsubscribe, watermark) {
  const address=String(env.EMAIL_POSTAL_ADDRESS || env.LEGAL_SELLER_ADDRESS || '').trim();
  return { to: email, subject, text: [...lines, '', 'You requested these updates from ThreadNews.', 'Unsubscribe: ' + unsubscribe, address].join('\n'),
    html: `<div><h1>${xml(subject)}</h1>${lines.map(line => `<p>${xml(line)}</p>`).join('')}<p>You requested these updates from ThreadNews. <a href="${xml(unsubscribe)}">Unsubscribe</a>.</p><p>${xml(address)}</p></div>`, unsubscribe, watermark };
}
async function handleEmailLink(request, env, url, now) {
  const confirmation = url.pathname === '/api/email/confirm';
  const value = url.searchParams.get('token') || '';
  if (!['GET','POST'].includes(request.method)) return json({error:'method_not_allowed'},405);
  let row;
  if (confirmation) {
    if (!TOKEN.test(value)) return htmlPage('This link is unavailable', '<p>Request a new confirmation from your account.</p>',400);
    row = await env.DB.prepare('SELECT * FROM reader_updates WHERE confirm_hash=? AND confirm_expires_at>? AND status=?').bind(await sha256(value),now,'pending').first();
  } else {
    const data = await verifyToken(env, 'unsubscribe', value);
    if (data) row = await env.DB.prepare('SELECT * FROM reader_updates WHERE user_id=?').bind(data.u).first();
  }
  if (!row) return htmlPage('This link is unavailable', '<p>The link expired or the account no longer exists. Manage updates from your account.</p>',400);
  if (request.method === 'GET') return htmlPage(confirmation ? 'Confirm your email updates' : 'Stop email updates', `<p>${confirmation ? 'Confirm that you want ThreadNews to send the selected updates to your email address.' : 'This stops event alerts and weekly briefs. Your saved stories and followed timelines stay in your account.'}</p><form method="post"><button type="submit">${confirmation ? 'Confirm email updates' : 'Unsubscribe'}</button></form>`);
  if (confirmation) {
    const changed = await env.DB.prepare(`UPDATE reader_updates SET status='confirmed',confirmed_at=?,last_alert_at=?,alert_cursor_at=?,alert_cursor_id='',confirm_hash=NULL,confirm_expires_at=NULL,updated_at=? WHERE user_id=? AND confirm_hash=? AND confirm_expires_at>? AND status='pending' RETURNING user_id`)
      .bind(now,now,new Date(now*1000).toISOString(),now,row.user_id,await sha256(value),now).first();
    if (!changed) return htmlPage('This link is unavailable','<p>Request a new confirmation from your account.</p>',400);
    return htmlPage('Email updates confirmed','<p>Your selected updates are now active. You can change them or unsubscribe at any time.</p>');
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE reader_updates SET status='unsubscribed',alerts_enabled=0,weekly_enabled=0,confirm_hash=NULL,confirm_expires_at=NULL,updated_at=? WHERE user_id=?`).bind(now,row.user_id),
    env.DB.prepare("DELETE FROM reader_email_outbox WHERE user_id=? AND state<>'sent'").bind(row.user_id)
  ]);
  return htmlPage('You are unsubscribed','<p>ThreadNews will no longer send event alerts or weekly briefs to this account.</p>');
}

const icsEscape = value => String(value ?? '').replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
function foldIcs(value) {
  let line = '', bytes = 0, result = [];
  for (const char of value) { const n = new TextEncoder().encode(char).length; if (bytes + n > 73) { result.push(line); line=' '; bytes=1; } line+=char;bytes+=n; }
  result.push(line);return result.join('\r\n');
}
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value ? value : null; }
export async function timelineCalendar(events, { origin, limit = Infinity } = {}) {
  const rows=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ThreadNews//Source-linked historical timeline//EN','CALSCALE:GREGORIAN','X-WR-CALNAME:ThreadNews followed timelines'];
  for (const event of events) for (const milestone of (event.milestones || []).slice(0,limit)) {
    const date=validDate(milestone.date);if(!date)continue;
    const uid=(await sha256(event.id+'\0'+date+'\0'+milestone.title)).slice(0,32)+'@threadnews.online';
    const sources=(milestone.sources||[]).map(source=>source.url).filter(value=>/^https?:\/\//.test(value||''));
    const description=[milestone.dateType==='publication'?'Report publication date.':'Documented event date.',milestone.summary||milestone.body||'',...sources].filter(Boolean).join('\n');
    const updated=Number.isFinite(Date.parse(event.updatedAt||''))?event.updatedAt:date;
    rows.push('BEGIN:VEVENT','UID:'+uid,'DTSTAMP:'+new Date(updated).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),'DTSTART;VALUE=DATE:'+date.replace(/-/g,''),'SUMMARY:'+icsEscape(event.title+': '+milestone.title),'DESCRIPTION:'+icsEscape(description),'URL:'+origin+'/threads/'+encodeURIComponent(event.id),'TRANSP:TRANSPARENT','END:VEVENT');
  }
  rows.push('END:VCALENDAR');return rows.map(foldIcs).join('\r\n')+'\r\n';
}
export function coverageRss(title, items, origin, feedUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(title)}</title><link>${xml(origin)}</link><description>Source-linked reporting around your followed events. Source headlines are distinct from reviewed timeline milestones.</description><atom:link href="${xml(feedUrl)}" rel="self" type="application/rss+xml"/>${items.map(item=>`<item><guid isPermaLink="false">${xml(item.id)}</guid><title>${xml(item.title)}</title><link>${xml(origin+'/threads/'+encodeURIComponent(item.eventId))}</link><pubDate>${xml(new Date(item.publishedAt).toUTCString())}</pubDate><description>${xml((item.source?.publisher||'Source report')+' — '+(item.source?.url||''))}</description></item>`).join('')}</channel></rss>`;
}
async function feedResponse(request, env, url, now) {
  const event = url.pathname.match(/^\/api\/events\/([A-Za-z0-9_.:-]+)\/(feed\.rss|calendar\.ics)$/);
  const personal = url.pathname.match(/^\/api\/reader\/following\.(rss|ics)$/);
  if (!event && !personal) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({error:'method_not_allowed'},405);
  let userId=null, ids=[], paid=false;
  if (personal) {
    const data=await verifyToken(env,'feed',url.searchParams.get('token')||'');
    if (!data) return json({error:'invalid_feed_token'},401);
    const row=await env.DB.prepare('SELECT feed_version FROM reader_updates WHERE user_id=?').bind(data.u).first();
    if (!row || row.feed_version!==data.v) return json({error:'invalid_feed_token'},401);
    userId=data.u;
    ids=(await env.DB.prepare("SELECT record_id FROM reading_saves WHERE user_id=? AND record_type='event' ORDER BY saved_at DESC LIMIT 200").bind(userId).all()).results.map(row=>row.record_id);
  } else {
    if (!ID.test(event[1]))return json({error:'invalid_event'},400);
    ids=[event[1]];userId=(await currentSession(request,env)).user?.id||null;
  }
  paid=await hasPaidAccess(env,userId,now);
  const payloads=ids.length?(await env.DB.prepare('SELECT id,updated_at,payload_json FROM event_payloads WHERE id IN (SELECT value FROM json_each(?)) ORDER BY updated_at DESC').bind(JSON.stringify(ids)).all()).results:[];
  if (event&&!payloads.length)return json({error:'event_not_found'},404);
  const events=payloads.map(row=>({...parse(row.payload_json),id:row.id,updatedAt:row.updated_at}));
  const calendar=personal?personal[1]==='ics':event[2]==='calendar.ics';
  const headers={'content-type':calendar?'text/calendar; charset=utf-8':'application/rss+xml; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
  if(calendar)headers['content-disposition']='inline; filename="threadnews-timeline.ics"';
  let body;
  if (calendar) body=await timelineCalendar(events,{origin:appOrigin(env),limit:paid?Infinity:10});
  else {
    const cutoff=new Date((now-(paid?30:7)*86400)*1000).toISOString();
    const coverage=ids.length?(await env.DB.prepare('SELECT id,event_id,published_at,payload_json FROM event_coverage WHERE event_id IN (SELECT value FROM json_each(?)) AND published_at>=? ORDER BY published_at DESC,id DESC LIMIT 100').bind(JSON.stringify(ids),cutoff).all()).results:[];
    body=coverageRss(personal?'Your ThreadNews follows':(events[0]?.title||'ThreadNews')+' — source coverage',coverage.map(row=>({...parse(row.payload_json),id:row.id,eventId:row.event_id,publishedAt:row.published_at})),appOrigin(env),url.href);
  }
  return new Response(request.method==='HEAD'?null:body,{headers});
}

export async function handleReaderUpdates(request, env, { now = epoch(), fetchImpl = fetch } = {}) {
  const url=new URL(request.url), path=url.pathname;
  const matches=path==='/api/account/email-updates'||path==='/api/account/feed-links'||path.startsWith('/api/email/')||/^\/api\/(reader\/following\.(rss|ics)|events\/[^/]+\/(feed\.rss|calendar\.ics))$/.test(path);
  if (!matches)return null;
  if(!env.DB||!appOrigin(env))return json({error:'reader_updates_unavailable'},503);
  try {
    const feed=await feedResponse(request,env,url,now);if(feed)return feed;
    if(path==='/api/email/confirm'||path==='/api/email/unsubscribe')return handleEmailLink(request,env,url,now);
    if(!['/api/account/email-updates','/api/account/feed-links'].includes(path))return json({error:'not_found'},404);
    if(!['GET','PUT','POST'].includes(request.method))return json({error:'method_not_allowed'},405);
    const {user}=await currentSession(request,env);if(!user)return json({error:'sign_in_required'},401);
    if(request.method!=='GET'&&!sameOriginMutation(request,env))return json({error:'cross_origin_request'},403);
    let row=await ensureReader(env,user,now);
    if(path==='/api/account/feed-links') {
      if(request.method==='POST')await env.DB.prepare('UPDATE reader_updates SET feed_version=?,updated_at=? WHERE user_id=?').bind(crypto.randomUUID(),now,user.id).run();
      else if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      row=await ensureReader(env,user,now);
      return json({links:await privateLinks(env,row),note:'Anyone with a private feed URL can read the followed events in it. Regenerate links to revoke old URLs.'});
    }
    if(request.method==='GET')return json({delivery:deliveryConfig(env),subscription:{status:row.status==='confirmed'&&row.email!==user.email?'needs_confirmation':row.status,alerts:!!row.alerts_enabled,weekly:!!row.weekly_enabled,email:user.email||null,confirmedAt:row.confirmed_at?new Date(row.confirmed_at*1000).toISOString():null},feeds:await privateLinks(env,row)});
    if(request.method!=='PUT')return json({error:'method_not_allowed'},405);
    const data=await bodyJson(request);
    if(typeof data.alerts!=='boolean'||typeof data.weekly!=='boolean')return json({error:'invalid_preferences'},400);
    if(!data.alerts&&!data.weekly) {
      await env.DB.batch([env.DB.prepare("UPDATE reader_updates SET status='unsubscribed',alerts_enabled=0,weekly_enabled=0,confirm_hash=NULL,updated_at=? WHERE user_id=?").bind(now,user.id),env.DB.prepare("DELETE FROM reader_email_outbox WHERE user_id=? AND state<>'sent'").bind(user.id)]);
      return json({ok:true,status:'unsubscribed'});
    }
    if(!deliveryConfig(env).enabled)return json({error:'email_delivery_not_configured',message:deliveryConfig(env).reason},503);
    if(!user.email||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(user.email))return json({error:'verified_email_required'},400);
    if(row.status==='confirmed'&&row.email===user.email) {
      await env.DB.prepare('UPDATE reader_updates SET alerts_enabled=?,weekly_enabled=?,updated_at=? WHERE user_id=?').bind(Number(data.alerts),Number(data.weekly),now,user.id).run();
      if(data.alerts&&!row.alerts_enabled)await env.DB.prepare("UPDATE reader_updates SET alert_cursor_at=?,alert_cursor_id='',last_alert_at=? WHERE user_id=?").bind(new Date(now*1000).toISOString(),now,user.id).run();
      return json({ok:true,status:'confirmed'});
    }
    if(row.confirm_sent_at&&now-row.confirm_sent_at<300)return json({error:'confirmation_rate_limited',message:'Wait five minutes before requesting another confirmation.'},429);
    const value=token(),hash=await sha256(value),link=appOrigin(env)+'/api/email/confirm?token='+value;
    await env.DB.prepare("UPDATE reader_updates SET email=?,status='pending',alerts_enabled=?,weekly_enabled=?,confirm_hash=?,confirm_expires_at=?,confirm_sent_at=?,updated_at=? WHERE user_id=?").bind(user.email,Number(data.alerts),Number(data.weekly),hash,now+86400,now,now,user.id).run();
    const id='confirm-'+hash;
    await queueMessage(env,{id,userId:user.id,kind:'confirm',now,payload:{to:user.email,subject:'Confirm your ThreadNews email updates',text:'You requested ThreadNews email updates. Open this link, then choose Confirm email updates:\n'+link+'\n\nThe link expires in 24 hours. If you did not request this, ignore the message.',html:'<p>You requested ThreadNews email updates.</p><p><a href="'+xml(link)+'">Review and confirm email updates</a></p><p>The link expires in 24 hours. Ignore this email if you did not request it.</p>',confirmationHash:hash}});
    const sent=await dispatchReaderUpdates(env,{now,fetchImpl,maxMessages:1,onlyId:id,queueDigests:false});
    return json({ok:true,status:'pending',confirmation:sent.sent===1?'sent':'queued'});
  } catch(error) {
    if(['json_required','invalid_request'].includes(error.message))return json({error:error.message},400);
    return json({error:'reader_updates_unavailable'},503);
  }
}

function weekStart(now) {const d=new Date(now*1000);d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return Math.floor(d.getTime()/1000);}
async function queueDigests(env, now) {
  const subscribers=(await env.DB.prepare("SELECT r.*,p.topics_json FROM reader_updates r JOIN users u ON u.id=r.user_id AND u.email=r.email LEFT JOIN preferences p ON p.user_id=r.user_id WHERE r.status='confirmed' AND (r.alerts_enabled=1 OR r.weekly_enabled=1) ORDER BY r.last_checked_at,r.user_id LIMIT 20").all()).results;
  let queued=0;
  for(const row of subscribers) {
    await env.DB.prepare('UPDATE reader_updates SET last_checked_at=? WHERE user_id=?').bind(now,row.user_id).run();
    const unsubscribe=await unsubscribeUrl(env,row.user_id);
    for(const kind of ['alerts','weekly']) {
      if(!row[kind==='alerts'?'alerts_enabled':'weekly_enabled'])continue;
      if((await env.DB.prepare("SELECT id FROM reader_email_outbox WHERE user_id=? AND kind=? AND state IN ('queued','leased') LIMIT 1").bind(row.user_id,kind).first()))continue;
      let items=[],watermark=now,id;
      if(kind==='alerts') {
        const since=row.alert_cursor_at||new Date((row.confirmed_at||now)*1000).toISOString();
        items=(await env.DB.prepare("SELECT c.id,c.event_id,c.first_seen_at,c.published_at,c.payload_json FROM event_coverage c JOIN reading_saves s ON s.record_id=c.event_id AND s.record_type='event' WHERE s.user_id=? AND (c.first_seen_at>? OR (c.first_seen_at=? AND c.id>?)) ORDER BY c.first_seen_at,c.id LIMIT 20").bind(row.user_id,since,since,row.alert_cursor_id||'').all()).results.map(item=>({...parse(item.payload_json),id:item.id,eventId:item.event_id,seen:item.first_seen_at}));
        if(!items.length){await env.DB.prepare('UPDATE reader_updates SET last_alert_at=? WHERE user_id=?').bind(now,row.user_id).run();continue;}
        watermark={at:items.at(-1).seen,id:items.at(-1).id};id='alerts-'+await sha256(row.user_id+':'+items.map(item=>item.id).join(','));
      } else {
        const start=weekStart(now);if(row.last_weekly_at>=start||now<start+8*3600)continue;
        const storedTopics=parse(row.topics_json,[]),topics=(Array.isArray(storedTopics)?storedTopics:[]).map(topic=>String(topic).toLowerCase());
        const news=(await env.DB.prepare('SELECT id,title,publisher,category FROM news WHERE published_at>=? ORDER BY official_count DESC,published_at DESC,id DESC LIMIT 100').bind(new Date((now-7*86400)*1000).toISOString()).all()).results;
        items=(topics.length?news.filter(item=>topics.includes(String(item.category).toLowerCase())):news).slice(0,10);
        if(!items.length){await env.DB.prepare('UPDATE reader_updates SET last_weekly_at=? WHERE user_id=?').bind(start,row.user_id).run();continue;}
        watermark=start;id='weekly-'+await sha256(row.user_id+':'+start);
      }
      const lines=items.map(item=>text(item.title)+' — '+text(item.source?.publisher||item.publisher||'Source report')+'\n'+appOrigin(env)+(kind==='alerts'?'/threads/'+encodeURIComponent(item.eventId):'/news/'+encodeURIComponent(item.id)));
      const subject=kind==='alerts'?'New reporting on your ThreadNews follows':'Your weekly ThreadNews brief';
      await queueMessage(env,{id,userId:row.user_id,kind,now,payload:emailPayload(env,row.email,subject,lines,unsubscribe,watermark)});queued++;
    }
  }
  return queued;
}

/** Explicitly opted-in recipients only. This function is safe to attach to the
 * news cron: disabled delivery does not queue messages or advance watermarks. */
export async function dispatchReaderUpdates(env,{now=epoch(),fetchImpl=fetch,maxMessages=10,onlyId=null,queueDigests:shouldQueue=true}={}) {
  const config=deliveryConfig(env);if(!config.enabled||!env.DB)return {ok:true,skipped:'email_not_configured',sent:0};
  const midnight=Math.floor(now/86400)*86400;
  const used=Number((await env.DB.prepare('SELECT attempts AS n FROM reader_email_budget WHERE day=?').bind(midnight).first())?.n||0);
  if(used>=config.dailyLimit)return {ok:true,skipped:'daily_email_budget',sent:0};
  const queued=shouldQueue?await queueDigests(env,now):0;
  const limit=Math.max(1,Math.min(10,maxMessages,config.dailyLimit-used));
  const pending=(await env.DB.prepare("SELECT id FROM reader_email_outbox WHERE ((state='queued' AND next_attempt_at<=?) OR (state='leased' AND lease_until<?))"+(onlyId?' AND id=?':'')+' ORDER BY created_at,id LIMIT ?').bind(now,now,...(onlyId?[onlyId]:[]),limit).all()).results;
  let sent=0,failed=0;
  for(const item of pending) {
    const lease=await env.DB.prepare("UPDATE reader_email_outbox SET state='leased',lease_until=?,attempts=attempts+1 WHERE id=? AND ((state='queued' AND next_attempt_at<=?) OR (state='leased' AND lease_until<?)) RETURNING *").bind(now+120,item.id,now,now).first();if(!lease)continue;
    const row=await env.DB.prepare('SELECT r.*,u.email AS current_email FROM reader_updates r JOIN users u ON u.id=r.user_id WHERE r.user_id=?').bind(lease.user_id).first(),payload=parse(lease.payload_json);
    const valid=lease.kind==='confirm'?row?.status==='pending'&&row.confirm_hash===payload.confirmationHash:row?.status==='confirmed'&&row[lease.kind==='alerts'?'alerts_enabled':'weekly_enabled'];
    if(!valid||row.email!==payload.to||row.email!==row.current_email){await env.DB.prepare('DELETE FROM reader_email_outbox WHERE id=?').bind(item.id).run();continue;}
    if(now-lease.created_at>23*3600){await env.DB.prepare("UPDATE reader_email_outbox SET state='failed',payload_json='{}',error_code='retry_window_expired',lease_until=0 WHERE id=?").bind(item.id).run();continue;}
    const quota=await env.DB.prepare('INSERT INTO reader_email_budget (day,attempts) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts<? RETURNING attempts').bind(midnight,config.dailyLimit).first();
    if(!quota){await env.DB.prepare("UPDATE reader_email_outbox SET state='queued',lease_until=0,next_attempt_at=? WHERE id=?").bind(midnight+86400,item.id).run();break;}
    try {
      const headers={authorization:'Bearer '+env.RESEND_API_KEY,'content-type':'application/json','Idempotency-Key':item.id};
      const emailHeaders=payload.unsubscribe?{'List-Unsubscribe':'<'+payload.unsubscribe+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}:undefined;
      const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers,body:JSON.stringify({from:'ThreadNews <'+config.sender+'>',to:[payload.to],subject:payload.subject,text:payload.text,html:payload.html,...(emailHeaders?{headers:emailHeaders}:{})})});
      if(!response.ok)throw new Error('email_provider_http_'+response.status);
      const result=JSON.parse(await readLimited(response,16384));if(typeof result.id!=='string'||result.id.length>128)throw new Error('email_provider_invalid_response');
      const statements=[env.DB.prepare("UPDATE reader_email_outbox SET state='sent',sent_at=?,lease_until=0,provider_id=?,payload_json='{}',error_code=NULL WHERE id=?").bind(now,result.id,item.id)];
      if(lease.kind==='alerts')statements.push(env.DB.prepare('UPDATE reader_updates SET last_alert_at=?,alert_cursor_at=?,alert_cursor_id=? WHERE user_id=?').bind(now,payload.watermark.at,payload.watermark.id,lease.user_id));
      if(lease.kind==='weekly')statements.push(env.DB.prepare('UPDATE reader_updates SET last_weekly_at=? WHERE user_id=?').bind(payload.watermark,lease.user_id));
      await env.DB.batch(statements);sent++;
    } catch(error) {
      const code=/^email_provider_(http_\d{3}|invalid_response)$/.test(error.message)?error.message:'email_delivery_failed';
      await env.DB.prepare('UPDATE reader_email_outbox SET state=?,lease_until=0,next_attempt_at=?,error_code=? WHERE id=?').bind(lease.attempts>=5?'failed':'queued',now+Math.min(3600,60*2**lease.attempts),code,item.id).run();failed++;
    }
  }
  await env.DB.prepare("DELETE FROM reader_email_outbox WHERE state IN ('sent','failed') AND created_at<?").bind(now-7*86400).run();
  await env.DB.prepare('DELETE FROM reader_email_budget WHERE day<?').bind(midnight-8*86400).run();
  return {ok:failed===0,queued,sent,failed};
}

export async function readerUpdatesExport(env,userId) {
  const row=await env.DB.prepare('SELECT status,alerts_enabled,weekly_enabled,confirmed_at,created_at,updated_at FROM reader_updates WHERE user_id=?').bind(userId).first();
  if(!row)return null;
  const deliveries=(await env.DB.prepare('SELECT kind,state,created_at,sent_at,attempts,error_code FROM reader_email_outbox WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100').bind(userId).all()).results;
  return {status:row.status,eventAlerts:!!row.alerts_enabled,weeklyBrief:!!row.weekly_enabled,confirmedAt:row.confirmed_at?new Date(row.confirmed_at*1000).toISOString():null,createdAt:new Date(row.created_at*1000).toISOString(),updatedAt:new Date(row.updated_at*1000).toISOString(),deliveryHistory:deliveries.map(item=>({kind:item.kind,state:item.state,createdAt:new Date(item.created_at*1000).toISOString(),sentAt:item.sent_at?new Date(item.sent_at*1000).toISOString():null,attempts:item.attempts,errorCode:item.error_code||null}))};
}
