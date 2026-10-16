// Gate routes. A scanner at a door authenticates with the event's gate key (Authorization: Bearer ...),
// asks "may this pass enter this zone?", and every answer is written to the scan log.

import { HttpError, newId, normaliseCode, nowSec, safeEqual } from '../lib/util.js';
import { clientIp, json, readJson } from '../lib/http.js';
import { hashGateKey, liveMacFor, liveWindowFresh, parseLiveToken, parsePassToken, passMac } from '../lib/codes.js';
import { isFull, record } from '../lib/limits.js';
import { withinSchedule } from '../lib/schedule.js';

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
  const ev = key
    ? await env.DB.prepare('SELECT id, name, kind, venue, city, allow_reentry, secure_qr, tz_offset_min FROM events WHERE gate_key_hash = ?1')
        .bind(await hashGateKey(env.SECRET_PEPPER, key))
        .first()
    : null;
  if (!ev) {
    await record(env.DB, bucket);
    throw new HttpError(401, 'bad_gate_key', 'That gate key is not valid.');
  }
  return ev;
}

// GET /api/gate/info
export async function gateInfo({ request, env }) {
  const ev = await gateEvent(request, env);
  const zones = (await env.DB.prepare('SELECT id, name FROM zones WHERE event_id = ?1 ORDER BY sort, name').bind(ev.id).all()).results;
  return json({ event: { id: ev.id, name: ev.name, kind: ev.kind, venue: ev.venue, city: ev.city, allow_reentry: !!ev.allow_reentry }, zones });
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
  const live = parseLiveToken(body.token);
  const parsed = live || parsePassToken(body.token);
  if (!parsed) {
    reason = 'invalid_token';
  } else if (live ? !safeEqual(await liveMacFor(env.SECRET_PEPPER, live.id, live.win), live.mac) : !safeEqual(await passMac(env.SECRET_PEPPER, parsed.id), parsed.mac)) {
    reason = 'invalid_token';
  } else if (live && !liveWindowFresh(live.win, now)) {
    reason = 'stale_code';
  } else {
    pass = await env.DB.prepare(
      `SELECT p.id, p.status, p.event_id, p.tier_id, p.expires_at, u.name AS holder, t.name AS tier, t.days_mask, t.from_min, t.to_min
       FROM passes p JOIN users u ON u.id = p.user_id JOIN tiers t ON t.id = p.tier_id WHERE p.id = ?1`
    )
      .bind(parsed.id)
      .first();
    if (!pass) reason = 'invalid_token';
    else if (pass.event_id !== ev.id) reason = 'wrong_event';
    else if (pass.status !== 'active') reason = 'revoked';
    else if (ev.secure_qr && !live) reason = 'static_pass';
    else if (pass.expires_at && pass.expires_at <= now) reason = 'expired';
    else if (!withinSchedule(pass, now, ev.tz_offset_min)) reason = 'outside_hours';
    else {
      const allowed = await env.DB.prepare('SELECT 1 AS ok FROM tier_zones WHERE tier_id = ?1 AND zone_id = ?2')
        .bind(pass.tier_id, zone.id)
        .first();
      if (!allowed) reason = 'no_zone_access';
    }
  }

  let previousAt = null;
  if (!reason) {
    try {
      await env.DB.prepare(
        `INSERT INTO scans (id, event_id, pass_id, zone_id, result, reason, once, at) VALUES (?1, ?2, ?3, ?4, 'granted', NULL, ?5, ?6)`
      )
        .bind(newId(14), ev.id, pass.id, zone.id, ev.allow_reentry ? 0 : 1, now)
        .run();
    } catch (err) {
      // The unique index says this pass already entered this zone (and re-entry is off).
      if (!/UNIQUE constraint failed/i.test(String(err?.message))) throw err;
      reason = 'already_used';
      const prev = await env.DB.prepare(
        "SELECT MIN(at) AS at FROM scans WHERE pass_id = ?1 AND zone_id = ?2 AND result = 'granted'"
      )
        .bind(pass.id, zone.id)
        .first();
      previousAt = prev ? prev.at : null;
    }
  }

  if (reason) {
    // Record the attempt. Only link it to a pass when that pass belongs to this event.
    await env.DB.prepare(
      `INSERT INTO scans (id, event_id, pass_id, zone_id, result, reason, once, at) VALUES (?1, ?2, ?3, ?4, 'denied', ?5, 0, ?6)`
    )
      .bind(newId(14), ev.id, pass && pass.event_id === ev.id ? pass.id : null, zone.id, reason, now)
      .run();
    if (reason === 'invalid_token') await record(env.DB, junkBucket);
  }

  const known = pass && pass.event_id === ev.id;
  return json({
    result: reason ? 'denied' : 'granted',
    reason,
    message: reason ? MESSAGES[reason] : 'Welcome in.',
    holder: known ? displayName(pass.holder) : null,
    tier: known ? pass.tier : null,
    zone: zone.name,
    at: now,
    previous_at: previousAt
  });
}
