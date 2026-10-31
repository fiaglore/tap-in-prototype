// The Tap In team's support console API. Every route here is behind requireStaff (src/lib/staff.js): signed in with a verified
// address on the STAFF_IDENTIFIERS list, signed in within the last 8 hours, otherwise a plain "not found".
//
// Reading a person's page is logged. Changing anything needs a written reason, and is logged with who did it, to whom and why.
// The team cannot suspend or delete each other. Nothing here can sign in as someone else or change what email an account uses.

import { HttpError, cleanText, nowSec, normaliseCode } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { hashInvite } from '../lib/codes.js';
import { STAFF_SESSION_MAX, audit, isStaffUser, staffList } from '../lib/staff.js';
import { assertCanDelete, deleteAccountData } from './auth.js';
import { sendSignInLink } from '../lib/firebase.js';
import { isFirebase, otpMode } from '../lib/otp-delivery.js';
import { paymentsOff } from '../lib/money.js';
import { take } from '../lib/limits.js';

// ---- small helpers ---------------------------------------------------------------------------------------------------
const reasonOf = (body) => {
  const r = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (r.length < 5 || r.length > 300) throw new HttpError(400, 'reason_required', 'Write a short reason (5 to 300 characters). It goes in the audit log.');
  return r;
};
const isDeleted = (u) => !!u.email && u.email.endsWith('@deleted.invalid');
const shapeUser = (u) => ({ id: u.id, name: u.name || null, email: u.email || null, phone: u.phone || null, identifier: u.email || u.phone, created_at: u.created_at, suspended_at: u.suspended_at || null, deleted: isDeleted(u) });
async function loadUser(env, id) {
  const u = await env.DB.prepare('SELECT id, phone, email, name, created_at, suspended_at FROM users WHERE id = ?1').bind(String(id)).first();
  if (!u) throw new HttpError(404, 'user_not_found', 'No such person.');
  return u;
}
const likeOf = (q) => '%' + q.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
const needQuery = (url) => {
  const q = String(url.searchParams.get('q') || '').trim();
  if (q.length < 2) throw new HttpError(400, 'query_too_short', 'Type at least two characters.');
  return q.slice(0, 80);
};

// ---- who am I, and the state of things -------------------------------------------------------------------------------
// GET /api/admin/me
export async function adminMe({ env, user }) {
  return json({ staff: { id: user.id, name: user.name || null, identifier: user.email || user.phone }, session_started: user.session_at, session_expires: user.session_at + STAFF_SESSION_MAX, team_size: staffList(env).length });
}

