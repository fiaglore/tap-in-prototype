// Tap In for Business: departments and employee IDs, visitor check-out, the "who is on site" emergency report,
// the incident log, and team access (who besides the owner can see or act on an office).
import { HttpError, cleanText, newId, nowSec, parseIdentifier } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { accessibleEvent, ownedEvent } from './events.js';

const office = (ev) => { if (ev.kind !== 'workplace') throw new HttpError(400, 'not_an_office', 'This is for Tap In for Business offices.'); return ev; };
const MAX_DEPARTMENTS = 60;
const MAX_MEMBERS = 30;
const who = (u) => u.email || u.phone || u.id;

// ---- Departments (owner) ------------------------------------------------------------------------------
// GET /api/events/:id/departments
export async function listDepartments({ env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id));
  const rows = (await env.DB.prepare(
    `SELECT d.id, d.name, (SELECT COUNT(*) FROM invites i WHERE i.department_id = d.id AND i.status != 'revoked') AS people
     FROM departments d WHERE d.event_id = ?1 ORDER BY d.name COLLATE NOCASE`
  ).bind(ev.id).all()).results;
  return json({ departments: rows });
}
// POST /api/events/:id/departments { name }
export async function createDepartment({ request, env, user, params }) {
  const ev = office(await ownedEvent(env, user, params.id));
  const name = cleanText((await readJson(request)).name, 'department name', { max: 50 });
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM departments WHERE event_id = ?1').bind(ev.id).first()).n;
  if (n >= MAX_DEPARTMENTS) throw new HttpError(400, 'department_limit', `You can have up to ${MAX_DEPARTMENTS} departments.`);
  const id = newId(10);
  try { await env.DB.prepare('INSERT INTO departments (id, event_id, name, created_at) VALUES (?1, ?2, ?3, ?4)').bind(id, ev.id, name, nowSec()).run(); } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, 'department_exists', 'You already have a department with that name.');
    throw e;
  }
  return json({ department: { id, name, people: 0 } }, 201);
}
// PATCH /api/events/:id/departments/:depId { name }
export async function renameDepartment({ request, env, user, params }) {
  const ev = office(await ownedEvent(env, user, params.id));
  const name = cleanText((await readJson(request)).name, 'department name', { max: 50 });
  try {
    const r = await env.DB.prepare('UPDATE departments SET name = ?3 WHERE id = ?1 AND event_id = ?2').bind(String(params.depId).slice(0, 40), ev.id, name).run();
    if (r.meta.changes !== 1) throw new HttpError(404, 'not_found', 'Department not found.');
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, 'department_exists', 'You already have a department with that name.');
    throw e;
  }
  return json({ ok: true });
}
// DELETE /api/events/:id/departments/:depId  (people in it become "no department")
export async function deleteDepartment({ env, user, params }) {
  const ev = office(await ownedEvent(env, user, params.id));
  const id = String(params.depId).slice(0, 40);
  const [, r] = await env.DB.batch([
    env.DB.prepare('UPDATE invites SET department_id = NULL WHERE department_id = ?1 AND event_id = ?2').bind(id, ev.id),
    env.DB.prepare('DELETE FROM departments WHERE id = ?1 AND event_id = ?2').bind(id, ev.id)
  ]);
  if (r.meta.changes !== 1) throw new HttpError(404, 'not_found', 'Department not found.');
  return json({ ok: true });
}

// POST /api/events/:id/people/profile { pass_id | invite_id, department_id?, employee_ref? }  (owner)
// Sets a person's department and employee ID. null clears. Works for people who have set up their pass and those who have not.
export async function setProfile({ request, env, user, params }) {
  const ev = office(await ownedEvent(env, user, params.id));
  const b = await readJson(request);
  let inviteId = null;
  if (b.pass_id) inviteId = (await env.DB.prepare('SELECT invite_id FROM passes WHERE id = ?1 AND event_id = ?2').bind(String(b.pass_id).slice(0, 40), ev.id).first())?.invite_id;
  else if (b.invite_id) inviteId = (await env.DB.prepare('SELECT id FROM invites WHERE id = ?1 AND event_id = ?2').bind(String(b.invite_id).slice(0, 40), ev.id).first())?.id;
  if (!inviteId) throw new HttpError(404, 'not_found', 'Person not found.');
  const sets = []; const vals = [];
  if ('department_id' in b) {
    if (b.department_id !== null && !(await env.DB.prepare('SELECT 1 AS x FROM departments WHERE id = ?1 AND event_id = ?2').bind(String(b.department_id), ev.id).first())) {
      throw new HttpError(400, 'invalid_department', 'That department does not exist.');
    }
    sets.push('department_id = ?' + (vals.push(b.department_id) + 1));
  }
  if ('employee_ref' in b) sets.push('employee_ref = ?' + (vals.push(cleanText(b.employee_ref, 'employee ID', { optional: true, max: 40 }) ) + 1));
  if (!sets.length) throw new HttpError(400, 'nothing_to_change', 'Nothing to change.');
  await env.DB.prepare(`UPDATE invites SET ${sets.join(', ')} WHERE id = ?1`).bind(inviteId, ...vals).run();
  return json({ ok: true });
}

