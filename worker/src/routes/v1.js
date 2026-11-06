// The public API, version 1. Authenticated with an API key (Authorization: Bearer tk_...). Sandbox keys see only sandbox
// events and live keys only live ones, so testing can never touch real events. Each route needs one permission (scope).
import { HttpError } from '../lib/util.js';
import { json } from '../lib/http.js';
import { needScope } from './apikeys.js';
import * as events from './events.js';
import * as orders from './orders.js';

// The event behind :id must exist, belong to the key's owner and be in the key's mode, else "not found".
async function inMode(env, key, user, id) {
  const ev = await events.ownedEvent(env, user, id);
  const row = await env.DB.prepare('SELECT sandbox FROM events WHERE id = ?1').bind(ev.id).first();
  if (!!row.sandbox !== key.sandbox) throw new HttpError(404, 'not_found', 'Event not found.');
  return ev;
}
const guard = (scope, fn, { needsEvent = true } = {}) => async (ctx) => {
  needScope(ctx.key, scope);
  if (needsEvent) await inMode(ctx.env, ctx.key, ctx.user, ctx.params.id);
  return fn(ctx);
};

export const ping = ({ key }) => json({ ok: true, mode: key.mode, scopes: key.scopes, version: 'v1' });

export const listEvents = async (ctx) => {
  needScope(ctx.key, 'events:read');
  const res = await events.listEvents({ ...ctx, url: new URL(ctx.request.url) });
  const body = await res.json();
  const ids = (await ctx.env.DB.prepare('SELECT id FROM events WHERE owner_id = ?1 AND sandbox = ?2').bind(ctx.user.id, ctx.key.sandbox ? 1 : 0).all()).results.map((r) => r.id);
  return json({ events: body.events.filter((e) => ids.includes(e.id)) });
};

export const createEvent = async (ctx) => {
  needScope(ctx.key, 'events:write');
  const res = await events.createEvent(ctx);
  const body = await res.clone().json();
  if (ctx.key.sandbox) await ctx.env.DB.prepare('UPDATE events SET sandbox = 1, listed = 0 WHERE id = ?1').bind(body.event.id).run();
  return res;
};

export const getEvent = guard('events:read', events.getEvent);
export const attendees = guard('attendance:read', events.listAttendees);
export const scans = guard('attendance:read', events.listScans);
export const eventOrders = guard('payments:read', orders.listOrders);
export const finance = guard('payments:read', orders.finance);

// GET /api/v1/orders/:id  -> payment status of one order on one of the owner's events
export const getOrder = async (ctx) => {
  needScope(ctx.key, 'payments:read');
  const o = await ctx.env.DB.prepare(
    `SELECT o.id, o.event_id, o.tier_id, o.qty, o.status, o.currency, o.total_kobo, o.discount_kobo, o.refunded_kobo, o.refunded_qty, o.dispute_status, o.created_at, o.paid_at
     FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = ?1 AND e.owner_id = ?2 AND e.sandbox = ?3`
  ).bind(String(ctx.params.id).slice(0, 40), ctx.user.id, ctx.key.sandbox ? 1 : 0).first();
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  return json({ order: o });
};
