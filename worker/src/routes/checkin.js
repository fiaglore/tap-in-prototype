// Secure self check-in for Tap In for Business offices.
//   1. A screen at the office shows a QR that changes every 30 seconds (GET /api/events/:id/checkin/code).
//   2. A person scans it with their phone and the page sends the code and the phone's location (POST /api/checkin).
//   3. The server checks the code is fresh, the person has an active pass here, and the phone is inside the office.
//   4. At random (rarely for people who are punctual and seldom miss a day) it also asks for a live selfie.
//   5. The check-in is saved with its evidence and counts as an entry in the attendance and "on site" reports.
import { HttpError, newId, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { take } from '../lib/limits.js';
import { checkPhoto, photoDataUrl } from '../lib/photo.js';
import { withinSchedule } from '../lib/schedule.js';
import { checkChallenge, distanceM, makeChallenge, photoHash, parseRoomToken, rollSelfie, roomToken, roomTokenValid, selfieChance, ROOM_STEP } from '../lib/checkin.js';
import { accessibleEvent, ownedEvent } from './events.js';

const LATE_GRACE_MIN = 15;
const HISTORY_DAYS = 30;
const SELFIE_KEEP_DAYS = 30;
const weekday = (d) => (d + 3) % 7; // 0 = Monday
const dayOfDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '')); return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null; };
const dateOfDay = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
const localDay = (at, tz) => Math.floor((at + tz * 60) / 86400);
const office = (ev) => { if (ev.kind !== 'workplace') throw new HttpError(400, 'not_an_office', 'Self check-in is for Tap In for Business offices.'); return ev; };

const COLS = 'checkin_enabled, checkin_lat, checkin_lng, checkin_radius_m, checkin_max_accuracy_m, checkin_selfie_mode, checkin_selfie_max_pct, checkin_selfie_min_pct, tz_offset_min';
const settingsOut = (e) => ({
  enabled: !!e.checkin_enabled,
  lat: e.checkin_lat, lng: e.checkin_lng, radius_m: e.checkin_radius_m, max_accuracy_m: e.checkin_max_accuracy_m,
  selfie_mode: e.checkin_selfie_mode, selfie_max_pct: e.checkin_selfie_max_pct, selfie_min_pct: e.checkin_selfie_min_pct,
  selfie_keep_days: SELFIE_KEEP_DAYS
});
const loadSettings = (env, id) => env.DB.prepare(`SELECT ${COLS} FROM events WHERE id = ?1`).bind(id).first();

// GET /api/events/:id/checkin/settings  (owner, or a team member)
export async function getSettings({ env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id));
  return json({ settings: settingsOut(await loadSettings(env, ev.id)) });
}

// PATCH /api/events/:id/checkin/settings  (owner)
export async function patchSettings({ request, env, user, params }) {
  const ev = office(await ownedEvent(env, user, params.id));
  const b = await readJson(request);
  const cur = settingsOut(await loadSettings(env, ev.id));
  const num = (v, field, lo, hi) => {
    const n = Number(v);
    if (v === null || v === '' || !Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, 'invalid_' + field, `${field.replace(/_/g, ' ')} must be a number from ${lo} to ${hi}.`);
    return n;
  };
  const next = { ...cur };
  if ('lat' in b || 'lng' in b) {
    if (b.lat === null && b.lng === null) { next.lat = null; next.lng = null; } else { next.lat = num(b.lat, 'lat', -90, 90); next.lng = num(b.lng, 'lng', -180, 180); }
  }
  if ('radius_m' in b) next.radius_m = Math.round(num(b.radius_m, 'radius_m', 25, 2000));
  if ('max_accuracy_m' in b) next.max_accuracy_m = Math.round(num(b.max_accuracy_m, 'max_accuracy_m', 20, 500));
  if ('selfie_mode' in b) {
    if (!['off', 'random', 'always'].includes(b.selfie_mode)) throw new HttpError(400, 'invalid_selfie_mode', 'Selfie mode must be off, random or always.');
    next.selfie_mode = b.selfie_mode;
  }
  if ('selfie_max_pct' in b) next.selfie_max_pct = Math.round(num(b.selfie_max_pct, 'selfie_max_pct', 0, 100));
  if ('selfie_min_pct' in b) next.selfie_min_pct = Math.round(num(b.selfie_min_pct, 'selfie_min_pct', 0, 100));
  if (next.selfie_min_pct > next.selfie_max_pct) throw new HttpError(400, 'invalid_selfie_range', 'The lowest chance cannot be higher than the highest chance.');
  if ('enabled' in b) { if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'invalid_enabled', 'enabled must be true or false.'); next.enabled = b.enabled; }
  if (next.enabled && (next.lat === null || next.lng === null)) throw new HttpError(400, 'location_required', 'Set where the office is before turning self check-in on, so the phone can be checked against it.');
  await env.DB.prepare(
    `UPDATE events SET checkin_enabled = ?1, checkin_lat = ?2, checkin_lng = ?3, checkin_radius_m = ?4, checkin_max_accuracy_m = ?5,
       checkin_selfie_mode = ?6, checkin_selfie_max_pct = ?7, checkin_selfie_min_pct = ?8 WHERE id = ?9`
  ).bind(next.enabled ? 1 : 0, next.lat, next.lng, next.radius_m, next.max_accuracy_m, next.selfie_mode, next.selfie_max_pct, next.selfie_min_pct, ev.id).run();
  return json({ settings: next });
}

