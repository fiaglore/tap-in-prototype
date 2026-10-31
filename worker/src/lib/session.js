import { base64url, hmacHex, nowSec, randomBytes } from './util.js';
import { readCookies } from './http.js';

const COOKIE = 'tapin_session';
const TTL = 30 * 24 * 3600;

function cookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

// The browser holds a random token; the database holds only its keyed hash.
export async function startSession(env, request, userId) {
  const token = base64url(randomBytes(32));
  const hash = await hmacHex(env.SECRET_PEPPER, 'session|' + token);
  const now = nowSec();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(hash, userId, now, now + TTL)
    .run();
  return cookie(request, token, TTL);
}

export async function endSession(env, request) {
  const token = readCookies(request)[COOKIE];
  if (token && token.length < 100) {
    const hash = await hmacHex(env.SECRET_PEPPER, 'session|' + token);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(hash).run();
  }
  return cookie(request, '', 0);
}

// The session and who it belongs to, or null. A suspended account has no usable session.
export async function currentSession(env, request) {
  const token = readCookies(request)[COOKIE];
  if (!token || token.length > 100) return null;
  const hash = await hmacHex(env.SECRET_PEPPER, 'session|' + token);
  return env.DB.prepare(
    'SELECT u.id, u.phone, u.email, u.name, s.created_at AS session_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.suspended_at IS NULL'
  )
    .bind(hash, nowSec())
    .first();
}

export async function currentUser(env, request) {
  const row = await currentSession(env, request);
  if (!row) return null;
  const { session_at, ...user } = row; // eslint-disable-line no-unused-vars
  return user;
}

export const publicUser = (u) => ({
  id: u.id,
  name: u.name || null,
  phone: u.phone || null,
  email: u.email || null,
  identifier: u.phone || u.email
});
