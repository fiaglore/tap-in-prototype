// Vendor side of payments: set up a business that takes Tap In, see sales, refund, and pay out.
// Every route checks the signed-in user owns the vendor; someone else's vendor answers 404.

import { HttpError, cleanText, newId, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { hashTillKey, makeTillKey } from '../lib/codes.js';
import { isCheckFail, isUniqueFail, parseKobo, requireDemoMoney } from '../lib/money.js';

export const MAX_VENDORS_PER_USER = 5;

async function ownedVendor(env, user, id) {
  const v = await env.DB.prepare(
    'SELECT id, name, category, listed, till_key_hint, balance_kobo, created_at FROM vendors WHERE id = ?1 AND owner_id = ?2'
  )
    .bind(String(id).slice(0, 40), user.id)
    .first();
  if (!v) throw new HttpError(404, 'not_found', 'Business not found.');
  return v;
}

const out = (v) => ({ id: v.id, name: v.name, category: v.category, listed: !!v.listed, till_key_hint: v.till_key_hint, balance_kobo: v.balance_kobo, created_at: v.created_at });

// GET /api/vendors
export async function listVendors({ env, user }) {
  const rows = (
    await env.DB.prepare(
      `SELECT v.id, v.name, v.category, v.listed, v.till_key_hint, v.balance_kobo, v.created_at,
        (SELECT COUNT(*) FROM ledger l WHERE l.vendor_id = v.id AND l.kind = 'payment') AS sales
       FROM vendors v WHERE v.owner_id = ?1 ORDER BY v.created_at DESC`
    )
      .bind(user.id)
      .all()
  ).results;
  return json({ vendors: rows.map((v) => ({ ...out(v), sales: v.sales })) });
}

// POST /api/vendors  { name, category? }  -> the till key, shown once
export async function createVendor({ request, env, user }) {
  const b = await readJson(request);
  const name = cleanText(b.name, 'business name', { min: 2, max: 80 });
  const category = cleanText(b.category, 'category', { optional: true, max: 40 });
  const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM vendors WHERE owner_id = ?1').bind(user.id).first();
  if (mine.n >= MAX_VENDORS_PER_USER) throw new HttpError(400, 'vendor_limit', `You can have up to ${MAX_VENDORS_PER_USER} businesses.`);
  const id = newId(12);
  const key = makeTillKey();
  await env.DB.prepare(
    'INSERT INTO vendors (id, owner_id, name, category, till_key_hash, till_key_hint, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  )
    .bind(id, user.id, name, category, await hashTillKey(env.SECRET_PEPPER, key), key.slice(-4), nowSec())
    .run();
  return json({ vendor: out(await ownedVendor(env, user, id)), till_key: key }, 201);
}

async function sales(env, vendorId, limit = 50) {
  return (
    await env.DB.prepare(
      `SELECT l.id, l.kind, l.amount_kobo, l.created_at, u.name AS customer,
        (SELECT 1 FROM ledger r WHERE r.refund_of = l.id) AS refunded
       FROM ledger l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.vendor_id = ?1 ORDER BY l.created_at DESC, l.id DESC LIMIT ?2`
    )
      .bind(vendorId, limit)
      .all()
  ).results.map((r) => ({ id: r.id, kind: r.kind, amount_kobo: r.amount_kobo, at: r.created_at, customer: r.customer ? r.customer.split(/\s+/)[0] : null, refunded: !!r.refunded }));
}

// GET /api/vendors/:id
export async function getVendor({ env, user, params }) {
  const v = await ownedVendor(env, user, params.id);
  const t = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount_kobo END), 0) AS taken,
            COALESCE(SUM(CASE WHEN kind = 'refund' THEN amount_kobo END), 0) AS refunded,
            COALESCE(SUM(CASE WHEN kind = 'payout' THEN amount_kobo END), 0) AS paid_out
     FROM ledger WHERE vendor_id = ?1`
  )
    .bind(v.id)
    .first();
  return json({ vendor: out(v), totals: t, entries: await sales(env, v.id) });
}

// PATCH /api/vendors/:id  { listed?, name?, category? }
export async function patchVendor({ request, env, user, params }) {
  const v = await ownedVendor(env, user, params.id);
  const b = await readJson(request);
  const name = b.name === undefined ? v.name : cleanText(b.name, 'business name', { min: 2, max: 80 });
  const category = b.category === undefined ? v.category : cleanText(b.category, 'category', { optional: true, max: 40 });
  const listed = typeof b.listed === 'boolean' ? (b.listed ? 1 : 0) : v.listed;
  await env.DB.prepare('UPDATE vendors SET name = ?1, category = ?2, listed = ?3 WHERE id = ?4').bind(name, category, listed, v.id).run();
  return json({ vendor: out(await ownedVendor(env, user, v.id)) });
}

// POST /api/vendors/:id/till-key  -> a new key; the old one stops working at once
export async function rotateTillKey({ env, user, params }) {
  const v = await ownedVendor(env, user, params.id);
  const key = makeTillKey();
  await env.DB.prepare('UPDATE vendors SET till_key_hash = ?1, till_key_hint = ?2 WHERE id = ?3').bind(await hashTillKey(env.SECRET_PEPPER, key), key.slice(-4), v.id).run();
  return json({ till_key: key });
}

// POST /api/vendors/:id/refunds  { payment_id }   gives the customer their money back, once
export async function refund({ request, env, user, params }) {
  const v = await ownedVendor(env, user, params.id);
  const b = await readJson(request);
  const pay = await env.DB.prepare("SELECT id, user_id, amount_kobo FROM ledger WHERE id = ?1 AND vendor_id = ?2 AND kind = 'payment'")
    .bind(String(b.payment_id ?? '').slice(0, 40), v.id)
    .first();
  if (!pay) throw new HttpError(404, 'not_found', 'Payment not found.');
  const now = nowSec();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ledger (id, kind, user_id, vendor_id, amount_kobo, refund_of, created_at) VALUES (?1, 'refund', ?2, ?3, ?4, ?5, ?6)")
        .bind(newId(14), pay.user_id, v.id, pay.amount_kobo, pay.id, now),
      env.DB.prepare('UPDATE vendors SET balance_kobo = balance_kobo - ?1 WHERE id = ?2').bind(pay.amount_kobo, v.id),
      env.DB.prepare('UPDATE wallets SET balance_kobo = balance_kobo + ?1, updated_at = ?2 WHERE user_id = ?3').bind(pay.amount_kobo, now, pay.user_id)
    ]);
  } catch (err) {
    if (isUniqueFail(err)) throw new HttpError(409, 'already_refunded', 'That payment was already refunded.');
    if (isCheckFail(err)) throw new HttpError(409, 'balance_too_low', 'Your balance is too low to refund this. Refunds come out of your Tap In balance.');
    throw err;
  }
  return json({ ok: true });
}

// POST /api/vendors/:id/payout  { amount_kobo }   demo: records the payout; real transfers need a provider
export async function payout({ request, env, user, params }) {
  requireDemoMoney(env, 'payouts');
  const v = await ownedVendor(env, user, params.id);
  const b = await readJson(request);
  const amount = parseKobo(b.amount_kobo, 2_000_000_000, 'payout');
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ledger (id, kind, vendor_id, amount_kobo, created_at) VALUES (?1, 'payout', ?2, ?3, ?4)").bind(newId(14), v.id, amount, nowSec()),
      env.DB.prepare('UPDATE vendors SET balance_kobo = balance_kobo - ?1 WHERE id = ?2').bind(amount, v.id)
    ]);
  } catch (err) {
    if (isCheckFail(err)) throw new HttpError(409, 'balance_too_low', 'That is more than your Tap In balance.');
    throw err;
  }
  return json({ vendor: out(await ownedVendor(env, user, v.id)) }, 201);
}

// GET /api/public/vendors  -> the "Tap In enabled" list
export async function publicVendors({ env }) {
  const rows = (await env.DB.prepare('SELECT name, category FROM vendors WHERE listed = 1 ORDER BY name LIMIT 200').all()).results;
  return json({ vendors: rows });
}