// GET /api/admin/overview
export async function overview({ env }) {
  const now = nowSec();
  const day = now - 86400;
  const real = "(email IS NULL OR email NOT LIKE '%@deleted.invalid')";
  const one = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const [users, fresh, suspended, passes, events, listed, scans, reasons, attempts, limited] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM users WHERE ${real}`),
    one(`SELECT COUNT(*) AS n FROM users WHERE ${real} AND created_at > ?1`, now - 7 * 86400),
    one('SELECT COUNT(*) AS n FROM users WHERE suspended_at IS NOT NULL'),
    one("SELECT COUNT(*) AS n FROM passes WHERE status = 'active'"),
    one("SELECT COUNT(*) AS n FROM events WHERE kind = 'event' AND (starts_at IS NULL OR starts_at >= ?1)", now - 12 * 3600),
    one("SELECT COUNT(*) AS n FROM events WHERE kind = 'event' AND listed = 1 AND (starts_at IS NULL OR starts_at >= ?1)", now - 12 * 3600),
    one("SELECT COALESCE(SUM(result = 'granted'), 0) AS granted, COALESCE(SUM(result = 'denied'), 0) AS denied FROM scans WHERE at > ?1", day),
    env.DB.prepare("SELECT COALESCE(reason, 'unknown') AS reason, COUNT(*) AS n FROM scans WHERE result = 'denied' AND at > ?1 GROUP BY reason ORDER BY n DESC LIMIT 6").bind(day).all(),
    one("SELECT COUNT(*) AS n FROM rate_events WHERE bucket LIKE 'otp:ip:%' AND at > ?1", now - 3600),
    one("SELECT COUNT(*) AS n FROM (SELECT bucket FROM rate_events WHERE bucket LIKE 'otp:id:%' AND at > ?1 GROUP BY bucket HAVING COUNT(*) >= 3)", now - 900)
  ]);
  return json({
    now,
    people: { total: users.n, new_7d: fresh.n, suspended: suspended.n },
    passes_active: passes.n,
    events: { upcoming: events.n, listed: listed.n },
    entries_24h: { granted: scans.granted, denied: scans.denied, denied_reasons: reasons.results },
    sign_in: { requests_last_hour: attempts.n, people_rate_limited_now: limited.n },
    config: { otp_mode: otpMode(env), payments: !paymentsOff(env), firebase_key_set: !!env.FIREBASE_API_KEY, team_size: staffList(env).length }
  });
}

// ---- people ------------------------------------------------------------------------------------------------------------
// GET /api/admin/users?q=   by name, email, phone or id
export async function searchUsers({ env, url }) {
  const q = needQuery(url);
  const phone = q.replace(/\D/g, '').replace(/^0+/, '');
  const rows = (
    await env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.created_at, u.suspended_at,
              (SELECT COUNT(*) FROM passes p WHERE p.user_id = u.id) AS passes
       FROM users u
       WHERE lower(COALESCE(u.email, '')) LIKE ?1 ESCAPE '\\' OR lower(COALESCE(u.name, '')) LIKE ?1 ESCAPE '\\' OR u.id = ?2
          OR (?3 != '' AND COALESCE(u.phone, '') LIKE ?4 ESCAPE '\\')
       ORDER BY u.created_at DESC LIMIT 25`
    )
      .bind(likeOf(q), q, phone.length >= 6 ? phone : '', '%' + phone + '%')
      .all()
  ).results;
  return json({ people: rows.map((u) => ({ ...shapeUser(u), passes: u.passes })) });
}

async function profileOf(env, u, { full = false } = {}) {
  const now = nowSec();
  const cap = full ? 1000 : 25;
  const mine = [u.email, u.phone].filter(Boolean);
  const [sessions, passes, invites, owned, wallet, photo, scans, trail, views] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM sessions WHERE user_id = ?1 AND expires_at > ?2').bind(u.id, now).first(),
    env.DB.prepare(
      `SELECT p.id, p.status, p.created_at, p.expires_at, e.id AS event_id, e.name AS event_name, e.starts_at, t.name AS tier,
              (SELECT COUNT(*) FROM scans s WHERE s.pass_id = p.id AND s.result = 'granted') AS granted,
              (SELECT COUNT(*) FROM scans s WHERE s.pass_id = p.id AND s.result = 'denied') AS denied,
              (SELECT MAX(s.at) FROM scans s WHERE s.pass_id = p.id) AS last_scan
       FROM passes p JOIN events e ON e.id = p.event_id JOIN tiers t ON t.id = p.tier_id
       WHERE p.user_id = ?1 ORDER BY p.created_at DESC LIMIT ?2`
    ).bind(u.id, full ? 1000 : 100).all(),
    mine.length
      ? env.DB.prepare(
          `SELECT i.id, i.status, i.code_hint, i.created_at, e.name AS event_name FROM invites i JOIN events e ON e.id = i.event_id
           WHERE i.bound_identifier IN (${mine.map((_, i) => '?' + (i + 1)).join(',')}) ORDER BY i.created_at DESC LIMIT 50`
        ).bind(...mine).all()
      : Promise.resolve({ results: [] }),
    env.DB.prepare('SELECT id, name, starts_at, listed, kind FROM events WHERE owner_id = ?1 ORDER BY created_at DESC LIMIT 50').bind(u.id).all(),
    env.DB.prepare('SELECT balance_kobo FROM wallets WHERE user_id = ?1').bind(u.id).first(),
    env.DB.prepare('SELECT updated_at FROM user_photos WHERE user_id = ?1').bind(u.id).first(),
    env.DB.prepare(
      `SELECT s.at, s.result, s.reason, e.name AS event_name, z.name AS zone FROM scans s JOIN passes p ON p.id = s.pass_id JOIN events e ON e.id = s.event_id
       LEFT JOIN zones z ON z.id = s.zone_id WHERE p.user_id = ?1 ORDER BY s.at DESC LIMIT ?2`
    ).bind(u.id, cap).all(),
    env.DB.prepare(
      // What the team changed for this person. Opening the page is logged too, but it would crowd this out, so it is only counted.
      `SELECT at, staff_identifier, action, reason FROM audit_log WHERE action != 'user.view' AND ((target_type = 'user' AND target_id = ?1) OR json_extract(detail, '$.user_id') = ?1) ORDER BY at DESC, rowid DESC LIMIT 15`
    ).bind(u.id).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.view' AND target_type = 'user' AND target_id = ?1 AND at > ?2").bind(u.id, now - 30 * 86400).first()
  ]);
  return {
    user: shapeUser(u),
    sessions: { active: sessions.n, first: sessions.first, last: sessions.last },
    passes: passes.results,
    invites_bound: invites.results,
    events_owned: owned.results.map((e) => ({ ...e, listed: !!e.listed })),
    wallet: wallet ? { balance_kobo: wallet.balance_kobo } : null,
    has_photo: !!photo,
    recent_entries: scans.results,
    audit: trail.results,
    views_30d: views.n
  };
}

