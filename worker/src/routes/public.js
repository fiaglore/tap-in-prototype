// Public sales page: anyone can see an event's ticket types and prices; buying needs a signed-in
// session so the ticket can be attached to someone. Free ticket types are claimed straight to the buyer's
// account. Paid ones are refused (402) until a payment provider confirms payment; TICKET_CHECKOUT=demo
// (development and tests only) lets them through without taking money.

import { HttpError, newId, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { CATEGORIES, MAX_INVITES_PER_EVENT, mintInvites } from './events.js';

const MAX_QTY = 8;

// 'upcoming' before sales open, 'closed' after they end, otherwise 'open'.
export function salesState(ev, now) {
  if (ev.sales_start && now < ev.sales_start) return 'upcoming';
  if (ev.sales_end && now >= ev.sales_end) return 'closed';
  return 'open';
}

async function saleEvent(env, id) {
  const ev = await env.DB.prepare('SELECT id, name, prefix, kind, venue, city, starts_at, sales_start, sales_end, require_photo FROM events WHERE id = ?1')
    .bind(String(id).slice(0, 40))
    .first();
  if (!ev) throw new HttpError(404, 'not_found', 'Event not found.');
  return ev;
}

// GET /api/public/events/:id
export async function getEvent({ env, params }) {
  const ev = await saleEvent(env, params.id);
  const tiers = (
    await env.DB.prepare(
      `SELECT id, name, price_kobo, capacity,
        (SELECT COUNT(*) FROM invites i WHERE i.tier_id = tiers.id AND i.status != 'revoked') AS issued
       FROM tiers WHERE event_id = ?1 ORDER BY sort, name`
    )
      .bind(ev.id)
      .all()
  ).results;
  return json({
    event: { id: ev.id, name: ev.name, venue: ev.venue, city: ev.city, starts_at: ev.starts_at, require_photo: !!ev.require_photo, sales: salesState(ev, nowSec()), sales_start: ev.sales_start, sales_end: ev.sales_end },
    // Exact counts are the organiser's business; buyers only learn how many are left once it is few.
    tiers: tiers.map((t) => {
      const left = t.capacity === null ? null : Math.max(0, t.capacity - t.issued);
      return { id: t.id, name: t.name, price_kobo: t.price_kobo, sold_out: left === 0, left: left !== null && left <= 20 ? left : null };
    })
  });
}

// POST /api/public/events/:id/buy  { tier_id, qty? }
// Mints `qty` invites for the tier, keeps one for the buyer, and hands back the rest as plain
// codes so they can be forwarded to whoever else is coming on the same purchase.
export async function buy({ request, env, user, params }) {
  const ev = await saleEvent(env, params.id);
  const b = await readJson(request);
  if (ev.require_photo) {
    const ph = await env.DB.prepare('SELECT 1 AS x FROM user_photos WHERE user_id = ?1').bind(user.id).first();
    if (!ph) throw new HttpError(428, 'photo_required', 'This event needs a photo of you so door staff can match it to your face. Add one to continue.');
  }
  const state = salesState(ev, nowSec());
  if (state === 'upcoming') throw new HttpError(409, 'sales_not_open', 'Ticket sales have not opened yet.');
  if (state === 'closed') throw new HttpError(409, 'sales_closed', 'Ticket sales for this event have closed.');
  const tier = await env.DB.prepare('SELECT id, name, capacity, price_kobo FROM tiers WHERE id = ?1 AND event_id = ?2').bind(b.tier_id, ev.id).first();
  if (!tier) throw new HttpError(400, 'invalid_tier', 'Choose a ticket type.');
  // A paid ticket is never issued without a verified payment. Until a payment provider is connected (Phase 1),
  // only free ticket types can be taken here. TICKET_CHECKOUT=demo is for local development and tests only.
  if (tier.price_kobo > 0 && String(env.TICKET_CHECKOUT || 'off').toLowerCase() !== 'demo') {
    throw new HttpError(402, 'payment_not_connected', 'Online payment is not open yet, so this paid ticket cannot be bought here. Ask the organiser for an invite code.');
  }

  const qty = b.qty === undefined ? 1 : Number.parseInt(b.qty, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    throw new HttpError(400, 'invalid_qty', `Buy between 1 and ${MAX_QTY} tickets at a time.`);
  }

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE event_id = ?1').bind(ev.id).first();
  if (total.n + qty > MAX_INVITES_PER_EVENT) {
    throw new HttpError(400, 'sold_out', 'This event has sold all the tickets it can issue.');
  }

  const { ids, codes } = await mintInvites(env, ev, tier, qty, { label: 'Online purchase (demo)' });

  const now = nowSec();
  const passId = newId(10);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO passes (id, event_id, tier_id, user_id, invite_id, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)`
    ).bind(passId, ev.id, tier.id, user.id, ids[0], now),
    env.DB.prepare(`UPDATE invites SET status = 'claimed', claimed_by = ?1, claimed_at = ?2 WHERE id = ?3`).bind(user.id, now, ids[0])
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(500, 'server_error', 'Could not create your ticket. Try again.');

  return json({ tier: tier.name, extra_codes: codes.slice(1) }, 201);
}

// GET /api/public/events  -> upcoming events the organiser chose to list (the public "Play" page)
// An event is upcoming until about 12 hours after it starts; undated ("date to be announced") events stay listed.
// Only what a visitor needs to choose an event: no codes, keys, counts or organiser details.
// Filters (all optional, combinable): q, country (NG), region, city, category, from / to (YYYY-MM-DD, Lagos dates),
// min_price / max_price (naira, against the cheapest ticket), free=1, available=1 (hide sold out).
export async function listUpcoming({ env, url }) {
  const now = nowSec();
  const qs = url ? url.searchParams : new URLSearchParams();
  const text = (k, n = 60) => { const v = (qs.get(k) || '').trim().slice(0, n); return v || null; };
  const day = (k, endOfDay) => {
    const v = qs.get(k);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return null;
    const t = Date.parse(v + 'T00:00:00+01:00'); // Lagos time
    return Number.isFinite(t) ? Math.floor(t / 1000) + (endOfDay ? 86400 : 0) : null;
  };
  const naira = (k) => { const n = Number.parseFloat(qs.get(k)); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
  const country = (text('country', 2) || '').toUpperCase() || null;
  const like = (v) => (v ? '%' + v.replace(/[\\%_]/g, '\\$&').toLowerCase() + '%' : null);
  const category = CATEGORIES.includes(qs.get('category')) ? qs.get('category') : null;
  const base = `e.kind = 'event' AND e.listed = 1 AND (e.starts_at IS NULL OR e.starts_at >= ?1)`;

  const rows = (
    await env.DB.prepare(
      `SELECT e.id, e.name, e.venue, e.city, e.starts_at, e.sales_start, e.sales_end, e.category, e.country, e.region,
        (SELECT MIN(t.price_kobo) FROM tiers t WHERE t.event_id = e.id) AS from_kobo,
        (SELECT COUNT(*) FROM tiers t WHERE t.event_id = e.id) AS tier_count,
        (SELECT COUNT(*) FROM tiers t WHERE t.event_id = e.id AND t.capacity IS NOT NULL
           AND (SELECT COUNT(*) FROM invites i WHERE i.tier_id = t.id AND i.status != 'revoked') >= t.capacity) AS full_tiers
       FROM events e
       WHERE ${base}
         AND (?2 IS NULL OR e.country = ?2)
         AND (?3 IS NULL OR lower(e.region) = lower(?3))
         AND (?4 IS NULL OR lower(e.city) = lower(?4))
         AND (?5 IS NULL OR e.category = ?5)
         AND (?6 IS NULL OR e.starts_at >= ?6)
         AND (?7 IS NULL OR e.starts_at < ?7)
         AND (?8 IS NULL OR lower(e.name || ' ' || COALESCE(e.venue, '') || ' ' || COALESCE(e.city, '')) LIKE ?8 ESCAPE '\\')
       ORDER BY e.starts_at IS NULL, e.starts_at ASC, e.created_at DESC
       LIMIT 200`
    )
      .bind(now - 12 * 3600, country, text('region'), text('city'), category, day('from', false), day('to', true), like(text('q', 80)))
      .all()
  ).results;

  const min = naira('min_price');
  const max = naira('max_price');
  const free = qs.get('free') === '1';
  const avail = qs.get('available') === '1';
  const events = rows
    .map((e) => ({
      id: e.id, name: e.name, venue: e.venue, city: e.city, region: e.region, country: e.country, category: e.category, starts_at: e.starts_at,
      sales: salesState(e, now), sold_out: e.tier_count > 0 && e.full_tiers === e.tier_count, from_kobo: e.from_kobo
    }))
    .filter((e) => (min === null || (e.from_kobo ?? 0) >= min) && (max === null || (e.from_kobo ?? 0) <= max) && (!free || e.from_kobo === 0) && (!avail || !e.sold_out))
    .slice(0, 60);

  // Choices for the filter boxes, from everything currently listed.
  const f = (await env.DB.prepare(`SELECT e.country, e.region, e.city, e.category FROM events e WHERE ${base} LIMIT 500`).bind(now - 12 * 3600).all()).results;
  const uniq = (k) => [...new Set(f.map((x) => x[k]).filter(Boolean))].sort();
  return json({ events, facets: { countries: uniq('country'), regions: uniq('region'), cities: uniq('city'), categories: uniq('category') } });
}

// GET /e/?id=…  The sales page itself is static, but link previews (WhatsApp, X, iMessage) only read the
// HTML, so the Worker writes the event's name, place and date into the title and Open Graph tags on the way out.
const lagosDate = (sec) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    .format(new Date(sec * 1000));

export async function salePageHtml(request, env) {
  const res = await env.ASSETS.fetch(request);
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !res.ok || typeof HTMLRewriter === 'undefined' || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let ev = null;
  try {
    ev = await env.DB.prepare('SELECT name, venue, city, starts_at, kind FROM events WHERE id = ?1').bind(String(id).slice(0, 40)).first();
  } catch {
    return res;
  }
  if (!ev || ev.kind === 'workplace') return res;
  const title = ev.name + ' · Tickets on Tap In';
  const desc = [ev.venue, ev.city, ev.starts_at && lagosDate(ev.starts_at)].filter(Boolean).join(' · ') || 'Tickets for this event, sold on Tap In.';
  const content = (v) => ({ element(el) { el.setAttribute('content', v); } });
  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', content(desc))
    .on('meta[property="og:title"]', content(title))
    .on('meta[property="og:description"]', content(desc))
    .on('meta[property="og:url"]', content(new URL('/e/?id=' + encodeURIComponent(id), request.url).href))
    .on('meta[property="og:image"]', content(new URL('/og.png', request.url).href))
    .transform(res);
}