// GET /api/events/:id/checkin/code  (owner or security staff): the code the screen at the office shows right now.
export async function roomCode({ request, env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id, ['security']));
  const s = await loadSettings(env, ev.id);
  if (!s.checkin_enabled) throw new HttpError(409, 'checkin_off', 'Self check-in is turned off for this office.');
  const now = nowSec();
  const token = await roomToken(env.SECRET_PEPPER, ev.id, now);
  return json({ token, url: `${new URL(request.url).origin}/checkin/#${token}`, expires_in: ROOM_STEP - (now % ROOM_STEP), step: ROOM_STEP }, 200, { 'Cache-Control': 'no-store' });
}

// How this person has done over the last 30 days, from the entry scans (self check-ins write one too).
async function history(env, pass, ev, today) {
  const from = Math.max(localDay(pass.created_at, ev.tz_offset_min), today - HISTORY_DAYS);
  const start = from * 86400 - ev.tz_offset_min * 60;
  const scans = (await env.DB.prepare("SELECT at FROM scans WHERE pass_id = ?1 AND result = 'granted' AND at >= ?2 AND at < ?3 ORDER BY at").bind(pass.id, start, today * 86400 - ev.tz_offset_min * 60).all()).results;
  const first = new Map();
  for (const s of scans) { const d = localDay(s.at, ev.tz_offset_min); if (!first.has(d)) first.set(d, s.at); }
  const always = pass.days_mask === 127 && pass.from_min === 0 && pass.to_min === 1440;
  let expected = 0, present = 0, late = 0;
  for (let d = from; d < today; d++) {
    if (!(pass.days_mask & (1 << weekday(d)))) continue;
    expected++;
    if (first.has(d)) {
      present++;
      const min = Math.floor((((first.get(d) + ev.tz_offset_min * 60) % 86400) + 86400) % 86400 / 60);
      if (!always && min > pass.from_min + LATE_GRACE_MIN) late++;
    }
  }
  return { expected, present, late };
}

const receipt = (ev, pass, row, selfie) => ({
  recorded: true,
  office: ev.name,
  name: pass.holder || null,
  employee_ref: pass.employee_ref || null,
  department: pass.department || null,
  at: row.at,
  selfie: selfie ? photoDataUrl(selfie) : null,
  selfie_required: !!row.selfie_required,
  distance_m: row.distance_m
});