// GET /api/admin/users/:id   (opening someone's page is itself logged)
export async function getUser({ env, params, user: staff }) {
  const u = await loadUser(env, params.id);
  await audit(env, staff, 'user.view', { type: 'user', id: u.id });
  const out = await profileOf(env, u);
  out.target_is_staff = isStaffUser(env, u);
  return json(out);
}

// GET /api/admin/users/:id/export   everything we hold about them, for a data request
export async function exportUser({ env, params, user: staff }) {
  const u = await loadUser(env, params.id);
  await audit(env, staff, 'user.export', { type: 'user', id: u.id });
  const data = await profileOf(env, u, { full: true });
  delete data.audit;
  return json({ exported_at: nowSec(), ...data });
}

// POST /api/admin/users/:id/sign-out  { reason }   ends every session, on every device
export async function signOutUser({ request, env, params, user: staff }) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const u = await loadUser(env, params.id);
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1').bind(u.id).first()).n;
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id), env.DB.prepare('DELETE FROM app_logins WHERE user_id = ?1').bind(u.id)]);
  await audit(env, staff, 'user.sign_out', { type: 'user', id: u.id, reason, detail: { sessions_ended: n } });
  return json({ ok: true, sessions_ended: n });
}

// POST /api/admin/users/:id/send-link  { reason }   emails them a fresh sign-in link (it goes to their inbox, never to the team)
export async function sendLink({ request, env, params, user: staff }) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const u = await loadUser(env, params.id);
  if (!isFirebase(env)) throw new HttpError(400, 'not_email_link_mode', 'Sign-in links are only used when sign-in is by emailed link.');
  if (!u.email || isDeleted(u)) throw new HttpError(400, 'no_email', 'This account has no email address to send to.');
  if (u.suspended_at) throw new HttpError(409, 'suspended', 'This account is suspended. Restore it first.');
  if (!(await take(env.DB, 'admin:link:' + u.id, 3, 3600))) throw new HttpError(429, 'rate_limited', 'Three links have already gone to this person in the last hour.');
  await sendSignInLink(env, u.email, new URL(request.url).origin + '/signin/');
  await audit(env, staff, 'user.send_link', { type: 'user', id: u.id, reason });
  return json({ ok: true });
}

