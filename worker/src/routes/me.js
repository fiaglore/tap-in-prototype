import { HttpError, normaliseCode, newId, nowSec } from '../lib/util.js';
import { clientIp, json, readJson } from '../lib/http.js';
import { LIVE_GRACE, LIVE_STEP, hashInvite, liveToken, passToken } from '../lib/codes.js';
import { isFull, record } from '../lib/limits.js';
import { publicUser } from '../lib/session.js';

async function loadPasses(env, userId, onlyId) {
  const filter = onlyId ? 'AND p.id = ?2' : '';
  const bind = onlyId ? [userId, onlyId] : [userId];
  const passes = (
    await env.DB.prepare(
      `SELECT p.id, p.status, p.created_at, p.expires_at, e.kind, e.secure_qr, e.require_photo, e.id AS event_id, e.name AS event_name, e.venue, e.city, e.starts_at,
              t.name AS tier_name, p.tier_id
       FROM passes p JOIN events e ON e.id = p.event_id JOIN tiers t ON t.id = p.tier_id
       WHERE p.user_id = ?1 ${filter}
       ORDER BY COALESCE(e.starts_at, 9999999999), p.created_at`
    )
      .bind(...bind)
      .all()
  ).results;

  const zoneRows = (
    await env.DB.prepare(
      `SELECT p.id AS pass_id, z.name FROM passes p
       JOIN tier_zones tz ON tz.tier_id = p.tier_id JOIN zones z ON z.id = tz.zone_id
       WHERE p.user_id = ?1 ${filter} ORDER BY z.sort, z.name`
    )
      .bind(...bind)
      .all()
  ).results;

  const zonesByPass = {};
  for (const r of zoneRows) (zonesByPass[r.pass_id] ||= []).push(r.name);

  return Promise.all(
    passes.map(async (p) => ({
      id: p.id,
      status: p.status,
      expires_at: p.expires_at,
      // On a secure-QR event the permanent code is never handed out; the phone asks for a live one.
      token: p.secure_qr ? null : await passToken(env.SECRET_PEPPER, p.id),
      live: !!p.secure_qr,
      event: { id: p.event_id, kind: p.kind, secure_qr: !!p.secure_qr, require_photo: !!p.require_photo, name: p.event_name, venue: p.venue, city: p.city, starts_at: p.starts_at },
      tier: p.tier_name,
      zones: zonesByPass[p.id] || [],
      created_at: p.created_at
    }))
  );
}

// GET /api/me  -> who I am, my passes, and invites that were issued to my phone or email
export async function me({ env, user }) {
  const now = nowSec();
  const waiting = (
    await env.DB.prepare(
      `SELECT i.id, e.kind, e.name AS event_name, e.venue, e.city, e.starts_at, t.name AS tier_name
       FROM invites i JOIN events e ON e.id = i.event_id JOIN tiers t ON t.id = i.tier_id
       WHERE i.bound_identifier IN (?1, ?2) AND i.status = 'unused' AND (i.expires_at IS NULL OR i.expires_at > ?3)
       ORDER BY COALESCE(e.starts_at, 9999999999)`
    )
      .bind(user.phone || '', user.email || '', now)
      .all()
  ).results.map((w) => ({
    id: w.id,
    tier: w.tier_name,
    event: { kind: w.kind, name: w.event_name, venue: w.venue, city: w.city, starts_at: w.starts_at }
  }));

  const ph = await env.DB.prepare('SELECT 1 AS x FROM user_photos WHERE user_id = ?1').bind(user.id).first();
  return json({ user: { ...publicUser(user), has_photo: !!ph }, passes: await loadPasses(env, user.id), waiting });
}

// GET /api/me/history  -> every time one of my passes was scanned
export async function history({ env, user }) {
  const rows = (
    await env.DB.prepare(
      `SELECT s.id, s.result, s.reason, s.at, e.name AS event_name, z.name AS zone
       FROM scans s JOIN passes p ON p.id = s.pass_id JOIN events e ON e.id = s.event_id
       LEFT JOIN zones z ON z.id = s.zone_id
       WHERE p.user_id = ?1 ORDER BY s.at DESC, s.id DESC LIMIT 50`
    )
      .bind(user.id)
      .all()
  ).results;
  return json({ scans: rows });
}

const CLAIM_FAIL_USER = 8; // wrong codes per user per hour
const CLAIM_FAIL_IP = 40; // wrong codes per address per hour

