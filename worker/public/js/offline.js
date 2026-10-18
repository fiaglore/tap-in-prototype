// Offline codes, computed in the browser exactly as the server does (src/lib/codes.js, src/lib/schedule.js).
// The pass holder's phone makes rolling codes from its pass key; a signed-in scanner checks codes against the
// list and event key it downloaded. Both keep working with no signal.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LIVE_STEP = 30;
const LIVE_GRACE = 2;
const enc = new TextEncoder();

export const normaliseCode = (s) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffffff;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const keys = new Map();
async function hmac(secret, data) {
  let k = keys.get(secret);
  if (!k) { k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); keys.set(secret, k); }
  return new Uint8Array(await crypto.subtle.sign('HMAC', await k, enc.encode(data)));
}

const encodeWindow = (w) => { let out = ''; for (let i = 0; i < 6; i++) { out = B32[w % 32] + out; w = Math.floor(w / 32); } return out; };
const decodeWindow = (s) => [...s].reduce((n, c) => n * 32 + B32.indexOf(c), 0);
const windowOf = (sec) => Math.floor(sec / LIVE_STEP);
const fresh = (win, now) => { const age = windowOf(now) - decodeWindow(win); return age >= -1 && age <= LIVE_GRACE; };
const safeEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

// The phone: a new code every 30 seconds from the pass key, no connection needed.
export async function rollingToken(passKey, id, nowSec) {
  const win = encodeWindow(windowOf(nowSec));
  const s = id + win + base32(await hmac(passKey, 'roll|' + win)).slice(0, 10);
  return `TR-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}-${s.slice(20, 26)}`;
}
export const secondsLeft = (nowSec) => LIVE_STEP - (Math.floor(nowSec) % LIVE_STEP);

// The scanner: work out what a scanned code is, using only the downloaded list.
//   { kind: 'pass', id, rolling, live, stale }  or  { kind: 'guest', id }  or  { kind: 'import', hash }
export async function identify(raw, eventKey, nowSec) {
  const c = normaliseCode(raw);
  let m;
  if ((m = /^TR([0-9A-Z]{26})$/.exec(c))) {
    const id = m[1].slice(0, 10), win = m[1].slice(10, 16), mac = m[1].slice(16);
    const passKey = base64url(await hmac(eventKey, 'pass|' + id));
    const good = safeEqual(base32(await hmac(passKey, 'roll|' + win)).slice(0, 10), mac);
    if (!good) return { kind: 'import', hash: await codeHash(eventKey, raw) };
    return { kind: 'pass', id, rolling: true, stale: !fresh(win, nowSec) };
  }
  // Server-made live codes cannot be checked offline; their window still tells us if they are stale.
  if ((m = /^TQ([0-9A-Z]{26})$/.exec(c))) return { kind: 'pass', id: m[1].slice(0, 10), live: true, unverified: true, stale: !fresh(m[1].slice(10, 16), nowSec) };
  if ((m = /^TP([0-9A-Z]{20})$/.exec(c))) return { kind: 'pass', id: m[1].slice(0, 10), unverified: true };
  if ((m = /^TG([0-9A-Z]{20})$/.exec(c))) return { kind: 'guest', id: m[1].slice(0, 10), unverified: true };
  return { kind: 'import', hash: await codeHash(eventKey, raw) };
}
export const codeHash = async (eventKey, code) => hex(await hmac(eventKey, 'code|' + normaliseCode(code)));
function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same rule as src/lib/schedule.js: days and hours in the event's time zone.
export function withinSchedule(t, at, tzOffsetMin = 60) {
  if (t.days_mask === 127 && t.from_min === 0 && t.to_min === 1440) return true;
  const local = at + tzOffsetMin * 60;
  const dow = (Math.floor(local / 86400) + 3) % 7;
  const minute = Math.floor((((local % 86400) + 86400) % 86400) / 60);
  return !!(t.days_mask & (1 << dow)) && minute >= t.from_min && minute < t.to_min;
}