// ---- Visitors: check-out and the emergency list ----------------------------------------------------------
// POST /api/events/:id/visitors/:guestId/checkout  (owner or security)
export async function checkoutVisitor({ env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id, ['security']));
  const r = await env.DB.prepare(
    `UPDATE guests SET checked_out_at = ?3 WHERE id = ?1 AND event_id = ?2 AND kind = 'visitor' AND checked_out_at IS NULL
       AND EXISTS (SELECT 1 FROM scans s WHERE s.guest_id = guests.id AND s.result = 'granted')`
  ).bind(String(params.guestId).slice(0, 40), ev.id, nowSec()).run();
  if (r.meta.changes !== 1) throw new HttpError(409, 'cannot_check_out', 'That visitor has not arrived, or is already checked out.');
  return json({ ok: true });
}

// GET /api/events/:id/on-site  (owner or security)
// Visitors who came in and have not been checked out, plus staff scanned in today. There are no exit scans, so staff are
// "scanned in today", not proof they are still in the building. The page says so.
export async function onSite({ env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id, ['security']));
  const { tz_offset_min: tz } = await env.DB.prepare('SELECT tz_offset_min FROM events WHERE id = ?1').bind(ev.id).first();
  const now = nowSec();
  const startOfToday = Math.floor((now + tz * 60) / 86400) * 86400 - tz * 60;
  const visitors = (await env.DB.prepare(
    `SELECT g.id, g.name, g.host, g.purpose, g.contact, (SELECT MIN(s.at) FROM scans s WHERE s.guest_id = g.id AND s.result = 'granted') AS arrived_at
     FROM guests g WHERE g.event_id = ?1 AND g.kind = 'visitor' AND g.status = 'active' AND g.checked_out_at IS NULL AND g.valid_from < ?2
       AND EXISTS (SELECT 1 FROM scans s WHERE s.guest_id = g.id AND s.result = 'granted' AND s.at >= ?3)
     ORDER BY arrived_at`
  ).bind(ev.id, now + 86400, startOfToday - 86400).all()).results;
  const staff = (await env.DB.prepare(
    `SELECT p.id, u.name, COALESCE(u.phone, u.email) AS contact, d.name AS department, i.employee_ref, MIN(s.at) AS first_in, MAX(s.at) AS last_seen
     FROM scans s JOIN passes p ON p.id = s.pass_id JOIN users u ON u.id = p.user_id
     LEFT JOIN invites i ON i.id = p.invite_id LEFT JOIN departments d ON d.id = i.department_id
     WHERE s.event_id = ?1 AND s.result = 'granted' AND s.at >= ?2 AND p.status = 'active'
     GROUP BY p.id ORDER BY d.name, u.name`
  ).bind(ev.id, startOfToday).all()).results;
  return json({
    generated_at: now,
    visitors, staff,
    note: 'Scans record entries only. Visitors are listed until someone checks them out. Staff are people scanned in today; the list cannot show who has since left.'
  });
}

