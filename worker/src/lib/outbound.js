// Outbound webhooks: tells a customer's server when something happens (an order is paid or refunded).
// Each delivery is signed: header  Tap-In-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the endpoint secret>.
// Failed deliveries are retried with growing gaps (1, 2, 4, 8, 16 minutes) and then given up on.
import { HttpError, hmacHex, newId, nowSec, randomBase32 } from './util.js';
import { openSecret, sealSecret } from './mfa.js';

export const EVENT_TYPES = ['order.fulfilled', 'order.refunded', 'order.disputed'];
const MAX_ATTEMPTS = 6;

// Only public HTTPS addresses: no credentials in the URL, no IP addresses, no local or internal names.
export function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { throw new HttpError(400, 'invalid_url', 'Enter a full web address starting with https://.'); }
  const host = u.hostname.toLowerCase();
  const bad = u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443'
    || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || host === 'localhost' || !host.includes('.')
    || /\.(local|internal|localhost|lan|home|corp)$/.test(host);
  if (bad) throw new HttpError(400, 'invalid_url', 'Use a public https:// address (no IP addresses, ports, or internal names).');
  return u.toString().slice(0, 300);
}

export const newEndpointSecret = () => 'whsec_' + randomBase32(32);
export const sealEndpointSecret = sealSecret;

export async function signBody(secret, t, body) {
  return `t=${t},v1=${await hmacHex(secret, t + '.' + body)}`;
}

// Queue an event for every matching endpoint of the owner. Returns how many deliveries were queued.
export async function emit(env, ownerId, sandbox, type, data) {
  const mode = sandbox ? 'sandbox' : 'live';
  const eps = (await env.DB.prepare(`SELECT id, event_types FROM webhook_endpoints WHERE owner_id = ?1 AND mode = ?2 AND status = 'active'`).bind(ownerId, mode).all()).results;
  const now = nowSec();
  const wanted = eps.filter((e) => { const l = JSON.parse(e.event_types); return l.includes('*') || l.includes(type); });
  if (!wanted.length) return 0;
  const body = JSON.stringify({ id: 'evt_' + newId(16), type, created: now, livemode: !sandbox, data });
  await env.DB.batch(wanted.map((e) => env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, endpoint_id, type, payload, status, attempts, next_at, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5)`
  ).bind(newId(14), e.id, type, body, now)));
  return wanted.length;
}

async function deliverOne(env, d, fetcher) {
  const ep = await env.DB.prepare(`SELECT id, url, secret, status FROM webhook_endpoints WHERE id = ?1`).bind(d.endpoint_id).first();
  const now = nowSec();
  if (!ep || ep.status !== 'active') {
    await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'failed' WHERE id = ?1`).bind(d.id).run();
    return;
  }
  let code = 0;
  try {
    const secret = await openSecret(env, ep.secret);
    const res = await fetcher(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'TapIn-Webhooks/1', 'Tap-In-Signature': await signBody(secret, now, d.payload) },
      body: d.payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    });
    code = res.status;
  } catch { code = 0; }
  if (code >= 200 && code < 300) {
    await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_code = ?2 WHERE id = ?1`).bind(d.id, code).run();
  } else {
    const attempts = d.attempts + 1;
    await env.DB.prepare(`UPDATE webhook_deliveries SET attempts = ?2, last_code = ?3, status = ?4, next_at = ?5 WHERE id = ?1`)
      .bind(d.id, attempts, code, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', now + 60 * 2 ** (attempts - 1)).run();
  }
}

// Sends everything that is due. Called right after something happens, and every 15 minutes by the cron trigger.
export async function flush(env, { limit = 25, fetcher = fetch } = {}) {
  const due = (await env.DB.prepare(`SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_at <= ?1 ORDER BY next_at LIMIT ?2`).bind(nowSec(), limit).all()).results;
  for (const d of due) await deliverOne(env, d, fetcher);
  return due.length;
}
