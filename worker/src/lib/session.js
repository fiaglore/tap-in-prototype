import { base64url, hmacHex, nowSec, randomBytes } from './util.js';
import { readCookies } from './http.js';

// Two separate sign-ins: the attendee app, and the organiser/Business console. Each has its own cookie and its own sessions,
// so signing in to one does not sign you in to the other. The pages say which one they mean with the X-Tap-In-Area header
// (the console pages send "console"); anything else is the app. The header only chooses which of the caller's own cookies to
// read, so it cannot be used to borrow someone else's session.
const COOKIES = { app: 'tapin_session', console: 'tapin_console' };
const TTL = 30 * 24 * 3600;

// Plain links (CSV downloads) cannot send a header, so ?area=console says the same thing.
export const areaOf = (request) => {
  if (request.headers.get('x-tap-in-area') === 'console') return 'console';
  try { if (new URL(request.url).searchParams.get('area') === 'console') return 'console'; } catch { /* not a URL we can read */ }
  return 'app';
};
export const sessionToken = (request, area = areaOf(request)) => {
  const t = readCookies(request)[COOKIES[area]];
  return t && t.length < 100 ? t : null;
};

function cookie(request, area, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIES[area]}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

// The browser holds a random token; the database holds only its keyed hash.
export async function startSession(env, request, userId, area = areaOf(request)) {
  const token = base64url(randomBytes(32));
  const hash = await hmacHex(env.SECRET_PEPPER, 'session|' + token);
  const now = nowSec();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, scope) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(hash, userId, now, now + TTL, area)
    .run();
  return cookie(request, area, token, TTL);
}

export async function endSession(env, request, area = areaOf(request)) {
  const token = sessionToken(request, area);
  if (token) {
    const hash = await hmacHex(env.SECRET_PEPPER, 'session|' + token);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(hash).run();
  }
  return cookie(request, area, '', 0);
}

// The session and who it belongs to, or null. A suspended account has no usable session.
export async function currentSession(env, request, area = areaOf(request)) {
  const token = sessionToken(request, area);
  if (!token) return null;
  const hash = await hmacHex(env.SECRET_PEPPER, 'session|' + token);
  return env.DB.prepare(
    'SELECT u.id, u.phone, u.email, u.name, s.created_at AS session_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND s.scope = ?3 AND u.suspended_at IS NULL'
  )
    .bind(hash, nowSec(), area)
    .first();
}

export async function currentUser(env, request, area = areaOf(request)) {
  const row = await currentSession(env, request, area);
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
