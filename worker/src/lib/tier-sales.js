// Who may buy a ticket type, and when: the per-person limit and sales waves.
//  - max_per_buyer: the most tickets of one type a person can take (default 2, a group type up to 5).
//  - a wave is a ticket type with its own window (opens_at / closes_at) and/or "opens when <other type> sells out".
import { HttpError, parseWhen } from './util.js';

export const DEFAULT_MAX_PER_BUYER = 2;
export const MAX_PER_BUYER_CAP = 5;

// A tickets-per-person limit: a whole number from 1 to 5. Undefined means "not given".
export function parseMaxPerBuyer(v, name) {
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : /^\d{1,2}$/.test(String(v).trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PER_BUYER_CAP) {
    throw new HttpError(400, 'invalid_max_per_buyer', `Choose between 1 and ${MAX_PER_BUYER_CAP} tickets per person for "${name}".`);
  }
  return n;
}

// A ticket type's own window. Each end is optional; undefined means "not given".
export function parseTierWindow(b, name) {
  const out = {};
  if ('opens_at' in b) out.opens_at = parseWhen(b.opens_at, 'opening time');
  if ('closes_at' in b) out.closes_at = parseWhen(b.closes_at, 'closing time');
  return out;
}

export function assertWindowOrder(opensAt, closesAt, name) {
  if (opensAt && closesAt && closesAt <= opensAt) {
    throw new HttpError(400, 'invalid_tier_window', `"${name}" must stop selling after it starts selling.`);
  }
}

// 'open', 'upcoming' (before opens_at), 'closed' (after closes_at) or 'waiting' (for another type to sell out).
// prevSoldOut: true when there is no earlier type to wait for or it has sold out; false while it still has tickets.
export function waveState(t, now, prevSoldOut) {
  if (t.closes_at && now >= t.closes_at) return 'closed';
  if (t.opens_at && now < t.opens_at) return 'upcoming';
  if (t.opens_after_tier_id && prevSoldOut === false) return 'waiting';
  return 'open';
}

export async function prevSoldOut(env, tier) {
  if (!tier.opens_after_tier_id) return true;
  const p = await env.DB.prepare(
    `SELECT capacity, (SELECT COUNT(*) FROM invites i WHERE i.tier_id = tiers.id AND i.status != 'revoked') AS issued FROM tiers WHERE id = ?1`
  ).bind(tier.opens_after_tier_id).first();
  if (!p) return true; // the type it waited for was removed
  return p.capacity !== null && p.issued >= p.capacity;
}

// What this person already holds from purchases of a type: paid, pending (not expired) and free ones, less refunds.
export const BOUGHT_SQL = `
  (SELECT COALESCE(SUM(qty - refunded_qty), 0) FROM orders
     WHERE user_id = ?U AND tier_id = ?T AND (status IN ('paid','fulfilled','refund_due','refunding') OR (status = 'pending' AND expires_at > ?N)))
  + (SELECT COALESCE(SUM(qty), 0) FROM tier_buys WHERE user_id = ?U AND tier_id = ?T)`;
export const boughtSql = (u, t, n) => BOUGHT_SQL.replaceAll('?U', u).replaceAll('?T', t).replaceAll('?N', n);

export async function boughtBy(env, userId, tierId, now) {
  const r = await env.DB.prepare(`SELECT ${boughtSql('?1', '?2', '?3')} AS n`).bind(userId, tierId, now).first();
  return r ? r.n : 0;
}

const when = (s) => new Date(s * 1000).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' }) + ' (Lagos time)';

// Throws a plain-language error unless this person can take `qty` more of this type right now.
// `tier` needs: id, name, max_per_buyer, opens_at, closes_at, opens_after_tier_id.
export async function assertCanBuy(env, userId, tier, qty, now) {
  const state = waveState(tier, now, await prevSoldOut(env, tier));
  if (state === 'upcoming') throw new HttpError(409, 'tier_not_open', `"${tier.name}" tickets are not on sale yet. They open ${when(tier.opens_at)}.`);
  if (state === 'waiting') throw new HttpError(409, 'tier_not_open', `"${tier.name}" tickets open once the earlier tickets have sold out.`);
  if (state === 'closed') throw new HttpError(409, 'tier_closed', `Sales of "${tier.name}" tickets have ended.`);
  const max = tier.max_per_buyer ?? DEFAULT_MAX_PER_BUYER;
  if (qty > max) throw new HttpError(409, 'ticket_limit', `You can buy up to ${max} "${tier.name}" ticket${max === 1 ? '' : 's'} per person.`);
  const have = await boughtBy(env, userId, tier.id, now);
  if (have + qty > max) {
    const left = Math.max(0, max - have);
    throw new HttpError(409, 'ticket_limit', left === 0
      ? `You already have the most "${tier.name}" tickets one person can buy (${max}).`
      : `You already have ${have} "${tier.name}" ticket${have === 1 ? '' : 's'}. You can buy ${left} more.`);
  }
}
