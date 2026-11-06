// Two-step sign-in routes. Setup is two calls: setup (get a secret to scan) then enable (prove the app works).
import { HttpError, hmacHex, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { sessionToken } from '../lib/session.js';
import { MFA_FRESH_SEC, hashRecovery, makeRecoveryCodes, matchTotp, newSecret, openSecret, otpauthUri, sealSecret } from '../lib/mfa.js';
import { take } from '../lib/limits.js';

const row = (env, id) => env.DB.prepare('SELECT id, email, phone, mfa_secret, mfa_enabled_at, mfa_last_step, mfa_recovery FROM users WHERE id = ?1').bind(id).first();

async function markSession(env, request) {
  const hash = await hmacHex(env.SECRET_PEPPER, 'session|' + sessionToken(request));
  await env.DB.prepare('UPDATE sessions SET mfa_at = ?2 WHERE token_hash = ?1').bind(hash, nowSec()).run();
}

// Checks a six-digit app code or an unused recovery code. Throws on failure; rate limited per account.
async function checkCode(env, u, code) {
  if (!(await take(env.DB, 'mfa:' + u.id, 8, 900))) throw new HttpError(429, 'rate_limited', 'Too many tries. Wait 15 minutes and try again.');
  const bad = new HttpError(400, 'invalid_code', 'That code is not right. Check your authenticator app and try again.');
  const secret = await openSecret(env, u.mfa_secret);
  const step = await matchTotp(secret, code);
  if (step !== null) {
    if (u.mfa_last_step && step <= u.mfa_last_step) throw new HttpError(400, 'code_used', 'That code was already used. Wait for the next one.');
    const r = await env.DB.prepare('UPDATE users SET mfa_last_step = ?2 WHERE id = ?1 AND (mfa_last_step IS NULL OR mfa_last_step < ?2)').bind(u.id, step).run();
    if (r.meta.changes !== 1) throw new HttpError(400, 'code_used', 'That code was already used. Wait for the next one.');
    return 'app';
  }
  if (u.mfa_enabled_at && u.mfa_recovery) {
    const h = await hashRecovery(env, code);
    const list = JSON.parse(u.mfa_recovery);
    if (list.includes(h)) {
      const left = list.filter((x) => x !== h);
      const r = await env.DB.prepare('UPDATE users SET mfa_recovery = ?2 WHERE id = ?1 AND mfa_recovery = ?3').bind(u.id, JSON.stringify(left), u.mfa_recovery).run();
      if (r.meta.changes === 1) return 'recovery';
    }
  }
  throw bad;
}

// GET /api/me/mfa
export async function status({ env, user }) {
  const u = await row(env, user.id);
  return json({ enabled: !!u.mfa_enabled_at, recovery_codes_left: u.mfa_recovery ? JSON.parse(u.mfa_recovery).length : 0 });
}

// POST /api/me/mfa/setup -> { secret, otpauth_uri }. Not active until /enable succeeds.
export async function setup({ env, user }) {
  const u = await row(env, user.id);
  if (u.mfa_enabled_at) throw new HttpError(409, 'mfa_already_on', 'Two-step sign-in is already on. Turn it off first to set it up again.');
  const secret = newSecret();
  await env.DB.prepare('UPDATE users SET mfa_secret = ?2 WHERE id = ?1').bind(user.id, await sealSecret(env, secret)).run();
  return json({ secret, otpauth_uri: otpauthUri(secret, u.email || u.phone) });
}

// POST /api/me/mfa/enable { code } -> { recovery_codes } (shown once)
export async function enable({ request, env, user }) {
  const b = await readJson(request);
  const u = await row(env, user.id);
  if (!u.mfa_secret) throw new HttpError(409, 'mfa_not_started', 'Start setup first.');
  if (u.mfa_enabled_at) throw new HttpError(409, 'mfa_already_on', 'Two-step sign-in is already on.');
  await checkCode(env, u, b.code);
  const codes = makeRecoveryCodes();
  const hashes = await Promise.all(codes.map((c) => hashRecovery(env, c)));
  await env.DB.prepare('UPDATE users SET mfa_enabled_at = ?2, mfa_recovery = ?3 WHERE id = ?1').bind(user.id, nowSec(), JSON.stringify(hashes)).run();
  await markSession(env, request);
  return json({ enabled: true, recovery_codes: codes }, 201);
}

// POST /api/me/mfa/verify { code } -> this sign-in is now second-step verified
export async function verify({ request, env, user }) {
  const b = await readJson(request);
  const u = await row(env, user.id);
  if (!u.mfa_enabled_at) throw new HttpError(409, 'mfa_not_on', 'Two-step sign-in is not turned on for this account.');
  const how = await checkCode(env, u, b.code);
  await markSession(env, request);
  return json({ verified: true, used: how });
}

// POST /api/me/mfa/disable { code }
export async function disable({ request, env, user }) {
  const b = await readJson(request);
  const u = await row(env, user.id);
  if (!u.mfa_enabled_at) return json({ enabled: false });
  await checkCode(env, u, b.code);
  await env.DB.prepare('UPDATE users SET mfa_secret = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL, mfa_recovery = NULL WHERE id = ?1').bind(user.id).run();
  return json({ enabled: false });
}

// Used by routes that move money or reach staff tools. Throws 403 mfa_required until this session has passed the second step.
export async function requireSecondStep(env, request, userId, { mandatory = false } = {}) {
  const u = await row(env, userId);
  if (!u.mfa_enabled_at) {
    if (mandatory) throw new HttpError(403, 'mfa_setup_required', 'Turn on two-step sign-in (Account > Security) to do this.');
    return;
  }
  const hash = await hmacHex(env.SECRET_PEPPER, 'session|' + sessionToken(request));
  const s = await env.DB.prepare('SELECT mfa_at FROM sessions WHERE token_hash = ?1').bind(hash).first();
  if (!s || !s.mfa_at || nowSec() - s.mfa_at > MFA_FRESH_SEC) throw new HttpError(403, 'mfa_required', 'Enter your two-step sign-in code to continue.');
}
