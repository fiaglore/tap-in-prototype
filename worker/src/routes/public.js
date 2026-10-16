// Public sales page: anyone can see an event's ticket types and prices; buying needs a signed-in
// session so the ticket can be attached to someone. This is a demo checkout — no real payment is
// taken, it just mints an invite and claims it straight to the buyer's account.

import { HttpError, newId, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { MAX_INVITES_PER_EVENT, mintInvites } from './events.js';

const MAX_QTY = 8;

async function saleEvent(env, id) {
  const ev = await env.DB.prepare('SELECT id, name, prefix, venue, city, starts_at FROM events WHERE id = ?1')
    .bind(String(id).slice(0, 40))
    .first();
  if (!ev) throw new HttpError(404, 'not_found', 'Event not found.');
  return ev;
}

// GET /api/public/events/:id
export async function getEvent({ env, params }) {
  const ev = await saleEvent(env, params.id);
  const tiers = (
    await env.DB.prepare('SELECT id, name, price_kobo FROM tiers WHERE event_id = ?1 ORDER BY sort, name').bind(ev.id).all()
  ).results;
  return json({
    event: { id: ev.id, name: ev.name, venue: ev.venue, city: ev.city, starts_at: ev.starts_at },
    tiers
  });
}

// POST /api/public/events/:id/buy  { tier_id, qty? }
// Mints `qty` invites for the tier, keeps one for the buyer, and hands back the rest as plain
// codes so they can be forwarded to whoever else is coming on the same purchase.
export async function buy({ request, env, user, params }) {
  const ev = await saleEvent(env, params.id);
  const b = await readJson(request);
  const tier = await env.DB.prepare('SELECT id, name FROM tiers WHERE id = ?1 AND event_id = ?2').bind(b.tier_id, ev.id).first();
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