// POST /api/admin/users/:id/clear-limits  { reason }   lifts "too many codes requested" for this person
export async function clearLimits({ request, env, params, user: staff }) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const u = await loadUser(env, params.id);
  const buckets = [u.email, u.phone].filter(Boolean).map((x) => 'otp:id:' + x);
  let cleared = 0;
  for (const b of buckets) cleared += (await env.DB.prepare('DELETE FROM rate_events WHERE bucket = ?1').bind(b).run()).meta.changes;
  await audit(env, staff, 'user.clear_limits', { type: 'user', id: u.id, reason, detail: { cleared } });
  return json({ ok: true, cleared });
}

// PATCH /api/admin/users/:id  { name, reason }
export async function renameUser({ request, env, params, user: staff }) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const name = cleanText(body.name, 'name', { min: 1, max: 60 });
  const u = await loadUser(env, params.id);
  if (isDeleted(u)) throw new HttpError(409, 'deleted', 'This account has been deleted.');
  await env.DB.prepare('UPDATE users SET name = ?1 WHERE id = ?2').bind(name, u.id).run();
  await audit(env, staff, 'user.rename', { type: 'user', id: u.id, reason });
  return json({ ok: true, name });
}

function protectStaff(env, u, staff) {
  if (u.id === staff.id) throw new HttpError(400, 'is_you', 'You cannot do this to your own account.');
  if (isStaffUser(env, u)) throw new HttpError(400, 'is_staff', 'This is a member of the team. Ask an engineer to change a team account.');
}

// POST /api/admin/users/:id/suspend  { reason }   cannot sign in; every session ends
export async function suspendUser({ request, env, params, user: staff }) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const u = await loadUser(env, params.id);
  protectStaff(env, u, staff);
  if (isDeleted(u)) throw new HttpError(409, 'deleted', 'This account has been deleted.');
  if (u.suspended_at) throw new HttpError(409, 'already_suspended', 'This account is already suspended.');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET suspended_at = ?1 WHERE id = ?2').bind(nowSec(), u.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM app_logins WHERE user_id = ?1').bind(u.id)
  ]);
  await audit(env, staff, 'user.suspend', { type: 'user', id: u.id, reason });
  return json({ ok: true });
}

// POST /api/admin/users/:id/restore  { reason }
export async function restoreUser({ request, env, params, user: staff }) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const u = await loadUser(env, params.id);
  if (!u.suspended_at) throw new HttpError(409, 'not_suspended', 'This account is not suspended.');
  await env.DB.prepare('UPDATE users SET suspended_at = NULL WHERE id = ?1').bind(u.id).run();
  await audit(env, staff, 'user.restore', { type: 'user', id: u.id, reason });
  return json({ ok: true });
}

// POST /api/admin/users/:id/delete  { confirm: "DELETE", reason }   a deletion request done for them
export async function deleteUser({ request, env, params, user: staff }) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'confirm_required', 'Type DELETE to confirm.');
  const u = await loadUser(env, params.id);
  protectStaff(env, u, staff);
  if (isDeleted(u)) throw new HttpError(409, 'deleted', 'This account has already been deleted.');
  await assertCanDelete(env, u);
  const cancelled = (await env.DB.prepare("SELECT COUNT(*) AS n FROM passes WHERE user_id = ?1 AND status = 'active'").bind(u.id).first()).n;
  await deleteAccountData(env, u);
  await audit(env, staff, 'user.delete', { type: 'user', id: u.id, reason, detail: { passes_cancelled: cancelled } });
  return json({ ok: true, passes_cancelled: cancelled });
}

// ---- passes and invites -----------------------------------------------------------------------------------------------
const setPass = (to) => async ({ request, env, params, user: staff }) => {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const p = await env.DB.prepare('SELECT id, user_id, event_id, status FROM passes WHERE id = ?1').bind(params.id).first();
  if (!p) throw new HttpError(404, 'pass_not_found', 'No such pass.');
  if (p.status === to) throw new HttpError(409, 'no_change', 'The pass is already ' + to + '.');
  await env.DB.prepare('UPDATE passes SET status = ?1 WHERE id = ?2').bind(to, p.id).run();
  await audit(env, staff, to === 'revoked' ? 'pass.revoke' : 'pass.restore', { type: 'pass', id: p.id, reason, detail: { user_id: p.user_id, event_id: p.event_id } });
  return json({ ok: true, status: to });
};
export const revokePass = setPass('revoked');
export const restorePass = setPass('active');

