// Shared money helpers. PAYMENTS_MODE in wrangler.jsonc is "demo" (play money, nothing real moves) or
// "live" (needs a payment provider that this project does not have yet, so it refuses).

import { HttpError, nowSec } from './util.js';
import { MAX_PAY_KOBO } from './codes.js';

export const MAX_TOPUP_KOBO = 100_000_00; // N100,000 a time in the demo
export const paymentsMode = (env) => (env.PAYMENTS_MODE === 'live' ? 'live' : 'demo');

export function requireDemoMoney(env, what) {
  if (paymentsMode(env) === 'live') {
    throw new HttpError(
      501,
      'payments_not_connected',
      `Real ${what} is not connected yet. A payment provider (for example Paystack or Flutterwave) has to be wired in first. See worker/README.md, Payments.`
    );
  }
}

// An amount in kobo from user input: a whole number between 1 and `max`.
export function parseKobo(v, max = MAX_PAY_KOBO, label = 'amount') {
  const n = typeof v === 'number' ? v : /^\d{1,12}$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new HttpError(400, 'invalid_amount', `Enter a ${label} between ₦0.01 and ₦${(max / 100).toLocaleString('en-NG')}.`);
  }
  return n;
}

export const ensureWallet = (env, userId) =>
  env.DB.prepare('INSERT OR IGNORE INTO wallets (user_id, balance_kobo, updated_at) VALUES (?1, 0, ?2)').bind(userId, nowSec());

// The first name and last initial of a person, for a till screen.
export function displayName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// D1 reports a failed CHECK or UNIQUE as an error message; these tell the two apart.
export const isCheckFail = (err) => /CHECK constraint failed/i.test(String(err?.message));
export const isUniqueFail = (err) => /UNIQUE constraint failed/i.test(String(err?.message));
