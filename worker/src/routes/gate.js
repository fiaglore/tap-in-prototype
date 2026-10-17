// Gate routes. A scanner at a door authenticates with a steward's own key, or the event's shared gate key
// (Authorization: Bearer ...), asks "may this pass enter this zone?", and every answer is written to the scan
// log together with the steward who scanned it.

import { HttpError, newId, normaliseCode, nowSec, safeEqual } from '../lib/util.js';
import { clientIp, json, readJson } from '../lib/http.js';
import { guestMac, hashGateKey, hashGuestCode, hashStewardKey, isStewardKey, liveMacFor, liveWindowFresh, parseGuestToken, parseLiveToken, parsePassToken, passMac } from '../lib/codes.js';
import { isFull, record } from '../lib/limits.js';
import { withinSchedule } from '../lib/schedule.js';
import { NEW_PHOTO_SECS, photoDataUrl } from '../lib/photo.js';

const MESSAGES = {
  invalid_token: 'Not a valid Tap In pass.',
  wrong_event: 'This pass is for a different event.',
  revoked: 'This pass was cancelled.',
  no_zone_access: 'This pass does not include this area.',
  already_used: 'This pass has already been used here.',
  expired: 'This pass has expired.',
  stale_code: 'This pass code is out of date. Ask them to reopen their pass.',
  static_pass: 'This event needs the live code from the app. Screenshots and printed codes do not work.',
  outside_hours: 'This pass is not valid at this time.'
};

async function gateEvent(request, env) {
  const ip = clientIp(request);
  const bucket = 'gate:ip:' + ip;
  if (await isFull(env.DB, bucket, 20, 600)) throw new HttpError(429, 'rate_limited', 'Too many failed attempts. Wait a few minutes.');
  const m = /^Bearer\s+(.{1,100})$/i.exec(request.headers.get('authorization') || '');
  const key = m ? normaliseCode(m[1]) : '';
  const cols = 'e.id, e.name, e.kind, e.venue, e.city, e.allow_reentry, e.secure_qr, e.require_photo, e.tz_offset_min';
  let ev = null;
  if (key && isStewardKey(key)) {
    // A steward's own key. A removed steward is refused straight away.
    ev = await env.DB.prepare(
      `SELECT ${cols}, s.id AS steward_id, s.name AS steward_name, s.last_seen_at FROM stewards s JOIN events e ON e.id = s.event_id
       WHERE s.key_hash = ?1 AND s.revoked_at IS NULL`
    )
      .bind(await hashStewardKey(env.SECRET_PEPPER, key))
      .first();
  } else if (key) {
    ev = await env.DB.prepare(`SELECT ${cols}, NULL AS steward_id, NULL AS steward_name FROM events e WHERE e.gate_key_hash = ?1`)
      .bind(await hashGateKey(env.SECRET_PEPPER, key))
      .first();
  }
  if (!ev) {
    await record(env.DB, bucket);
    throw new HttpError(401, 'bad_gate_key', 'That scanner key is not valid. Ask the organiser for a new one.');
  }
  const now = nowSec();
  if (ev.steward_id && (!ev.last_seen_at || now - ev.last_seen_at > 60)) {
    await env.DB.prepare('UPDATE stewards SET last_seen_at = ?1 WHERE id = ?2').bind(now, ev.steward_id).run();
  }
  return ev;
}

// GET /api/gate/info
export async function gateInfo({ request, env }) {
  const ev = await gateEvent(request, env);
  const zones = (await env.DB.prepare('SELECT id, name FROM zones WHERE event_id = ?1 ORDER BY sort, name').bind(ev.id).all()).results;
  return json({ event: { id: ev.id, name: ev.name, kind: ev.kind, venue: ev.venue, city: ev.city, allow_reentry: !!ev.allow_reentry }, zones, steward: ev.steward_id ? { name: ev.steward_name } : null });
}

const displayName = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Guest';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
};

