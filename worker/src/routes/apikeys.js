// API keys and webhook endpoints (managed by the signed-in owner), and the check that turns a key into a caller.
import { HttpError, cleanText, hmacHex, newId, nowSec, randomBase32 } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import * as limits from '../lib/limits.js';
import { requireSecondStep } from './mfa.js';
import { EVENT_TYPES, newEndpointSecret, sealEndpointSecret, validateUrl } from '../lib/outbound.js';

export const SCOPES = ['events:read', 'events:write', 'attendance:read', 'payments:read'];
const MAX_KEYS = 10;
const MAX_ENDPOINTS = 5;

// Turns "Authorization: Bearer tk_live_..." into { key, user }, or throws 401. Also applies the key's rate limit.
export async function authenticateKey(env, request) {
  const m = /^Bearer\s+(tk_(?:live|test)_[A-Z0-9]{32})$/.exec(request.headers.get('authorization') || '');
  const nope = new HttpError(401, 'invalid_api_key', 'Send a valid API key as "Authorization: Bearer <key>".');
  if (!m) throw nope;
  const hash = await hmacHex(env.SECRET_PEPPER, 'apikey|' + m[1]);
  const key = await env.DB.prepare(
    `SELECT k.id, k.owner_id, k.mode, k.scopes, k.rate_per_min, k.last_used_at FROM api_keys k JOIN users u ON u.id = k.owner_id
     WHERE k.key_hash = ?1 AND k.status = 'active' AND u.suspended_at IS NULL`
  ).bind(hash).first();
  if (!key) throw nope;
  if (!(await limits.take(env.DB, 'apikey:' + key.id, key.rate_per_min, 60))) {
    throw new HttpError(429, 'rate_limited', `Too many requests. This key allows ${key.rate_per_min} a minute.`, );
  }
  const now = nowSec();
  if (!key.last_used_at || now - key.last_used_at > 60) await env.DB.prepare('UPDATE api_keys SET last_used_at = ?2 WHERE id = ?1').bind(key.id, now).run();
  return { key: { id: key.id, mode: key.mode, scopes: JSON.parse(key.scopes), sandbox: key.mode === 'sandbox' }, user: { id: key.owner_id } };
}

export function needScope(key, scope) {
  if (!key.scopes.includes(scope)) throw new HttpError(403, 'insufficient_scope', `This key does not have the "${scope}" permission.`);
}

const pub = (k) => ({ id: k.id, name: k.name, mode: k.mode, scopes: JSON.parse(k.scopes), key_hint: '…' + k.key_hint, rate_per_min: k.rate_per_min, status: k.status, created_at: k.created_at, last_used_at: k.last_used_at });

// GET /api/me/api-keys
export async function listKeys({ env, user }) {
  const rows = (await env.DB.prepare('SELECT * FROM api_keys WHERE owner_id = ?1 ORDER BY created_at DESC').bind(user.id).all()).results;
  return json({ keys: rows.map(pub), scopes: SCOPES });
}

// POST /api/me/api-keys { name, mode: "sandbox"|"live", scopes: [...] } -> the key, shown once
export async function createKey({ request, env, user }) {
  const b = await readJson(request);
  const name = cleanText(b.name, 'name', { max: 40 });
  if (!['sandbox', 'live'].includes(b.mode)) throw new HttpError(400, 'invalid_mode', 'Choose "sandbox" (for testing) or "live".');
  const scopes = Array.isArray(b.scopes) && b.scopes.length ? [...new Set(b.scopes)] : null;
  if (!scopes || scopes.some((s) => !SCOPES.includes(s))) throw new HttpError(400, 'invalid_scopes', 'Choose from: ' + SCOPES.join(', ') + '.');
  if (b.mode === 'live') await requireSecondStep(env, request, user.id);
  const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE owner_id = ?1 AND status = 'active'`).bind(user.id).first()).n;
  if (n >= MAX_KEYS) throw new HttpError(400, 'key_limit', `You can have up to ${MAX_KEYS} active keys. Revoke one first.`);
  const secret = `tk_${b.mode === 'live' ? 'live' : 'test'}_${randomBase32(32)}`;
  const id = newId(10);
  await env.DB.prepare('INSERT INTO api_keys (id, owner_id, name, key_hash, key_hint, mode, scopes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(id, user.id, name, await hmacHex(env.SECRET_PEPPER, 'apikey|' + secret), secret.slice(-4), b.mode, JSON.stringify(scopes), nowSec()).run();
  const row = await env.DB.prepare('SELECT * FROM api_keys WHERE id = ?1').bind(id).first();
  return json({ key: pub(row), secret }, 201);
}

// POST /api/me/api-keys/:id/revoke
export async function revokeKey({ env, user, params }) {
  const r = await env.DB.prepare(`UPDATE api_keys SET status = 'revoked' WHERE id = ?1 AND owner_id = ?2`).bind(String(params.id).slice(0, 40), user.id).run();
  if (r.meta.changes !== 1) throw new HttpError(404, 'not_found', 'Key not found.');
  return json({ ok: true });
}

const epPub = (e) => ({ id: e.id, url: e.url, mode: e.mode, event_types: JSON.parse(e.event_types), status: e.status, created_at: e.created_at });

// GET /api/me/webhook-endpoints
export async function listEndpoints({ env, user }) {
  const rows = (await env.DB.prepare('SELECT * FROM webhook_endpoints WHERE owner_id = ?1 ORDER BY created_at DESC').bind(user.id).all()).results;
  return json({ endpoints: rows.map(epPub), event_types: EVENT_TYPES });
}

// POST /api/me/webhook-endpoints { url, mode, event_types? } -> includes the signing secret, shown once
export async function createEndpoint({ request, env, user }) {
  const b = await readJson(request);
  const url = validateUrl(b.url);
  if (!['sandbox', 'live'].includes(b.mode)) throw new HttpError(400, 'invalid_mode', 'Choose "sandbox" or "live".');
  const types = Array.isArray(b.event_types) && b.event_types.length ? [...new Set(b.event_types)] : ['*'];
  if (types.some((t) => t !== '*' && !EVENT_TYPES.includes(t))) throw new HttpError(400, 'invalid_event_types', 'Choose from: ' + EVENT_TYPES.join(', ') + ', or leave empty for all.');
  const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM webhook_endpoints WHERE owner_id = ?1 AND status = 'active'`).bind(user.id).first()).n;
  if (n >= MAX_ENDPOINTS) throw new HttpError(400, 'endpoint_limit', `You can have up to ${MAX_ENDPOINTS} webhook addresses.`);
  const secret = newEndpointSecret();
  const id = newId(10);
  await env.DB.prepare('INSERT INTO webhook_endpoints (id, owner_id, url, secret, mode, event_types, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, user.id, url, await sealEndpointSecret(env, secret), b.mode, JSON.stringify(types), nowSec()).run();
  const row = await env.DB.prepare('SELECT * FROM webhook_endpoints WHERE id = ?1').bind(id).first();
  return json({ endpoint: epPub(row), signing_secret: secret }, 201);
}

// POST /api/me/webhook-endpoints/:id/revoke
export async function revokeEndpoint({ env, user, params }) {
  const r = await env.DB.prepare(`UPDATE webhook_endpoints SET status = 'revoked' WHERE id = ?1 AND owner_id = ?2`).bind(String(params.id).slice(0, 40), user.id).run();
  if (r.meta.changes !== 1) throw new HttpError(404, 'not_found', 'Address not found.');
  return json({ ok: true });
}
