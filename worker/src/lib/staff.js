// Who counts as Tap In staff, and the one gate every /api/admin route goes through.
//
// The list is the STAFF_IDENTIFIERS Worker secret: comma-separated emails (or phone numbers). It is a secret, not a var in
// wrangler.jsonc, because this repository is public and the list says who can see people's data. With no list, nobody is staff.
//
// Every refusal looks the same, a plain "not found", so the console cannot be told apart from a page that does not exist.

import { HttpError, newId, nowSec } from './util.js';
import { currentSession } from './session.js';
import { otpMode } from './otp-delivery.js';
import { take } from './limits.js';

export const STAFF_SESSION_MAX = 8 * 3600; // staff sign in again after 8 hours

export function staffList(env) {
  return String(env.STAFF_IDENTIFIERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isStaffUser(env, u) {
  const list = staffList(env);
  if (!list.length || !u) return false;
  return [u.email, u.phone].filter(Boolean).some((x) => list.includes(String(x).toLowerCase()));
}

// Returns the signed-in staff member, or throws "not found".
export async function requireStaff(env, request) {
  const nope = new HttpError(404, 'not_found', 'Not found.');
  if (!env.SECRET_PEPPER || !staffList(env).length) throw nope;
  // An email or phone number is only proven to belong to its owner when sign-in is verified (an emailed link or a delivered code).
  // In demo mode the code is shown on screen, so anyone could claim any address: staff access stays off.
  if (otpMode(env) === 'demo') throw nope;
  const s = await currentSession(env, request);
  if (!s || !isStaffUser(env, s)) throw nope;
  if (nowSec() - s.session_at > STAFF_SESSION_MAX) throw nope;
  if (!(await take(env.DB, 'admin:' + s.id, 900, 900))) throw new HttpError(429, 'rate_limited', 'Slow down for a moment.');
  return s;
}

// One line in the audit log. `detail` is small structured context, never a secret.
export async function audit(env, staff, action, { type = null, id = null, reason = null, detail = null } = {}) {
  await env.DB.prepare(
    'INSERT INTO audit_log (id, at, staff_id, staff_identifier, action, target_type, target_id, reason, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
  )
    .bind(newId(14), nowSec(), staff.id, staff.email || staff.phone || staff.id, action, type, id, reason, detail ? JSON.stringify(detail) : null)
    .run();
}