// GET /api/admin/passes/:id/scans   every time the pass was scanned, and what the gate said
export async function passScans({ env, params }) {
  const p = await env.DB.prepare('SELECT id FROM passes WHERE id = ?1').bind(params.id).first();
  if (!p) throw new HttpError(404, 'pass_not_found', 'No such pass.');
  const rows = (
    await env.DB.prepare(
      `SELECT s.at, s.result, s.reason, z.name AS zone FROM scans s LEFT JOIN zones z ON z.id = s.zone_id WHERE s.pass_id = ?1 ORDER BY s.at DESC LIMIT 100`
    ).bind(p.id).all()
  ).results;
  return json({ scans: rows });
}

// POST /api/admin/invites/lookup  { code }   find an invite from the code someone read out (the code is never stored or logged)
export async function lookupInvite({ request, env, user: staff }) {
  const body = await readJson(request);
  const code = normaliseCode(String(body.code || ''));
  if (code.length < 6 || code.length > 60) throw new HttpError(400, 'code_invalid', 'Type the whole invite code.');
  const row = await env.DB.prepare(
    `SELECT i.id, i.status, i.code_hint, i.label, i.bound_identifier, i.expires_at, i.claimed_at, i.created_at,
            e.id AS event_id, e.name AS event_name, e.starts_at, t.name AS tier,
            u.id AS claimed_by, u.name AS claimed_name, u.email AS claimed_email, u.phone AS claimed_phone,
            (SELECT p.id FROM passes p WHERE p.invite_id = i.id) AS pass_id, (SELECT p.status FROM passes p WHERE p.invite_id = i.id) AS pass_status
     FROM invites i JOIN events e ON e.id = i.event_id JOIN tiers t ON t.id = i.tier_id LEFT JOIN users u ON u.id = i.claimed_by
     WHERE i.code_hash = ?1`
  ).bind(await hashInvite(env.SECRET_PEPPER, code)).first();
  await audit(env, staff, 'invite.lookup', { type: 'invite', id: row ? row.id : null, detail: { found: !!row } });
  if (!row) return json({ found: false });
  return json({ found: true, invite: row });
}

// POST /api/admin/invites/:id/revoke  { reason }   an unused invite only; a claimed one is cancelled by revoking its pass
export async function revokeInvite({ request, env, params, user: staff }) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const i = await env.DB.prepare('SELECT id, status, event_id FROM invites WHERE id = ?1').bind(params.id).first();
  if (!i) throw new HttpError(404, 'invite_not_found', 'No such invite.');
  if (i.status === 'claimed') throw new HttpError(409, 'already_claimed', 'This invite was already claimed. Revoke the pass instead.');
  if (i.status === 'revoked') throw new HttpError(409, 'no_change', 'This invite is already revoked.');
  await env.DB.prepare("UPDATE invites SET status = 'revoked' WHERE id = ?1").bind(i.id).run();
  await audit(env, staff, 'invite.revoke', { type: 'invite', id: i.id, reason, detail: { event_id: i.event_id } });
  return json({ ok: true });
}

// ---- events ---------------------------------------------------------------------------------------------------------------
// GET /api/admin/events?q=   by name, id or the organiser's email
export async function searchEvents({ env, url }) {
  const q = needQuery(url);
  const rows = (
    await env.DB.prepare(
      `SELECT e.id, e.name, e.kind, e.venue, e.city, e.starts_at, e.listed, e.created_at, u.id AS owner_id, u.name AS owner_name, u.email AS owner_email
       FROM events e JOIN users u ON u.id = e.owner_id
       WHERE lower(e.name) LIKE ?1 ESCAPE '\\' OR e.id = ?2 OR lower(COALESCE(u.email, '')) LIKE ?1 ESCAPE '\\'
       ORDER BY e.created_at DESC LIMIT 25`
    ).bind(likeOf(q), q).all()
  ).results;
  return json({ events: rows.map((e) => ({ ...e, listed: !!e.listed })) });
}

