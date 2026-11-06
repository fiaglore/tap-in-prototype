// Paid ticket orders: checkout, the payment webhook, order status, refunds and event finance.
// Rule: a paid ticket exists only after a verified provider webhook marks its order paid. Never from a redirect or screenshot.
import { HttpError, newId, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { checkoutMode, getProvider } from '../lib/payments/provider.js';
import { quote } from './discounts.js';
import { mintInvites, ownedEvent } from './events.js';
import { salesState } from './public.js';
import * as limits from '../lib/limits.js';
import { organiserMfaMandatory } from '../lib/mfa.js';
import { emit, flush as flushWebhooks } from '../lib/outbound.js';
import { requireSecondStep } from './mfa.js';

const MAX_QTY = 8;
const HOLD_SEC = 30 * 60; // a pending order holds its tickets for 30 minutes
const LOCK_SEC = 60;
const PAID = ['paid', 'fulfilled', 'refunding', 'refund_due'];

const publicOrder = (o) => ({
  id: o.id, event_id: o.event_id, tier_id: o.tier_id, qty: o.qty, status: o.status, currency: o.currency,
  unit_kobo: o.unit_kobo, discount_kobo: o.discount_kobo, refunded_kobo: o.refunded_kobo, refunded_qty: o.refunded_qty, dispute_status: o.dispute_status, subtotal_kobo: o.subtotal_kobo, fee_kobo: o.buyer_fee_kobo, total_kobo: o.total_kobo,
  created_at: o.created_at, expires_at: o.expires_at, paid_at: o.paid_at
});

// POST /api/public/events/:id/checkout { tier_id, qty? } -> the buyer is sent to checkout_url to pay.
export async function checkout({ request, env, user, params }) {
  if (checkoutMode(env) === 'off' || checkoutMode(env) === 'demo') throw new HttpError(503, 'payment_not_connected', 'Online payment is not open yet.');
  const provider = getProvider(env);
  const b = await readJson(request);
  const ev = await env.DB.prepare('SELECT id, name, prefix, kind, starts_at, sales_start, sales_end, require_photo, fee_mode FROM events WHERE id = ?1 AND kind = \'event\'')
    .bind(String(params.id).slice(0, 40)).first();
  if (!ev) throw new HttpError(404, 'not_found', 'Event not found.');
  const state = salesState(ev, nowSec());
  if (state === 'upcoming') throw new HttpError(409, 'sales_not_open', 'Ticket sales have not opened yet.');
  if (state === 'closed') throw new HttpError(409, 'sales_closed', 'Ticket sales for this event have closed.');
  if (ev.require_photo) {
    const ph = await env.DB.prepare('SELECT 1 AS x FROM user_photos WHERE user_id = ?1').bind(user.id).first();
    if (!ph) throw new HttpError(428, 'photo_required', 'This event needs a photo of you so door staff can match it to your face. Add one to continue.');
  }
  const tier = await env.DB.prepare('SELECT id, name, capacity, price_kobo FROM tiers WHERE id = ?1 AND event_id = ?2').bind(b.tier_id, ev.id).first();
  if (!tier) throw new HttpError(400, 'invalid_tier', 'Choose a ticket type.');
  if (!(tier.price_kobo > 0)) throw new HttpError(400, 'free_ticket', 'This ticket is free. Use the free ticket button.');
  const qty = b.qty === undefined ? 1 : Number.parseInt(b.qty, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, 'invalid_qty', `Buy between 1 and ${MAX_QTY} tickets at a time.`);
  if (await limits.isFull(env.DB, 'checkout:' + user.id, 10, 3600)) throw new HttpError(429, 'rate_limited', 'Too many checkouts. Try again later.');

  const price = await quote(env, { event: ev, tier, qty, codeText: b.discount_code });
  const discId = price.disc ? price.disc.id : null;
  const now = nowSec();
  const id = newId(12);
  const ref = 'TI-' + newId(16);

  // Stock: issued tickets plus other buyers' unexpired pending orders must leave room. Re-checked at fulfilment too.
  const ins = await env.DB.prepare(
    `INSERT INTO orders (id, event_id, tier_id, user_id, qty, unit_kobo, subtotal_kobo, commission_kobo, fee_mode, buyer_fee_kobo, total_kobo, status, provider, provider_ref, created_at, expires_at, discount_code_id, discount_kobo)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13, ?14, ?15, ?17, ?18
     WHERE (?16 IS NULL OR (SELECT COUNT(*) FROM invites WHERE tier_id = ?3 AND status != 'revoked')
       + (SELECT COALESCE(SUM(qty), 0) FROM orders WHERE tier_id = ?3 AND status = 'pending' AND expires_at > ?14) + ?5 <= ?16)
       AND (?17 IS NULL OR (SELECT max_uses FROM discount_codes WHERE id = ?17) IS NULL OR (SELECT COUNT(*) FROM orders o WHERE o.discount_code_id = ?17 AND (o.status IN ('paid','fulfilled','refund_due','refunding') OR (o.status = 'pending' AND o.expires_at > ?14))) < (SELECT max_uses FROM discount_codes WHERE id = ?17))`
  ).bind(id, ev.id, tier.id, user.id, qty, tier.price_kobo, price.subtotal_kobo, price.commission_kobo, ev.fee_mode, price.buyer_fee_kobo, price.total_kobo,
    provider.name, ref, now, now + HOLD_SEC, tier.capacity ?? null, discId, price.discountKobo).run();
  if (ins.meta.changes !== 1) throw new HttpError(409, 'sold_out', `Not enough "${tier.name}" tickets left, or that discount code was just used up.`);
  await limits.record(env.DB, 'checkout:' + user.id);

  const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(id).first();
  let init;
  try {
    init = await provider.initialize(env, { order, email: user.email || null, callbackUrl: new URL(`/e/?id=${encodeURIComponent(ev.id)}&order=${encodeURIComponent(order.id)}`, request.url).toString() });
  } catch (e) {
    await env.DB.prepare(`UPDATE orders SET status = 'failed' WHERE id = ?1 AND status = 'pending'`).bind(id).run();
    throw e;
  }
  return json({ order: publicOrder(order), checkout_url: init.checkout_url }, 201);
}

// Issues the tickets for a paid order. Safe to run any number of times and from any path: a lock stops two runs overlapping,
// and the unique (order_id, order_seq) index stops a ticket being issued twice.
export async function ensureTickets(env, orderId) {
  const now = nowSec();
  const lock = await env.DB.prepare(
    `UPDATE orders SET fulfil_lock = ?2 WHERE id = ?1 AND status = 'paid' AND (fulfil_lock IS NULL OR fulfil_lock < ?3)`
  ).bind(orderId, now, now - LOCK_SEC).run();
  if (lock.meta.changes !== 1) return;
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(orderId).first();
  const have = (await env.DB.prepare('SELECT COUNT(*) AS n FROM passes WHERE order_id = ?1').bind(orderId).first()).n;
  const need = order.qty - have;
  if (need > 0) {
    const ev = await env.DB.prepare('SELECT id, prefix, starts_at FROM events WHERE id = ?1').bind(order.event_id).first();
    const tier = await env.DB.prepare('SELECT id, name, capacity FROM tiers WHERE id = ?1').bind(order.tier_id).first();
    let minted;
    try {
      // The order's own pending hold has already turned into a paid order; capacity is counted on invites, so it is enforced here.
      minted = await mintInvites(env, ev, tier, need, { label: 'Order ' + order.id });
    } catch (e) {
      if (e instanceof HttpError && e.code === 'sold_out') {
        await env.DB.prepare(`UPDATE orders SET status = 'refund_due', fulfil_lock = NULL WHERE id = ?1 AND status = 'paid'`).bind(orderId).run();
        return;
      }
      await env.DB.prepare('UPDATE orders SET fulfil_lock = NULL WHERE id = ?1').bind(orderId).run();
      throw e;
    }
    const stmts = [];
    minted.ids.forEach((inviteId, i) => {
      const seq = have + i + 1;
      stmts.push(env.DB.prepare(`INSERT INTO passes (id, event_id, tier_id, user_id, invite_id, status, created_at, order_id, order_seq) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8)`)
        .bind(newId(10), order.event_id, order.tier_id, order.user_id, inviteId, now, order.id, seq));
      stmts.push(env.DB.prepare(`UPDATE invites SET status = 'claimed', claimed_by = ?1, claimed_at = ?2, order_id = ?3 WHERE id = ?4`).bind(order.user_id, now, order.id, inviteId));
    });
    await env.DB.batch(stmts);
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET status = 'fulfilled', fulfil_lock = NULL WHERE id = ?1 AND status = 'paid'`).bind(orderId)
  ]);
}

async function writeSaleLedger(env, order, processorFee) {
  const now = nowSec();
  const payable = order.fee_mode === 'pass' ? order.subtotal_kobo : Math.max(0, order.subtotal_kobo - order.commission_kobo);
  const rows = [['gross', order.total_kobo], ['organiser_payable', payable], ['commission', order.commission_kobo], ['processor_fee', processorFee || 0]];
  await env.DB.batch(rows.map(([kind, amt]) =>
    env.DB.prepare(`INSERT INTO order_ledger (id, order_id, event_id, kind, amount_kobo, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'sale', ?6)`)
      .bind(newId(12), order.id, order.event_id, kind, amt, now)));
}

// POST /api/webhooks/payments/:provider  (no cookie; authenticated by the provider's signature over the raw body)
export async function webhook({ request, env, params, ctx }) {
  const provider = getProvider(env, String(params.provider).toLowerCase());
  const raw = await request.text();
  if (raw.length > 100000) throw new HttpError(413, 'too_large', 'Too large.');
  const evt = await provider.parseWebhook(env, raw, request.headers);
  if (!evt.event_key) throw new HttpError(400, 'bad_event', 'Missing event id.');

  const seen = await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_events (id, provider, event_key, type, provider_ref, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(newId(12), provider.name, evt.event_key, evt.type, evt.provider_ref || null, nowSec()).run();
  const outcome = async (o) => { await env.DB.prepare('UPDATE payment_events SET outcome = ?3 WHERE provider = ?1 AND event_key = ?2').bind(provider.name, evt.event_key, o).run(); return json({ ok: true, outcome: o }); };
  if (seen.meta.changes !== 1) return json({ ok: true, outcome: 'duplicate' });

  const order = evt.provider_ref ? await env.DB.prepare('SELECT * FROM orders WHERE provider_ref = ?1 AND provider = ?2').bind(evt.provider_ref, provider.name).first() : null;
  if (!order) return outcome('unknown_order');

  if (evt.type === 'charge.failed') {
    await env.DB.prepare(`UPDATE orders SET status = 'failed' WHERE id = ?1 AND status = 'pending'`).bind(order.id).run();
    return outcome('failed');
  }
  if (evt.type === 'dispute.opened') {
    await env.DB.prepare(`UPDATE orders SET dispute_status = 'open' WHERE id = ?1 AND dispute_status IS NULL AND status NOT IN ('pending', 'failed', 'expired')`).bind(order.id).run();
    await notify(env, ctx, order, 'order.disputed');
    return outcome('dispute_opened');
  }
  if (evt.type === 'dispute.won') {
    await env.DB.prepare(`UPDATE orders SET dispute_status = 'won' WHERE id = ?1 AND dispute_status = 'open'`).bind(order.id).run();
    await notify(env, ctx, order, 'order.disputed');
    return outcome('dispute_won');
  }
  if (evt.type === 'dispute.lost') {
    // The bank has taken the money back. Cancel what is left of the order and reverse the books; the provider is not asked to refund.
    const cur = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(order.id).first();
    if (cur.status === 'refunded' && cur.dispute_status === 'lost') return outcome('already_lost');
    const lock = await env.DB.prepare(`UPDATE orders SET dispute_status = 'lost', status = 'refunded', refunded_at = ?2 WHERE id = ?1 AND status IN ('fulfilled', 'paid', 'refund_due', 'refunding')`).bind(order.id, nowSec()).run();
    if (lock.meta.changes !== 1) {
      await env.DB.prepare(`UPDATE orders SET dispute_status = 'lost' WHERE id = ?1`).bind(order.id).run();
    } else {
      const remainingAmt = cur.total_kobo - cur.refunded_kobo;
      const rows = await reversalRows(env, cur, remainingAmt, true);
      await env.DB.batch([
        env.DB.prepare(`UPDATE orders SET refunded_kobo = total_kobo, refunded_qty = qty WHERE id = ?1`).bind(order.id),
        env.DB.prepare(`UPDATE invites SET status = 'revoked' WHERE id IN (SELECT invite_id FROM passes WHERE order_id = ?1)`).bind(order.id),
        env.DB.prepare(`UPDATE passes SET status = 'revoked' WHERE order_id = ?1`).bind(order.id),
        ...ledgerStmts(env, cur, rows, 'refund', nowSec())
      ]);
    }
    await notify(env, ctx, order, 'order.disputed');
    return outcome('dispute_lost');
  }
  if (evt.type !== 'charge.success') return outcome('ignored');

  // Trust the money, not the message: the amount and currency the provider says it took must be what we asked for.
  if (evt.amount_kobo !== order.total_kobo || evt.currency !== order.currency) {
    await env.DB.prepare(`UPDATE orders SET status = 'review' WHERE id = ?1 AND status IN ('pending', 'expired')`).bind(order.id).run();
    return outcome('amount_mismatch');
  }
  const flip = await env.DB.prepare(
    `UPDATE orders SET status = 'paid', paid_at = ?2, processor_fee_kobo = ?3 WHERE id = ?1 AND status IN ('pending', 'expired')`
  ).bind(order.id, nowSec(), evt.processor_fee_kobo ?? 0).run();
  if (flip.meta.changes === 1) {
    await writeSaleLedger(env, order, evt.processor_fee_kobo);
  }
  await ensureTickets(env, order.id);
  if (flip.meta.changes === 1) await notify(env, ctx, order, 'order.fulfilled');
  return outcome(flip.meta.changes === 1 ? 'paid' : 'already_paid');
}

// GET /api/orders/:id  (the buyer). The browser polls this after returning from checkout; it reflects the webhook, never the redirect.
export async function getOrder({ env, user, params }) {
  let o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1 AND user_id = ?2').bind(String(params.id).slice(0, 40), user.id).first();
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  if (o.status === 'paid') { await ensureTickets(env, o.id); o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(o.id).first(); }
  if (o.status === 'pending' && o.expires_at <= nowSec()) {
    await env.DB.prepare(`UPDATE orders SET status = 'expired' WHERE id = ?1 AND status = 'pending'`).bind(o.id).run();
    o.status = 'expired';
  }
  const passes = (await env.DB.prepare('SELECT id, status FROM passes WHERE order_id = ?1 ORDER BY order_seq').bind(o.id).all()).results;
  return json({ order: publicOrder(o), passes });
}

// Reverses part (or all) of an order's sale in the ledger. The reversal of the last remaining part is exact, so the rows always
// sum to nothing after a full refund. Along the way gross = organiser_payable + commission keeps holding.
async function reversalRows(env, o, amount, final) {
  const rows = (await env.DB.prepare(`SELECT kind, reason, SUM(amount_kobo) AS n FROM order_ledger WHERE order_id = ?1 GROUP BY kind, reason`).bind(o.id).all()).results;
  const left = (k) => rows.filter((r) => r.kind === k).reduce((t, r) => t + r.n, 0); // sale rows minus earlier reversals
  if (final) return ['gross', 'organiser_payable', 'commission', 'processor_fee'].map((k) => [k, -left(k)]);
  const sale = (k) => rows.find((r) => r.kind === k && r.reason === 'sale')?.n || 0;
  const payable = Math.round((sale('organiser_payable') * amount) / o.total_kobo);
  return [['gross', -amount], ['organiser_payable', -payable], ['commission', -(amount - payable)], ['processor_fee', -Math.round((sale('processor_fee') * amount) / o.total_kobo)]];
}
const ledgerStmts = (env, o, rows, reason, now) => rows.map(([kind, amt]) =>
  env.DB.prepare(`INSERT INTO order_ledger (id, order_id, event_id, kind, amount_kobo, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(newId(12), o.id, o.event_id, kind, amt, reason, now));

async function notify(env, ctx, order, type, extra = {}) {
  const ev = await env.DB.prepare('SELECT owner_id, sandbox FROM events WHERE id = ?1').bind(order.event_id).first();
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(order.id).first();
  const queued = await emit(env, ev.owner_id, !!ev.sandbox, type, {
    order_id: o.id, event_id: o.event_id, tier_id: o.tier_id, qty: o.qty, status: o.status, currency: o.currency, total_kobo: o.total_kobo,
    refunded_kobo: o.refunded_kobo, refunded_qty: o.refunded_qty, dispute_status: o.dispute_status, ...extra
  });
  if (queued && ctx && ctx.waitUntil) ctx.waitUntil(flushWebhooks(env));
}

// POST /api/events/:id/orders/:orderId/refund  { pass_ids?: [...] }  (the organiser)
// With no body the whole remaining order is refunded; with pass_ids only those tickets are, for a share of what was paid.
// Refused once a ticket being refunded has been used, and while a chargeback is open.
export async function refundOrder({ request, env, user, params, ctx }) {
  await requireSecondStep(env, request, user.id, { mandatory: organiserMfaMandatory(env) });
  const ev = await ownedEvent(env, user, params.id);
  let b = {};
  try { const t = await request.text(); if (t) b = JSON.parse(t); } catch { throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.'); }
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1 AND event_id = ?2').bind(String(params.orderId).slice(0, 40), ev.id).first();
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  if (o.status === 'refunded') return json({ order: publicOrder(o), already: true });
  if (!['fulfilled', 'refund_due'].includes(o.status)) throw new HttpError(409, 'not_refundable', 'This order cannot be refunded in its current state.');
  if (o.dispute_status === 'open') throw new HttpError(409, 'disputed', 'The buyer has disputed this payment with their bank. It cannot be refunded here until the dispute is decided.');

  const active = (await env.DB.prepare(`SELECT id, invite_id FROM passes WHERE order_id = ?1 AND status = 'active'`).bind(o.id).all()).results;
  const remaining = o.qty - o.refunded_qty;
  let chosen = active;
  if (b.pass_ids !== undefined) {
    if (!Array.isArray(b.pass_ids) || !b.pass_ids.length) throw new HttpError(400, 'invalid_pass_ids', 'Choose at least one ticket.');
    chosen = [...new Set(b.pass_ids)].map((id) => active.find((p) => p.id === id));
    if (chosen.some((p) => !p)) throw new HttpError(400, 'invalid_pass_ids', 'One of those tickets is not an active ticket from this order.');
  }
  const k = b.pass_ids !== undefined ? chosen.length : remaining;
  if (k < 1 || k > remaining) throw new HttpError(400, 'invalid_pass_ids', 'Nothing to refund.');
  if (chosen.length) {
    const marks = chosen.map((_, i) => '?' + (i + 2)).join(',');
    const used = await env.DB.prepare(`SELECT COUNT(*) AS n FROM scans WHERE result = 'granted' AND pass_id IN (${marks})`).bind(o.id, ...chosen.map((p) => p.id)).first();
    if (used.n > 0) throw new HttpError(409, 'already_used', 'Someone has already entered with a ticket being refunded, so it cannot be refunded here.');
  }
  const final = k === remaining;
  const amount = final ? o.total_kobo - o.refunded_kobo : Math.floor((o.total_kobo * k) / o.qty);

  const lock = await env.DB.prepare(`UPDATE orders SET status = 'refunding' WHERE id = ?1 AND status IN ('fulfilled', 'refund_due') AND refunded_qty = ?2`).bind(o.id, o.refunded_qty).run();
  if (lock.meta.changes !== 1) throw new HttpError(409, 'not_refundable', 'This order is already being refunded.');
  try {
    await getProvider(env, o.provider).refund(env, { provider_ref: o.provider_ref, amount_kobo: amount, order_id: o.id });
  } catch (e) {
    await env.DB.prepare(`UPDATE orders SET status = ?2 WHERE id = ?1 AND status = 'refunding'`).bind(o.id, o.status).run();
    throw e;
  }
  const now = nowSec();
  const rows = await reversalRows(env, o, amount, final);
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET status = ?2, refunded_kobo = refunded_kobo + ?3, refunded_qty = refunded_qty + ?4, refunded_at = ?5 WHERE id = ?1`).bind(o.id, final ? 'refunded' : 'fulfilled', amount, k, now),
    ...chosen.map((p) => env.DB.prepare(`UPDATE passes SET status = 'revoked' WHERE id = ?1`).bind(p.id)),
    ...chosen.map((p) => env.DB.prepare(`UPDATE invites SET status = 'revoked' WHERE id = ?1`).bind(p.invite_id)),
    ...ledgerStmts(env, o, rows, 'refund', now)
  ]);
  await notify(env, ctx, o, 'order.refunded', { refund_kobo: amount });
  const fresh = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(o.id).first();
  return json({ order: publicOrder(fresh), refunded_kobo: amount, refunded_tickets: k });
}

// GET /api/events/:id/finance  (the organiser): what was sold, what they are owed, and a check that the books agree.
export async function finance({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const sums = (await env.DB.prepare(`SELECT kind, COALESCE(SUM(amount_kobo), 0) AS n FROM order_ledger WHERE event_id = ?1 GROUP BY kind`).bind(ev.id).all()).results;
  const k = Object.fromEntries(sums.map((r) => [r.kind, r.n]));
  const counts = (await env.DB.prepare(`SELECT status, COUNT(*) AS orders, COALESCE(SUM(qty), 0) AS tickets FROM orders WHERE event_id = ?1 GROUP BY status`).bind(ev.id).all()).results;
  const gross = k.gross || 0, payable = k.organiser_payable || 0, commission = k.commission || 0;
  // For every order: gross = organiser_payable + commission when the buyer paid the fee; gross = organiser_payable + commission
  // also holds when the organiser absorbed it (payable was reduced by exactly the commission). The two always add up.
  return json({
    currency: 'NGN',
    gross_kobo: gross, organiser_payable_kobo: payable, commission_kobo: commission, processor_fees_kobo: k.processor_fee || 0,
    reconciled: gross === payable + commission,
    orders: counts
  });
}

const mask = (s) => (s ? (s.includes('@') ? s.replace(/^(.).*(@.*)$/, '$1•••$2') : s.replace(/.(?=.{3}$)/g, '•')) : null);

// GET /api/events/:id/orders  (the organiser): the latest 200 orders, buyers shown by name and a masked contact.
export async function listOrders({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const rows = (await env.DB.prepare(
    `SELECT o.id, o.qty, o.status, o.total_kobo, o.discount_kobo, o.created_at, o.paid_at, t.name AS tier_name, u.name AS buyer_name, u.email, u.phone
     FROM orders o JOIN tiers t ON t.id = o.tier_id JOIN users u ON u.id = o.user_id
     WHERE o.event_id = ?1 AND o.status != 'pending' OR (o.event_id = ?1 AND o.status = 'pending' AND o.expires_at > ?2)
     ORDER BY o.created_at DESC LIMIT 200`
  ).bind(ev.id, nowSec()).all()).results;
  return json({ orders: rows.map((r) => ({ id: r.id, qty: r.qty, status: r.status, total_kobo: r.total_kobo, discount_kobo: r.discount_kobo, created_at: r.created_at, paid_at: r.paid_at, tier: r.tier_name, buyer: r.buyer_name || null, contact: mask(r.email || r.phone) })) });
}