// POST /api/checkin { token, lat, lng, accuracy, selfie? }   (signed in to the app)
// Answers one of: recorded (the receipt), needs_selfie (take a selfie and send the same request again), or an error.
export async function checkIn({ request, env, user }) {
  if (!(await take(env.DB, 'checkin:u:' + user.id, 30, 600))) throw new HttpError(429, 'rate_limited', 'Too many tries. Wait a few minutes.');
  const b = await readJson(request, 200_000);
  const tok = parseRoomToken(b.token);
  if (!tok || !(await roomTokenValid(env.SECRET_PEPPER, tok, nowSec()))) {
    throw new HttpError(400, 'stale_code', tok ? 'That code has expired. Scan the screen at the office again.' : 'That is not a Tap In check-in code.');
  }
  const ev = await env.DB.prepare(`SELECT id, name, kind, ${COLS} FROM events WHERE id = ?1`).bind(tok.event).first();
  if (!ev || ev.kind !== 'workplace' || !ev.checkin_enabled) throw new HttpError(403, 'checkin_off', 'Self check-in is not turned on for this office.');
  const now = nowSec();
  const today = localDay(now, ev.tz_offset_min);

  const pass = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.created_at, p.expires_at, u.name AS holder, t.days_mask, t.from_min, t.to_min, d.name AS department, i.employee_ref
     FROM passes p JOIN users u ON u.id = p.user_id JOIN tiers t ON t.id = p.tier_id
     LEFT JOIN invites i ON i.id = p.invite_id LEFT JOIN departments d ON d.id = i.department_id
     WHERE p.event_id = ?1 AND p.user_id = ?2 AND p.status = 'active' ORDER BY p.created_at LIMIT 1`
  ).bind(ev.id, user.id).first();
  if (!pass || (pass.expires_at && pass.expires_at <= now)) throw new HttpError(403, 'no_pass', 'You do not have an active pass at this office. Ask your office admin.');

  // Already checked in today: show the same receipt again.
  const done = await env.DB.prepare("SELECT * FROM checkins WHERE pass_id = ?1 AND day = ?2 AND status = 'ok'").bind(pass.id, today).first();
  if (done) return json({ ...receipt(ev, pass, done, done.selfie_b64), already: true });

  if (!withinSchedule(pass, now, ev.tz_offset_min)) throw new HttpError(403, 'outside_hours', 'Your pass is not valid at this time.');

  // Where is the phone?
  const lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.accuracy);
  const hasFix = b.lat !== undefined && b.lat !== null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const reject = async (reason, message, status, extra = {}) => {
    await env.DB.prepare(
      `INSERT INTO checkins (id, event_id, pass_id, user_id, day, at, status, reason, lat, lng, accuracy_m, distance_m, flags) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'rejected', ?7, ?8, ?9, ?10, ?11, '')`
    ).bind(newId(14), ev.id, pass.id, user.id, today, now, reason, hasFix ? lat : null, hasFix ? lng : null, Number.isFinite(acc) ? Math.round(acc) : null, extra.distance ?? null).run();
    throw new HttpError(status, reason, message);
  };
  if (!hasFix) return reject('no_location', 'Allow location so Tap In can confirm you are at the office.', 422);
  const accuracy = Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null;
  if (accuracy === null || accuracy > ev.checkin_max_accuracy_m) {
    // Not an accusation: the phone could not tell where it is. Ask them to try again (outside, or with location on).
    throw new HttpError(422, 'poor_accuracy', `Your location is not precise enough (needs to be within ${ev.checkin_max_accuracy_m} m). Try again near a window or outside.`);
  }
  const distance = distanceM(lat, lng, ev.checkin_lat, ev.checkin_lng);
  if (distance > ev.checkin_radius_m + Math.min(accuracy, 50)) {
    return reject('outside_location', `You are about ${distance} m from the office. Check in when you arrive.`, 403, { distance });
  }

  // A selfie today?
  const hist = await history(env, pass, ev, today);
  const rejects = (await env.DB.prepare("SELECT COUNT(*) AS n FROM checkins WHERE pass_id = ?1 AND status = 'rejected' AND reason = 'outside_location' AND at > ?2").bind(pass.id, now - 14 * 86400).first()).n;
  const chance = selfieChance({ mode: ev.checkin_selfie_mode, minPct: ev.checkin_selfie_min_pct, maxPct: ev.checkin_selfie_max_pct, ...hist, recentRejects: rejects });
  const asked = await rollSelfie(env.SECRET_PEPPER, pass.id, today, chance);
  let selfie = null, selfieHash = null;
  if (asked) {
    if (!b.selfie) return json({ needs_selfie: true, office: ev.name, challenge: await makeChallenge(env.SECRET_PEPPER, pass.id, today, now), message: 'Take a live selfie to finish checking in.' });
    // The selfie must answer a challenge issued a few seconds to a few minutes ago for this person and day, and must not be a
    // picture this person has used for a check-in before (a saved photo cannot be re-sent).
    if (!(await checkChallenge(env.SECRET_PEPPER, pass.id, today, b.challenge, now))) throw new HttpError(400, 'selfie_challenge', 'That selfie did not come from a live camera session. Open the check-in again and take a new selfie.');
    selfie = checkPhoto(b.selfie).b64;
    selfieHash = await photoHash(selfie);
    if (await env.DB.prepare('SELECT 1 AS x FROM checkins WHERE pass_id = ?1 AND selfie_hash = ?2').bind(pass.id, selfieHash).first()) throw new HttpError(400, 'selfie_reused', 'That photo has been used before. Take a new live selfie.');
  }

  const row = { id: newId(14), at: now, selfie_required: asked ? 1 : 0, distance_m: distance };
  const flags = accuracy > 50 ? 'weak_gps' : '';
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO checkins (id, event_id, pass_id, user_id, day, at, status, lat, lng, accuracy_m, distance_m, selfie_chance, selfie_required, selfie_b64, selfie_hash, flags) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
      ).bind(row.id, ev.id, pass.id, user.id, today, now, lat, lng, accuracy, distance, chance, row.selfie_required, selfie, selfieHash, flags),
      // Counts as an entry, so attendance, lateness and "on site now" include it. No door: it is the office as a whole.
      env.DB.prepare("INSERT INTO scans (id, event_id, pass_id, zone_id, result, reason, once, at) VALUES (?1, ?2, ?3, NULL, 'granted', NULL, 0, ?4)").bind(newId(14), ev.id, pass.id, now)
    ]);
  } catch (err) {
    if (!/UNIQUE constraint failed/i.test(String(err?.message))) throw err;
    const again = await env.DB.prepare("SELECT * FROM checkins WHERE pass_id = ?1 AND day = ?2 AND status = 'ok'").bind(pass.id, today).first();
    return json({ ...receipt(ev, pass, again, again.selfie_b64), already: true });
  }
  return json(receipt(ev, pass, row, selfie), 201);
}

// GET /api/events/:id/checkins?date=YYYY-MM-DD  (owner, viewer, security): one day of check-ins and refused attempts.
export async function listCheckins({ env, user, params, url }) {
  const ev = office(await accessibleEvent(env, user, params.id));
  const tz = (await loadSettings(env, ev.id)).tz_offset_min;
  const day = dayOfDate(url.searchParams.get('date')) ?? localDay(nowSec(), tz);
  const rows = (await env.DB.prepare(
    `SELECT c.id, c.at, c.status, c.reason, c.accuracy_m, c.distance_m, c.selfie_chance, c.selfie_required, (c.selfie_b64 IS NOT NULL) AS has_selfie, c.flags,
            u.name, COALESCE(u.phone, u.email) AS contact, d.name AS department, i.employee_ref
     FROM checkins c JOIN passes p ON p.id = c.pass_id JOIN users u ON u.id = c.user_id
     LEFT JOIN invites i ON i.id = p.invite_id LEFT JOIN departments d ON d.id = i.department_id
     WHERE c.event_id = ?1 AND c.day = ?2 ORDER BY c.at DESC LIMIT 500`
  ).bind(ev.id, day).all()).results.map((r) => ({ ...r, has_selfie: !!r.has_selfie, selfie_required: !!r.selfie_required }));
  const ok = rows.filter((r) => r.status === 'ok');
  return json({
    date: dateOfDay(day), role: ev.role,
    summary: { checked_in: ok.length, refused: rows.length - ok.length, selfies_asked: ok.filter((r) => r.selfie_required).length, weak_gps: ok.filter((r) => r.flags.includes('weak_gps')).length },
    checkins: rows
  });
}

// GET /api/events/:id/checkins/:checkinId/selfie  (owner or security): the picture, never listed in bulk.
export async function checkinSelfie({ env, user, params }) {
  const ev = office(await accessibleEvent(env, user, params.id, ['security']));
  if (ev.role === 'viewer') throw new HttpError(404, 'not_found', 'Not found.');
  const r = await env.DB.prepare('SELECT selfie_b64 FROM checkins WHERE id = ?1 AND event_id = ?2').bind(String(params.checkinId).slice(0, 30), ev.id).first();
  if (!r || !r.selfie_b64) throw new HttpError(404, 'not_found', 'No selfie for that check-in.');
  const bin = Uint8Array.from(atob(r.selfie_b64), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

// Called from the daily purge: check-in selfies are cleared after SELFIE_KEEP_DAYS. The check-in itself stays on record.
export const clearOldSelfies = (env, now) =>
  env.DB.prepare('UPDATE checkins SET selfie_b64 = NULL WHERE selfie_b64 IS NOT NULL AND at < ?1').bind(now - SELFIE_KEEP_DAYS * 86400);