// ---- Incidents --------------------------------------------------------------------------------------------
const KINDS = ['security', 'access', 'safety', 'other'];
// GET /api/events/:id/incidents
export async function listIncidents({ env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id));
  const rows = (await env.DB.prepare('SELECT * FROM incidents WHERE event_id = ?1 ORDER BY (status = \'open\') DESC, created_at DESC LIMIT 500').bind(ev.id).all()).results;
  return json({ incidents: rows });
}
// POST /api/events/:id/incidents { kind, summary, details? }  (owner or security)
export async function createIncident({ request, env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id, ['security']));
  const b = await readJson(request);
  if (!KINDS.includes(b.kind)) throw new HttpError(400, 'invalid_kind', 'Choose one of: ' + KINDS.join(', ') + '.');
  const summary = cleanText(b.summary, 'summary', { max: 140 });
  const details = cleanText(b.details, 'details', { optional: true, max: 2000 });
  const id = newId(12);
  await env.DB.prepare('INSERT INTO incidents (id, event_id, kind, summary, details, reported_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, ev.id, b.kind, summary, details, who(user), nowSec()).run();
  return json({ incident: await env.DB.prepare('SELECT * FROM incidents WHERE id = ?1').bind(id).first() }, 201);
}
// POST /api/events/:id/incidents/:incidentId/resolve { resolution? }  (owner or security)
export async function resolveIncident({ request, env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id, ['security']));
  let b = {}; try { const t = await request.text(); if (t) b = JSON.parse(t); } catch { throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.'); }
  const resolution = cleanText(b.resolution, 'resolution', { optional: true, max: 1000 });
  const r = await env.DB.prepare(`UPDATE incidents SET status = 'resolved', resolved_by = ?3, resolved_at = ?4, resolution = ?5 WHERE id = ?1 AND event_id = ?2 AND status = 'open'`)
    .bind(String(params.incidentId).slice(0, 40), ev.id, who(user), nowSec(), resolution).run();
  if (r.meta.changes !== 1) throw new HttpError(409, 'not_open', 'That incident is already resolved, or does not exist.');
  return json({ ok: true });
}
// GET /api/events/:id/incidents.csv
const cell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export async function incidentsCsv({ env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id));
  const rows = (await env.DB.prepare('SELECT * FROM incidents WHERE event_id = ?1 ORDER BY created_at').bind(ev.id).all()).results;
  const iso = (t) => (t ? new Date(t * 1000).toISOString() : '');
  const out = [['Reported', 'Type', 'Summary', 'Details', 'Reported by', 'Status', 'Resolved', 'Resolved by', 'Resolution']]
    .concat(rows.map((r) => [iso(r.created_at), r.kind, r.summary, r.details, r.reported_by, r.status, iso(r.resolved_at), r.resolved_by, r.resolution]));
  return new Response(out.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tap-in-${(ev.prefix || 'office').toLowerCase()}-incidents.csv"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

// ---- Team access (owner) ----------------------------------------------------------------------------------
// GET /api/events/:id/members
export async function listMembers({ env, user, params }) {
  const ev = office(await ownedEvent(env, user, params.id));
  const rows = (await env.DB.prepare('SELECT id, identifier, role, added_by, created_at FROM event_members WHERE event_id = ?1 ORDER BY created_at').bind(ev.id).all()).results;
  return json({ members: rows });
}
// POST /api/events/:id/members { identifier, role: "viewer" | "security" }
export async function addMember({ request, env, user, params }) {
  const ev = office(await ownedEvent(env, user, params.id));
  const b = await readJson(request);
  const id = parseIdentifier(b.identifier);
  if (!id) throw new HttpError(400, 'invalid_identifier', 'Enter a valid phone number or email.');
  if (!['viewer', 'security'].includes(b.role)) throw new HttpError(400, 'invalid_role', 'Choose "viewer" or "security".');
  if ([user.email, user.phone].includes(id.value)) throw new HttpError(400, 'is_owner', 'You already own this office.');
  const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM event_members WHERE event_id = ?1').bind(ev.id).first()).n;
  if (n >= MAX_MEMBERS) throw new HttpError(400, 'member_limit', `You can add up to ${MAX_MEMBERS} team members.`);
  const mid = newId(10);
  try {
    await env.DB.prepare('INSERT INTO event_members (id, event_id, identifier, role, added_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(mid, ev.id, id.value, b.role, who(user), nowSec()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) {
      await env.DB.prepare('UPDATE event_members SET role = ?3 WHERE event_id = ?1 AND identifier = ?2').bind(ev.id, id.value, b.role).run(); // changing someone's role
      return json({ member: { identifier: id.value, role: b.role }, updated: true });
    }
    throw e;
  }
  return json({ member: { id: mid, identifier: id.value, role: b.role } }, 201);
}
// POST /api/events/:id/members/:memberId/remove
export async function removeMember({ env, user, params }) {
  const ev = office(await ownedEvent(env, user, params.id));
  const r = await env.DB.prepare('DELETE FROM event_members WHERE id = ?1 AND event_id = ?2').bind(String(params.memberId).slice(0, 40), ev.id).run();
  if (r.meta.changes !== 1) throw new HttpError(404, 'not_found', 'Team member not found.');
  return json({ ok: true });
}
