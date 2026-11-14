// Pure helpers for secure self check-in: the rotating room code, distance, and how often someone is asked for a selfie.
import { base32, hmacBytes, safeEqual } from './util.js';

// ---- The room code: event id, window and mac, shown as a QR on a screen at the office ----
// token = event id + "." + window + "." + mac, mac = HMAC(pepper, "checkin|" + event + "|" + window) (12 chars).
// A photo of the screen is stale after about 90 seconds, and the phone must also be inside the office.
export const ROOM_STEP = 30;
export const ROOM_GRACE = 2;
export const roomWindow = (now) => Math.floor(now / ROOM_STEP);
const roomMac = async (pepper, eventId, win) => base32(await hmacBytes(pepper, `checkin|${eventId}|${win}`)).slice(0, 12);

export async function roomToken(pepper, eventId, now) {
  const win = roomWindow(now);
  return `${eventId}.${win}.${await roomMac(pepper, eventId, win)}`;
}
export function parseRoomToken(raw) {
  const m = /^([0-9A-Z]{6,24})\.(\d{1,9})\.([0-9A-Z]{12})$/.exec(String(raw ?? '').trim().toUpperCase());
  return m ? { event: m[1], win: Number(m[2]), mac: m[3] } : null;
}
export async function roomTokenValid(pepper, t, now) {
  const age = roomWindow(now) - t.win;
  if (age < -1 || age > ROOM_GRACE) return false;
  return safeEqual(await roomMac(pepper, t.event, t.win), t.mac);
}

// ---- Distance in metres between two points (haversine) ----
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

// ---- Random selfie requests ----
// Chance (0-100) that this person is asked for a selfie today.
//   always / off  -> 100 / 0
//   random        -> between minPct and maxPct by track record over the last 30 working days:
//                    attendance (days in / days expected) and punctuality (late days / days in).
//                    Under 5 expected days of history, or a refused out-of-location attempt in the last 14 days, means maxPct
//                    (a person flagged for an out-of-location attempt is asked every time).
export function selfieChance({ mode, minPct, maxPct, expected, present, late, recentRejects }) {
  if (mode === 'off') return 0;
  if (mode === 'always') return 100;
  if (recentRejects > 0) return 100;
  const lo = Math.min(minPct, maxPct), hi = Math.max(minPct, maxPct);
  if (expected < 5) return hi;
  const attendance = Math.min(1, present / expected);
  const lateRate = present ? late / present : 1;
  const trust = Math.max(0, Math.min(1, (attendance - 0.7) / 0.3)) * Math.max(0, Math.min(1, 1 - lateRate / 0.3));
  return Math.round(hi - (hi - lo) * trust);
}

// Whether today's roll of the dice asks for a selfie. The roll is fixed for the person and the day (it comes from a keyed
// hash), so trying again, or scanning again, cannot change the answer.
export async function rollSelfie(pepper, passId, day, chancePct) {
  if (chancePct <= 0) return false;
  if (chancePct >= 100) return true;
  const b = await hmacBytes(pepper, `selfie|${passId}|${day}`);
  const u = ((b[0] << 16) | (b[1] << 8) | b[2]) / 0x1000000; // 0 <= u < 1
  return u * 100 < chancePct;
}
