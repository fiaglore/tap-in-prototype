// Customer side of payments: a wallet, a way to top it up, and the pay code a vendor scans.

import { HttpError, newId, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { MAX_PAY_KOBO, PAY_STEP, PAY_WINDOWS, makePayCode } from '../lib/codes.js';
import { MAX_TOPUP_KOBO, ensureWallet, isCheckFail, parseKobo, paymentsMode, requireDemoMoney } from '../lib/money.js';
import { take } from '../lib/limits.js';

async function recent(env, userId, limit = 30) {
  return (
    await env.DB.prepare(
      `SELECT l.id, l.kind, l.amount_kobo, l.created_at, v.name AS vendor, l.refund_of
       FROM ledger l LEFT JOIN vendors v ON v.id = l.vendor_id
       WHERE l.user_id = ?1 ORDER BY l.created_at DESC, l.id DESC LIMIT ?2`
    )
      .bind(userId, limit)
      .all()
  ).results;
}

// GET /api/wallet
export async function wallet({ env, user }) {
  await ensureWallet(env, user.id).run();
  const w = await env.DB.prepare('SELECT balance_kobo FROM wallets WHERE user_id = ?1').bind(user.id).first();
  return json({
    balance_kobo: w.balance_kobo,
    mode: paymentsMode(env),
    limits: { topup_kobo: MAX_TOPUP_KOBO, payment_kobo: MAX_PAY_KOBO },
    entries: await recent(env, user.id)
  });
}

// POST /api/wallet/topup  { amount_kobo }   demo money only
export async function topup({ request, env, user }) {
  requireDemoMoney(env, 'top-ups');
  const b = await readJson(request);
  const amount = parseKobo(b.amount_kobo, MAX_TOPUP_KOBO, 'top-up');
  if (!(await take(env.DB, 'topup:' + user.id, 30, 86400))) throw new HttpError(429, 'rate_limited', 'That is a lot of top-ups for one day. Try again tomorrow.');
  try {
    await env.DB.batch([
      ensureWallet(env, user.id),
      env.DB.prepare('UPDATE wallets SET balance_kobo = balance_kobo + ?1, updated_at = ?2 WHERE user_id = ?3').bind(amount, nowSec(), user.id),
      env.DB.prepare("INSERT INTO ledger (id, kind, user_id, amount_kobo, created_at) VALUES (?1, 'topup', ?2, ?3, ?4)").bind(newId(14), user.id, amount, nowSec())
    ]);
  } catch (err) {
    if (isCheckFail(err)) throw new HttpError(400, 'balance_limit', 'That would take your wallet over its limit.');
    throw err;
  }
  return wallet({ env, user });
}

// POST /api/wallet/pay-code  { amount_kobo }
// The code holds no money. It is a signed instruction "this person agrees to pay this amount", good for
// a few minutes and for one payment. Funds are checked when the vendor scans it.
export async function payCode({ request, env, user }) {
  const b = await readJson(request);
  const amount = parseKobo(b.amount_kobo, MAX_PAY_KOBO, 'payment');
  const code = await makePayCode(env.SECRET_PEPPER, user.id, amount, nowSec());
  return json({ code, amount_kobo: amount, expires_in: PAY_STEP * PAY_WINDOWS }, 201);
}
