import { currentSession, sameOriginMutation } from './auth.js';
import { buildContentQuery } from './content.js';
import { readLimited } from './feed.js';
import { hasPaidAccess } from './paypal.js';

const json = (body, status = 200) => Response.json(body, { status, headers: {
  'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'
} });

export async function readWatchlist(env, userId, now) {
  const query = buildContentQuery(new URLSearchParams(), env, { now, cursor: false });
  const through = now.toISOString();
  const [followed, changes] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS total FROM reading_saves WHERE user_id=? AND record_type='event'").bind(userId),
    env.DB.prepare(`WITH public_news AS (
      SELECT id,event_id,title,publisher,published_at,ingested_at FROM news${query.baseWhere}
    ), ranked AS (
      SELECT n.id,n.event_id,n.title,n.publisher,n.published_at,n.ingested_at,e.title AS event_title,
        ROW_NUMBER() OVER (PARTITION BY n.event_id ORDER BY n.ingested_at DESC,n.id DESC) AS item_rank,
        COUNT(*) OVER (PARTITION BY n.event_id) AS total
      FROM public_news n JOIN reading_saves s ON s.record_id=n.event_id AND s.record_type='event' AND s.user_id=?
      JOIN event_payloads e ON e.id=n.event_id
      LEFT JOIN watchlist_checkpoints c ON c.user_id=s.user_id AND c.event_id=s.record_id
      WHERE n.ingested_at>COALESCE(c.checked_through,?) AND n.ingested_at<=?
    ) SELECT * FROM ranked WHERE item_rank<=3
      ORDER BY item_rank,ingested_at DESC,id DESC LIMIT 48`).bind(...query.baseArgs, userId, query.cutoff, through)
  ]);
  const events = new Map();
  for (const row of changes.results || []) {
    if (!events.has(row.event_id)) events.set(row.event_id, { id: row.event_id, title: row.event_title, unread: row.total, reports: [] });
    events.get(row.event_id).reports.push({ id: row.id, title: row.title, publisher: row.publisher, publishedAt: row.published_at });
  }
  return { through, since: query.cutoff, followed: followed.results?.[0]?.total || 0, events: [...events.values()] };
}

export async function handleWatchlist(request, env) {
  const path = new URL(request.url).pathname;
  const method = path === '/api/watchlist' ? 'GET' : 'POST';
  if (request.method !== method) return json({ error: 'method_not_allowed' }, 405);
  if (method === 'POST' && !sameOriginMutation(request, env)) return json({ error: 'cross_origin_request' }, 403);
  if (!env.DB || env.NEWS_STORAGE === 'static') return json({ error: 'unavailable' }, 503);
  const { user } = await currentSession(request, env);
  if (!user) return json({ error: 'sign_in_required' }, 401);
  const now = new Date();
  if (!await hasPaidAccess(env, user.id, Math.floor(+now / 1000), { failOpen:false })) return json({ error: 'supporter_required' }, 403);
  if (method === 'GET') return json(await readWatchlist(env, user.id, now));

  let input;
  try { input = JSON.parse(await readLimited(request, 1024)); } catch { return json({ error: 'invalid_checkpoint' }, 400); }
  const { eventId, through } = input ?? {};
  const time = typeof through === 'string' ? Date.parse(through) : NaN;
  if (typeof eventId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(eventId)
    || !Number.isFinite(time) || time > +now || time < +now - 86400000 || new Date(time).toISOString() !== through) {
    return json({ error: 'invalid_checkpoint' }, 400);
  }
  await env.DB.prepare(`INSERT INTO watchlist_checkpoints(user_id,event_id,checked_through)
    SELECT user_id,record_id,? FROM reading_saves WHERE user_id=? AND record_type='event' AND record_id=?
    ON CONFLICT(user_id,event_id) DO UPDATE SET checked_through=excluded.checked_through
    WHERE watchlist_checkpoints.checked_through<excluded.checked_through`).bind(through, user.id, eventId).run();
  return json({ status: 'ok' });
}