// POST /api/gate/scan  { token, zone_id }
export async function gateScan({ request, env }) {
  const ev = await gateEvent(request, env);
  const body = await readJson(request);
  const zone = await env.DB.prepare('SELECT id, name FROM zones WHERE id = ?1 AND event_id = ?2')
    .bind(String(body.zone_id ?? '').slice(0, 40), ev.id)
    .first();
  if (!zone) throw new HttpError(400, 'invalid_zone', 'Choose which area this scanner is for.');

  const ip = clientIp(request);
  const junkBucket = 'gate:junk:' + ip;
  if (await isFull(env.DB, junkBucket, 60, 600)) throw new HttpError(429, 'rate_limited', 'Too many unreadable passes. Wait a moment.');

  const now = nowSec();
  let reason = null;
  let pass = null;
  let guest = null;
  const live = parseLiveToken(body.token);
  const parsed = live || parsePassToken(body.token);
  const guestTok = !parsed && parseGuestToken(body.token);

  // Guests (invitations and tickets imported from another ticketer) have no Tap In account.
  // An invitation code carries its own check; any other code is looked up in this event's imported list.
  const loadGuest = (where, val) => env.DB.prepare(
    `SELECT g.id, g.event_id, g.tier_id, g.kind, g.name AS holder, g.party_size, g.attending, g.rsvp, g.table_label, g.status, t.name AS tier, t.days_mask, t.from_min, t.to_min
     FROM guests g JOIN tiers t ON t.id = g.tier_id WHERE ${where}`
  ).bind(...val).first();
  if (guestTok && safeEqual(await guestMac(env.SECRET_PEPPER, guestTok.id), guestTok.mac)) {
    guest = await loadGuest('g.id = ?1', [guestTok.id]);
  } else if (parsed) {
    const macOk = live ? safeEqual(await liveMacFor(env.SECRET_PEPPER, live.id, live.win), live.mac) : safeEqual(await passMac(env.SECRET_PEPPER, parsed.id), parsed.mac);
    if (macOk && live && !liveWindowFresh(live.win, now)) reason = 'stale_code';
    else if (macOk) {
      pass = await env.DB.prepare(
        `SELECT p.id, p.status, p.event_id, p.tier_id, p.expires_at, p.user_id, u.name AS holder, t.name AS tier, t.days_mask, t.from_min, t.to_min
         FROM passes p JOIN users u ON u.id = p.user_id JOIN tiers t ON t.id = p.tier_id WHERE p.id = ?1`
      )
        .bind(parsed.id)
        .first();
    }
  }
  if (!pass && !guest && !reason && String(body.token ?? '').trim()) {
    // Not a Tap In code (or one that failed its check): maybe a ticket from this event's imported list.
    guest = await loadGuest('g.event_id = ?1 AND g.code_hash = ?2', [ev.id, await hashGuestCode(env.SECRET_PEPPER, ev.id, body.token)]);
  }

  const holder = pass || guest;
  if (!reason) {
    if (!holder) reason = 'invalid_token';
    else if (holder.event_id !== ev.id) reason = 'wrong_event';
    else if (holder.status !== 'active') reason = 'revoked';
    else if (pass && ev.secure_qr && !live) reason = 'static_pass';
    else if (pass && pass.expires_at && pass.expires_at <= now) reason = 'expired';
    else if (!withinSchedule(holder, now, ev.tz_offset_min)) reason = 'outside_hours';
    else {
      const allowed = await env.DB.prepare('SELECT 1 AS ok FROM tier_zones WHERE tier_id = ?1 AND zone_id = ?2')
        .bind(holder.tier_id, zone.id)
        .first();
      if (!allowed) reason = 'no_zone_access';
    }
  }

  let previousAt = null;
  if (!reason) {
    try {
      await env.DB.prepare(
        `INSERT INTO scans (id, event_id, pass_id, guest_id, zone_id, result, reason, once, at, steward_id) VALUES (?1, ?2, ?3, ?4, ?5, 'granted', NULL, ?6, ?7, ?8)`
      )
        .bind(newId(14), ev.id, pass ? pass.id : null, guest ? guest.id : null, zone.id, ev.allow_reentry ? 0 : 1, now, ev.steward_id)
        .run();
    } catch (err) {
      // The unique index says this pass already entered this zone (and re-entry is off).
      if (!/UNIQUE constraint failed/i.test(String(err?.message))) throw err;
      reason = 'already_used';
      const prev = await env.DB.prepare(
        `SELECT MIN(at) AS at FROM scans WHERE ${pass ? 'pass_id' : 'guest_id'} = ?1 AND zone_id = ?2 AND result = 'granted'`
      )
        .bind(holder.id, zone.id)
        .first();
      previousAt = prev ? prev.at : null;
    }
  }

  if (reason) {
    // Record the attempt. Only link it to a pass when that pass belongs to this event.
    await env.DB.prepare(
      `INSERT INTO scans (id, event_id, pass_id, guest_id, zone_id, result, reason, once, at, steward_id) VALUES (?1, ?2, ?3, ?4, ?5, 'denied', ?6, 0, ?7, ?8)`
    )
      .bind(newId(14), ev.id, pass && pass.event_id === ev.id ? pass.id : null, guest && guest.event_id === ev.id ? guest.id : null, zone.id, reason, now, ev.steward_id)
      .run();
    if (reason === 'invalid_token') await record(env.DB, junkBucket);
  }

  const known = holder && holder.event_id === ev.id;
  // For events that ask for it, show the face on file, on every scan of a known pass (refusals too: a refused
  // "already used" scan shown with the face is how staff spot a shared screenshot).
  let face = {};
  if (known && guest && ev.require_photo) {
    face = { photo: null, photo_missing: true }; // guests have no photo on file: check ID
  } else if (known && ev.require_photo) {
    const ph = await env.DB.prepare('SELECT jpeg_b64, updated_at FROM user_photos WHERE user_id = ?1').bind(pass.user_id).first();
    face = ph
      ? { photo: photoDataUrl(ph.jpeg_b64), photo_new: now - ph.updated_at < NEW_PHOTO_SECS, photo_set_at: ph.updated_at }
      : { photo: null, photo_missing: true };
  }
  return json({
    ...face,
    result: reason ? 'denied' : 'granted',
    reason,
    message: reason ? MESSAGES[reason] : 'Welcome in.',
    holder: known ? displayName(holder.holder) : null,
    tier: known ? holder.tier : null,
    // Guests: how many people this one code lets in, their table, and how they answered the RSVP.
    ...(known && guest ? {
      guest: guest.kind,
      party: guest.rsvp === 'yes' && guest.attending ? guest.attending : guest.party_size,
      table: guest.table_label,
      rsvp: guest.kind === 'invite' ? guest.rsvp : null
    } : {}),
    zone: zone.name,
    at: now,
    previous_at: previousAt
  });
}
