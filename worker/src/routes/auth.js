import { HttpError, cleanText, hmacHex, newId, nowSec, parseIdentifier, safeEqual, sha256Base64url } from '../lib/util.js';
import { clientIp, json, readJson } from '../lib/http.js';
import { hashOtp, makeOtp } from '../lib/codes.js';
import { deliverOtp, isDemo, isFirebase } from '../lib/otp-delivery.js';
import { completeSignIn, sendSignInLink } from '../lib/firebase.js';
import { isFull, record, take } from '../lib/limits.js';
import { endSession, publicUser, startSession } from '../lib/session.js';

const OTP_TTL = 600; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const APP_LOGIN_TTL = 600; // the note the browser leaves for the phone app lasts 10 minutes
const APP_TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

// An optional challenge from the phone app. Absent is fine; present but malformed is refused rather than ignored.
function appChallenge(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !APP_TOKEN.test(v)) throw new HttpError(400, 'invalid_app_challenge', 'Start signing in again from the app.');
  return v;
}
const appLoginHash = (env, challenge) => hmacHex(env.SECRET_PEPPER, 'applogin|' + challenge);

// POST /api/auth/otp/request  { identifier }
// Same response whether or not the person already has an account, so this cannot be used to find out who is registered.
export async function otpRequest({ request, env }) {
  const body = await readJson(request);
  const id = parseIdentifier(body.identifier);
  if (!id) throw new HttpError(400, 'invalid_identifier', 'Enter a valid phone number or email address.');

  appChallenge(body.app_challenge);
  const ip = clientIp(request);
  const ok =
    (await take(env.DB, 'otp:id:' + id.value, 3, 900)) && (await take(env.DB, 'otp:ip:' + ip, 12, 900));
  if (!ok) throw new HttpError(429, 'rate_limited', 'Too many codes requested. Wait a few minutes and try again.');

  if (isFirebase(env)) {
    if (id.kind !== 'email') {
      throw new HttpError(400, 'email_only', 'Sign in with your email address for now. Phone sign-in is coming.');
    }
    // From the phone app the challenge rides in the link, so the browser that opens it can leave a note for the app.
    const ac = appChallenge(body.app_challenge);
    await sendSignInLink(env, id.value, new URL(request.url).origin + '/signin/' + (ac ? '?ac=' + ac : ''));
    return json({ ok: true, channel: 'email-link', expires_in: 3600 });
  }

  const now = nowSec();
  const code = makeOtp();
  await env.DB.batch([
    // Only the newest code works.
    env.DB.prepare('UPDATE otps SET consumed_at = ?1 WHERE identifier = ?2 AND consumed_at IS NULL').bind(now, id.value),
    env.DB.prepare(
      'INSERT INTO otps (id, identifier, code_hash, attempts, expires_at, created_at) VALUES (?1, ?2, ?3, 0, ?4, ?5)'
    ).bind(newId(16), id.value, await hashOtp(env.SECRET_PEPPER, id.value, code), now + OTP_TTL, now)
  ]);

  await deliverOtp(env, { kind: id.kind, to: id.value, code });

  const out = { ok: true, channel: id.kind === 'email' ? 'email' : 'sms', expires_in: OTP_TTL };
  if (isDemo(env)) out.dev_code = code;
  return json(out);
}

// POST /api/auth/otp/verify  { identifier, code }
// A correct code signs the person in, creating their account the first time.
export async function otpVerify({ request, env }) {
  const body = await readJson(request);
  const id = parseIdentifier(body.identifier);
  const code = String(body.code ?? '').replace(/\D/g, '');
  if (!id || code.length !== 6) throw new HttpError(400, 'invalid_code', 'Enter the 6-digit code.');

  const ip = clientIp(request);
  if (!(await take(env.DB, 'verify:ip:' + ip, 40, 900))) {
    throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  }

  const now = nowSec();
  const row = await env.DB.prepare(
    'SELECT id, code_hash FROM otps WHERE identifier = ?1 AND consumed_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1'
  )
    .bind(id.value, now)
    .first();
  const wrong = new HttpError(400, 'code_invalid', 'That code is wrong or has expired. Request a new one.');
  if (!row) throw wrong;

  // Count the attempt before comparing, so parallel guesses cannot beat the limit.
  const attempt = await env.DB.prepare(
    'UPDATE otps SET attempts = attempts + 1 WHERE id = ?1 AND attempts < ?2 AND consumed_at IS NULL'
  )
    .bind(row.id, OTP_MAX_ATTEMPTS)
    .run();
  if (attempt.meta.changes !== 1) {
    throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Request a new code.');
  }

  const expected = await hashOtp(env.SECRET_PEPPER, id.value, code);
  if (!safeEqual(expected, row.code_hash)) throw wrong;

  // Single use, even under a race: only one request can flip consumed_at.
  const used = await env.DB.prepare('UPDATE otps SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL')
    .bind(now, row.id)
    .run();
  if (used.meta.changes !== 1) throw wrong;

  return signInUser(env, request, id, now);
}