// POST /api/claim  { code }  or  { invite_id }  (for an invite issued to my own phone or email)
export async function claim({ request, env, user }) {
  const body = await readJson(request);
  const ip = clientIp(request);
  const userBucket = 'claim:user:' + user.id;
  const ipBucket = 'claim:ip:' + ip;
  if ((await isFull(env.DB, userBucket, CLAIM_FAIL_USER, 3600)) || (await isFull(env.DB, ipBucket, CLAIM_FAIL_IP, 3600))) {
    throw new HttpError(429, 'rate_limited', 'Too many wrong codes. Try again in an hour.');
  }
  const fail = async (status, code, message) => {
    await record(env.DB, userBucket);
    await record(env.DB, ipBucket);
    throw new HttpError(status, code, message);
  };

  let invite = null;
  if (typeof body.invite_id === 'string') {
    invite = await env.DB.prepare('SELECT * FROM invites WHERE id = ?1').bind(body.invite_id.slice(0, 40)).first();
    // Claiming by id is only for invites issued to this person's own verified phone or email.
    if (invite && !(invite.bound_identifier && [user.phone, user.email].includes(invite.bound_identifier))) invite = null;
  } else {
    const code = normaliseCode(body.code);
    if (code.length < 12 || code.length > 40) await fail(400, 'invalid_code', 'Enter the full invite code.');
    const hash = await hashInvite(env.SECRET_PEPPER, code);
    invite = await env.DB.prepare('SELECT * FROM invites WHERE code_hash = ?1').bind(hash).first();
  }

  if (!invite) await fail(404, 'invalid_code', 'That code is not valid. Check it and try again.');
  const now = nowSec();
  if (invite.status === 'revoked') await fail(410, 'revoked', 'This invite was cancelled by the organiser.');
  if (invite.status === 'claimed') {
    if (invite.claimed_by === user.id) throw new HttpError(409, 'already_yours', 'You already added this pass.');
    await fail(409, 'used', 'This code has already been used.');
  }
  if (invite.expires_at && invite.expires_at <= now) await fail(410, 'expired', 'This invite has expired.');
  if (invite.bound_identifier && ![user.phone, user.email].includes(invite.bound_identifier)) {
    await fail(403, 'wrong_holder', 'This invite was issued to someone else.');
  }

  // Some events want a selfie on every pass. Ask for it before the invite is used up.
  const need = await env.DB.prepare(
    'SELECT e.require_photo, EXISTS (SELECT 1 FROM user_photos ph WHERE ph.user_id = ?2) AS has FROM events e WHERE e.id = ?1'
  )
    .bind(invite.event_id, user.id)
    .first();
  if (need && need.require_photo && !need.has) {
    throw new HttpError(428, 'photo_required', 'This event needs a photo of you so door staff can match it to your face. Add one to continue.');
  }

  // Claim atomically. Both statements run in one transaction; the insert only happens while the invite
  // is still unused, so two people submitting the same code at once cannot both get a pass.
  const passId = newId(10);
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO passes (id, event_id, tier_id, user_id, invite_id, status, created_at, expires_at)
         SELECT ?1, event_id, tier_id, ?2, id, 'active', ?3, access_until FROM invites
         WHERE id = ?4 AND status = 'unused' AND (expires_at IS NULL OR expires_at > ?3)`
      ).bind(passId, user.id, now, invite.id),
      env.DB.prepare(
        `UPDATE invites SET status = 'claimed', claimed_by = ?1, claimed_at = ?2 WHERE id = ?3 AND status = 'unused'`
      ).bind(user.id, now, invite.id)
    ]);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err?.message))) throw new HttpError(409, 'used', 'This code has already been used.');
    throw err;
  }
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'used', 'This code has already been used.');

  const [pass] = await loadPasses(env, user.id, passId);
  return json({ pass }, 201);
}

// GET /api/me/passes/:id/live  -> a pass code that stays valid for about a minute and a half.
// The app asks again every 20 seconds, so a screenshot of the QR is useless almost at once.
export async function liveCode({ env, user, params }) {
  const p = await env.DB.prepare("SELECT id, status, expires_at FROM passes WHERE id = ?1 AND user_id = ?2")
    .bind(String(params.id).slice(0, 40), user.id)
    .first();
  if (!p) throw new HttpError(404, 'not_found', 'Pass not found.');
  const now = nowSec();
  if (p.status !== 'active' || (p.expires_at && p.expires_at <= now)) throw new HttpError(409, 'pass_not_active', 'This pass is not active.');
  return json({ token: await liveToken(env.SECRET_PEPPER, p.id, now), valid_for: LIVE_STEP * (LIVE_GRACE + 1), refresh_in: 20 });
}
