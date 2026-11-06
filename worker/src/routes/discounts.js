// Discount codes (dossier 5): organisers create them, buyers type one at checkout.
import { HttpError, newId, nowSec, parseWhen } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { ownedEvent } from './events.js';
import { priceOrder } from '../lib/fees.js';

export const normaliseDiscount = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);

// Redemptions that count against max_uses: paid orders, and other buyers' unexpired pending ones.
export const USES_SQL = `(SELECT COUNT(*) FROM orders o WHERE o.discount_code_id = d.id AND (o.status IN ('paid','fulfilled','refund_due','refunding') OR (o.status = 'pending' AND o.expires_at > ?NOW)))`;

// Works out the price of an order with an optional code. Throws a plain-language error if the code cannot be used.
export async function quote(env, { event, tier, qty, codeText }) {
  let disc = null;
  let discountKobo = 0;
  const gross = tier.price_kobo * qty;
  if (codeText) {
    const code = normaliseDiscount(codeText);
    const now = nowSec();
    disc = await env.DB.prepare(
      `SELECT d.*, ${USES_SQL.replace('?NOW', '?3')} AS uses FROM discount_codes d WHERE d.event_id = ?1 AND d.code = ?2`
    ).bind(event.id, code, now).first();
    if (!disc || disc.status !== 'active') throw new HttpError(400, 'invalid_discount', 'That discount code is not valid.');
    if (disc.expires_at && disc.expires_at <= now) throw new HttpError(400, 'discount_expired', 'That discount code has expired.');
    if (disc.tier_id && disc.tier_id !== tier.id) throw new HttpError(400, 'discount_wrong_ticket', 'That code does not apply to this ticket type.');
    if (disc.max_uses && disc.uses + 1 > disc.max_uses) throw new HttpError(400, 'discount_used_up', 'That discount code has been used up.');
    discountKobo = disc.percent_off ? Math.floor((gross * disc.percent_off) / 100) : Math.min(gross, disc.amount_off_kobo * qty);
    if (gross - discountKobo <= 0) throw new HttpError(400, 'discount_too_large', 'That code would make the order free. Ask the organiser for a free ticket instead.');
  }
  const unit = { unitKobo: tier.price_kobo, qty, feeMode: event.fee_mode, discountKobo };
  return { disc, discountKobo, ...priceOrder(env, unit) };
}

// POST /api/events/:id/discounts { code, percent_off | amount_off_kobo, tier_id?, max_uses?, expires_at? }
export async function createDiscount({ request, env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const b = await readJson(request);
  const code = normaliseDiscount(b.code);
  if (code.length < 3) throw new HttpError(400, 'invalid_code', 'Use 3 to 20 letters or numbers for the code.');
  const pct = b.percent_off === undefined || b.percent_off === null ? null : Number.parseInt(b.percent_off, 10);
  const amt = b.amount_off_kobo === undefined || b.amount_off_kobo === null ? null : Number.parseInt(b.amount_off_kobo, 10);
  if ((pct === null) === (amt === null)) throw new HttpError(400, 'invalid_discount', 'Give either a percentage or a fixed amount off, not both.');
  if (pct !== null && !(pct >= 1 && pct <= 90)) throw new HttpError(400, 'invalid_discount', 'A percentage discount must be between 1 and 90.');
  if (amt !== null && !(amt >= 1 && amt <= 500_000_00)) throw new HttpError(400, 'invalid_discount', 'Enter a valid amount off.');
  let tierId = null;
  if (b.tier_id) {
    const t = await env.DB.prepare('SELECT id FROM tiers WHERE id = ?1 AND event_id = ?2').bind(String(b.tier_id), ev.id).first();
    if (!t) throw new HttpError(400, 'invalid_tier', 'Choose a ticket type from this event.');
    tierId = t.id;
  }
  const maxUses = b.max_uses === undefined || b.max_uses === null || b.max_uses === '' ? null : Number.parseInt(b.max_uses, 10);
  if (maxUses !== null && !(maxUses >= 1 && maxUses <= 100000)) throw new HttpError(400, 'invalid_max_uses', 'Enter how many times the code can be used.');
  const expires = parseWhen(b.expires_at, 'expiry');
  const id = newId(10);
  try {
    await env.DB.prepare(
      `INSERT INTO discount_codes (id, event_id, code, percent_off, amount_off_kobo, tier_id, max_uses, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(id, ev.id, code, pct, amt, tierId, maxUses, expires, nowSec()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, 'code_exists', 'This event already has a code with that name.');
    throw e;
  }
  return json({ discount: { id, code, percent_off: pct, amount_off_kobo: amt, tier_id: tierId, max_uses: maxUses, expires_at: expires, status: 'active', uses: 0 } }, 201);
}

// GET /api/events/:id/discounts
export async function listDiscounts({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const rows = (await env.DB.prepare(
    `SELECT d.id, d.code, d.percent_off, d.amount_off_kobo, d.tier_id, d.max_uses, d.expires_at, d.status, ${USES_SQL.replace('?NOW', '?2')} AS uses
     FROM discount_codes d WHERE d.event_id = ?1 ORDER BY d.created_at DESC`
  ).bind(ev.id, nowSec()).all()).results;
  return json({ discounts: rows });
}

// POST /api/events/:id/discounts/:discountId/revoke
export async function revokeDiscount({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const r = await env.DB.prepare(`UPDATE discount_codes SET status = 'revoked' WHERE id = ?1 AND event_id = ?2`).bind(String(params.discountId).slice(0, 40), ev.id).run();
  if (r.meta.changes !== 1) throw new HttpError(404, 'not_found', 'Discount code not found.');
  return json({ ok: true });
}

// POST /api/public/events/:id/quote { tier_id, qty?, discount_code? }  -> what the buyer would pay
export async function quoteRoute({ request, env, params }) {
  const b = await readJson(request);
  const ev = await env.DB.prepare(`SELECT id, fee_mode FROM events WHERE id = ?1 AND kind = 'event'`).bind(String(params.id).slice(0, 40)).first();
  if (!ev) throw new HttpError(404, 'not_found', 'Event not found.');
  const tier = await env.DB.prepare('SELECT id, name, price_kobo FROM tiers WHERE id = ?1 AND event_id = ?2').bind(b.tier_id, ev.id).first();
  if (!tier) throw new HttpError(400, 'invalid_tier', 'Choose a ticket type.');
  const qty = b.qty === undefined ? 1 : Number.parseInt(b.qty, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > 8) throw new HttpError(400, 'invalid_qty', 'Buy between 1 and 8 tickets at a time.');
  const q = await quote(env, { event: ev, tier, qty, codeText: b.discount_code });
  return json({ quote: { currency: 'NGN', unit_kobo: tier.price_kobo, qty, discount_kobo: q.discountKobo, subtotal_kobo: q.subtotal_kobo, fee_kobo: q.buyer_fee_kobo, total_kobo: q.total_kobo } });
}