// Finds or creates the account for a verified identifier and starts a session.
async function signInUser(env, request, id, now, appChallengeValue = null) {
  const column = id.kind === 'email' ? 'email' : 'phone';
  const made = await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, ${column}, name, created_at) VALUES (?1, ?2, NULL, ?3)`
  )
    .bind(newId(12), id.value, now)
    .run();
  const user = await env.DB.prepare(`SELECT id, phone, email, name FROM users WHERE ${column} = ?1`)
    .bind(id.value)
    .first();

  const setCookie = await startSession(env, request, user.id);
  const out = { user: publicUser(user), is_new: made.meta.changes === 1 };
  if (appChallengeValue) {
    // The link was asked for by the phone app. Leave a note it can collect. The first note for a challenge wins: nobody can
    // swap in another account's note while it is still valid. Only an expired note is replaced (someone retrying).
    await env.DB.prepare(
      `INSERT INTO app_logins (challenge_hash, user_id, created_at, expires_at, redeemed_at) VALUES (?1, ?2, ?3, ?4, NULL)
       ON CONFLICT (challenge_hash) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at,
         expires_at = excluded.expires_at, redeemed_at = NULL
       WHERE app_logins.expires_at <= excluded.created_at`
    )
      .bind(await appLoginHash(env, appChallengeValue), user.id, now, now + APP_LOGIN_TTL)
      .run();
    out.app_handoff = true;
  }
  return json(out, 200, { 'Set-Cookie': setCookie });
}

// POST /api/auth/email-link/complete  { email, oobCode }
// The page the emailed link opens sends the one-time code here. Google confirms it; we never trust the browser's word.
export async function emailLinkComplete({ request, env }) {
  if (!isFirebase(env)) throw new HttpError(404, 'not_found', 'Not found.');
  const body = await readJson(request);
  const id = parseIdentifier(body.email);
  const oob = String(body.oobCode ?? '');
  const ac = appChallenge(body.app_challenge);
  if (!id || id.kind !== 'email' || !oob || oob.length > 300) {
    throw new HttpError(400, 'link_invalid', 'That sign-in link is not valid. Request a new one.');
  }
  if (!(await take(env.DB, 'verify:ip:' + clientIp(request), 40, 900))) {
    throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  }
  const confirmed = await completeSignIn(env, id.value, oob);
  if (confirmed !== id.value) {
    throw new HttpError(400, 'email_mismatch', 'That link was sent to a different email address.');
  }
  return signInUser(env, request, id, nowSec(), ac);
}

// POST /api/auth/app/redeem  { verifier }
// The phone app collects the note the browser left, proving it is the app that asked: only it holds the verifier whose
// SHA-256 is the challenge. A wrong, expired or already used verifier all look the same ("not yet"), and the secret is 256
// bits, so guessing it is not feasible.
export async function appRedeem({ request, env }) {
  const body = await readJson(request);
  const verifier = String(body.verifier ?? '');
  if (!APP_TOKEN.test(verifier)) throw new HttpError(400, 'invalid_verifier', 'Start signing in again from the app.');
  const now = nowSec();
  const hash = await appLoginHash(env, await sha256Base64url(verifier));
  // Only one request can flip redeemed_at, so the note works once even if two arrive together.
  const taken = await env.DB.prepare(
    'UPDATE app_logins SET redeemed_at = ?1 WHERE challenge_hash = ?2 AND redeemed_at IS NULL AND expires_at > ?1'
  )
    .bind(now, hash)
    .run();
  if (taken.meta.changes !== 1) return json({ pending: true });
  const user = await env.DB.prepare(
    'SELECT u.id, u.phone, u.email, u.name FROM app_logins a JOIN users u ON u.id = a.user_id WHERE a.challenge_hash = ?1'
  )
    .bind(hash)
    .first();
  if (!user) return json({ pending: true });
  const setCookie = await startSession(env, request, user.id);
  return json({ user: publicUser(user), is_new: !user.name }, 200, { 'Set-Cookie': setCookie });
}

export async function logout({ request, env }) {
  const setCookie = await endSession(env, request);
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie });
}

// PATCH /api/me  { name }
export async function patchMe({ request, env, user }) {
  const body = await readJson(request);
  const name = cleanText(body.name, 'name', { min: 1, max: 60 });
  await env.DB.prepare('UPDATE users SET name = ?1 WHERE id = ?2').bind(name, user.id).run();
  return json({ user: publicUser({ ...user, name }) });
}

// Used by claim and gate routes to count a failure against a bucket.
export const noteFailure = (db, bucket) => record(db, bucket);
export const tooManyFailures = (db, bucket, limit, windowSec) => isFull(db, bucket, limit, windowSec);
