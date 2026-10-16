// The vendor's till. A device authenticates with the vendor's till key (Authorization: Bearer ...),
// reads the customer's pay code, and charges exactly the amount the customer signed.

import { HttpError, newId, normaliseCode, nowSec, safeEqual } from '../lib/util.js';
import { clientIp, json, readJson } from '../lib/http.js';
import { hashTillKey, parsePayCode, payCodeFresh, payCodeMac, payCodeRef } from '../lib/codes.js';
import { displayName, isCheckFail, isUniqueFail } from '../lib/money.js';
import { isFull, record } from '../lib/limits.js';

async function tillVendor(request, env) {
  const ip = clientIp(request);
  const bucket = 'till:ip:' + ip;
  if (await isFull(env.DB, bucket, 20, 600)) throw new HttpError(429, 'rate_limited', 'Too many failed attempts. Wait a few minutes.');
  const m = /^Bearer\s+(.{1,100})$/i.exec(request.headers.get('authorization') || '');
  const key = m ? normaliseCode(m[1]) : '';
  const v = key
    ? await env.DB.prepare('SELECT id, name, category FROM vendors WHERE till_key_hash = ?1').bind(await hashTillKey(env.SECRET_PEPPER, key)).first()
    : null;
  if (!v) {
    await record(env.DB, bucket);
    throw new HttpError(401, 'bad_till_key', 'That till key is not valid.');
  }
  return v;
}

const MESSAGES = {
  invalid_code: 'That is not a valid Tap In pay code.',
  expired: 'This pay code has expired. Ask the customer to make a new one.',
  already_used: 'This pay code has already been used.',
  insufficient_funds: 'Not enough money in the customer’s wallet.'
};

// GET /api/till/info
export async function tillInfo({ request, env }) {
  const v = await tillVendor(request, env);
  return json({ vendor: { id: v.id, name: v.name, category: v.category } });
}

// POST /api/till/charge  { code }
export async function tillCharge({ request, env }) {
  const v = await tillVendor(request, env);
  const body = await readJson(request);
  const ip = clientIp(request);
  const junk = 'till:junk:' + ip;
  if (await isFull(env.DB, junk, 60, 600)) throw new HttpError(429, 'rate_limited', 'Too many unreadable codes. Wait a moment.');

  const now = nowSec();
  const refuse = async (reason, extra = {}) => {
    if (reason === 'invalid_code') await record(env.DB, junk);
    return json({ result: 'declined', reason, message: MESSAGES[reason], ...extra }, 200);
  };

  const p = parsePayCode(body.code);
  if (!p || p.amountKobo < 1 || !safeEqual(await payCodeMac(env.SECRET_PEPPER, p.id, p.amt, p.win, p.nonce), p.mac)) return refuse('invalid_code');
  if (!payCodeFresh(p, now)) return refuse('expired');
  const payer = await env.DB.prepare('SELECT id, name FROM users WHERE id = ?1').bind(p.id).first();
  if (!payer) return refuse('invalid_code');

  const payId = newId(14);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO wallets (user_id, balance_kobo, updated_at) VALUES (?1, 0, ?2)').bind(payer.id, now),
      env.DB.prepare("INSERT INTO ledger (id, kind, user_id, vendor_id, amount_kobo, ref, created_at) VALUES (?1, 'payment', ?2, ?3, ?4, ?5, ?6)")
        .bind(payId, payer.id, v.id, p.amountKobo, payCodeRef(p), now),
      // These two fail the whole batch (and so the payment) if the customer cannot afford it.
      env.DB.prepare('UPDATE wallets SET balance_kobo = balance_kobo - ?1, updated_at = ?2 WHERE user_id = ?3').bind(p.amountKobo, now, payer.id),
      env.DB.prepare('UPDATE vendors SET balance_kobo = balance_kobo + ?1 WHERE id = ?2').bind(p.amountKobo, v.id)
    ]);
  } catch (err) {
    if (isUniqueFail(err)) return refuse('already_used');
    if (isCheckFail(err)) return refuse('insufficient_funds', { amount_kobo: p.amountKobo, customer: displayName(payer.name) });
    throw err;
  }
  return json({ result: 'paid', payment_id: payId, amount_kobo: p.amountKobo, customer: displayName(payer.name), at: now, message: 'Payment received.' });
}