// GET /api/admin/events/:id
export async function getEvent({ env, params }) {
  const e = await env.DB.prepare(
    `SELECT e.id, e.name, e.kind, e.venue, e.city, e.starts_at, e.listed, e.secure_qr, e.require_photo, e.created_at, e.gate_key_hint,
            u.id AS owner_id, u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone
     FROM events e JOIN users u ON u.id = e.owner_id WHERE e.id = ?1`
  ).bind(params.id).first();
  if (!e) throw new HttpError(404, 'event_not_found', 'No such event.');
  const day = nowSec() - 86400;
  const [tiers, passes, scans, reasons] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.name, t.price_kobo, t.capacity,
              (SELECT COUNT(*) FROM invites i WHERE i.tier_id = t.id AND i.status != 'revoked') AS issued,
              (SELECT COUNT(*) FROM invites i WHERE i.tier_id = t.id AND i.status = 'claimed') AS claimed
       FROM tiers t WHERE t.event_id = ?1 ORDER BY t.sort, t.name`
    ).bind(e.id).all(),
    env.DB.prepare("SELECT COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'revoked'), 0) AS revoked FROM passes WHERE event_id = ?1").bind(e.id).first(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(result = 'granted'), 0) AS granted, COALESCE(SUM(result = 'denied'), 0) AS denied, COALESCE(SUM(result = 'granted' AND at > ?2), 0) AS granted_24h, COALESCE(SUM(result = 'denied' AND at > ?2), 0) AS denied_24h FROM scans WHERE event_id = ?1"
    ).bind(e.id, day).first(),
    env.DB.prepare("SELECT COALESCE(reason, 'unknown') AS reason, COUNT(*) AS n FROM scans WHERE event_id = ?1 AND result = 'denied' GROUP BY reason ORDER BY n DESC LIMIT 6").bind(e.id).all()
  ]);
  return json({
    event: { ...e, listed: !!e.listed, secure_qr: !!e.secure_qr, require_photo: !!e.require_photo },
    tiers: tiers.results,
    passes,
    entries: { ...scans, denied_reasons: reasons.results }
  });
}

// POST /api/admin/events/:id/listed  { listed, reason }   take an event off the public Events page, or put it back
export async function setListed({ request, env, params, user: staff }) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  if (typeof body.listed !== 'boolean') throw new HttpError(400, 'listed_required', 'Say whether the event should be listed.');
  const e = await env.DB.prepare('SELECT id, listed, kind FROM events WHERE id = ?1').bind(params.id).first();
  if (!e) throw new HttpError(404, 'event_not_found', 'No such event.');
  if (!!e.listed === body.listed) throw new HttpError(409, 'no_change', 'The event is already ' + (body.listed ? 'listed' : 'unlisted') + '.');
  await env.DB.prepare('UPDATE events SET listed = ?1 WHERE id = ?2').bind(body.listed ? 1 : 0, e.id).run();
  await audit(env, staff, body.listed ? 'event.relist' : 'event.unlist', { type: 'event', id: e.id, reason });
  return json({ ok: true, listed: body.listed });
}

// ---- the audit log -----------------------------------------------------------------------------------------------------------
// GET /api/admin/audit?before=<seq>&target=<id>
export async function auditLog({ env, url }) {
  const before = Number(url.searchParams.get('before')) || null;
  const target = url.searchParams.get('target') || null;
  const rows = (
    await env.DB.prepare(
      `SELECT rowid AS seq, at, staff_identifier, action, target_type, target_id, reason, detail FROM audit_log
       WHERE (?1 IS NULL OR rowid < ?1) AND (?2 IS NULL OR target_id = ?2 OR json_extract(detail, '$.user_id') = ?2)
       ORDER BY rowid DESC LIMIT 51`
    ).bind(before, target).all()
  ).results;
  const more = rows.length > 50;
  const page = rows.slice(0, 50).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  return json({ entries: page, next: more ? page[page.length - 1].seq : null });
}
