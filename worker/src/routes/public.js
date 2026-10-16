// Public sales page: anyone can see an event's ticket types and prices; buying needs a signed-in
// session so the ticket can be attached to someone. This is a demo checkout — no real payment is
// taken, it just mints an invite and claims it straight to the buyer's account.

import { HttpError, newId, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { MAX_INVITES_PER_EVENT, mintInvites } from './events.js';

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
  const tier = await env.DB.prepare('SELECT id, name, capacity FROM tiers WHERE id = ?1 AND event_id = ?2').bind(b.tier_id, ev.id).first();
  if (!tier) throw new HttpError(400, 'invalid_tier', 'Choose a ticket type.');

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
export async function listUpcoming({ env }) {
  const now = nowSec();
  const rows = (
    await env.DB.prepare(
      `SELECT e.id, e.name, e.venue, e.city, e.starts_at, e.sales_start, e.sales_end,
        (SELECT MIN(t.price_kobo) FROM tiers t WHERE t.event_id = e.id) AS from_kobo,
        (SELECT COUNT(*) FROM tiers t WHERE t.event_id = e.id) AS tier_count,
        (SELECT COUNT(*) FROM tiers t WHERE t.event_id = e.id AND t.capacity IS NOT NULL
           AND (SELECT COUNT(*) FROM invites i WHERE i.tier_id = t.id AND i.status != 'revoked') >= t.capacity) AS full_tiers
       FROM events e
       WHERE e.kind = 'event' AND e.listed = 1 AND (e.starts_at IS NULL OR e.starts_at >= ?1)
       ORDER BY e.starts_at IS NULL, e.starts_at ASC, e.created_at DESC
       LIMIT 60`
    )
      .bind(now - 12 * 3600)
      .all()
  ).results;
  return json({
    events: rows.map((e) => ({
      id: e.id,
      name: e.name,
      venue: e.venue,
      city: e.city,
      starts_at: e.starts_at,
      sales: salesState(e, now),
      sold_out: e.tier_count > 0 && e.full_tiers === e.tier_count,
      from_kobo: e.from_kobo
    }))
  });
}
