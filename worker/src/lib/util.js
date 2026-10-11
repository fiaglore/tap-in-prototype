// Dependency-free helpers shared by every route: randomness, hashing, validation.

// Crockford Base32: digits plus letters, without I, L, O, U, so codes survive being read aloud or typed.
export const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const nowSec = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();

// ---------- randomness (always crypto.getRandomValues, never Math.random) ----------

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// 256 is a multiple of 32, so (byte & 31) is perfectly uniform: no modulo bias.
export function randomBase32(len) {
  let s = '';
  for (const b of randomBytes(len)) s += B32[b & 31];
  return s;
}

// Uniform integer in [0, max) by rejection sampling, so 6-digit codes are not biased.
export function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

export const newId = (len = 12) => randomBase32(len);

// ---------- encoding ----------

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- keyed hashing ----------
// Every stored secret is HMAC-SHA-256(pepper, "<purpose>|<value>"). The pepper lives in a Worker
// secret, not in the database, so a leaked database alone cannot be used to find a valid code.
// The purpose prefix stops a hash made for one use from being replayed for another.

const keyCache = new Map();
async function hmacKey(secret) {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, k);
  }
  return k;
}

export async function hmacBytes(secret, data) {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function hmacHex(secret, data) {
  return toHex(await hmacBytes(secret, data));
}

// Constant-time comparison for equal-length strings.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Make typed codes forgiving: case, spaces and dashes do not matter; O reads as 0, I and L read as 1.
export const normaliseCode = (s) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

// ---------- identifiers ----------

export function normalisePhone(raw) {
  let s = String(raw ?? '').trim().replace(/[\s\-().]/g, '');
  if (/^00\d+$/.test(s)) s = '+' + s.slice(2);
  if (/^0\d{10}$/.test(s)) s = '+234' + s.slice(1); // 0803 412 7790
  else if (/^234\d{10}$/.test(s)) s = '+' + s; // 2348034127790
  else if (/^[789]\d{9}$/.test(s)) s = '+234' + s; // 803 412 7790
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

export function normaliseEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

export function parseIdentifier(raw) {
  const s = String(raw ?? '').trim();
  if (s.includes('@')) {
    const email = normaliseEmail(s);
    return email ? { kind: 'email', value: email } : null;
  }
  const phone = normalisePhone(s);
  return phone ? { kind: 'phone', value: phone } : null;
}

// ---------- input validation ----------

export function cleanText(v, field, { min = 1, max = 80, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw new HttpError(400, `invalid_${field}`, `Enter a ${field}.`);
  }
  if (typeof v !== 'string') throw new HttpError(400, `invalid_${field}`, `The ${field} must be text.`);
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < min || s.length > max) {
    throw new HttpError(400, `invalid_${field}`, `The ${field} must be ${min} to ${max} characters.`);
  }
  return s;
}

export function parseWhen(v, field = 'date') {
  if (v === undefined || v === null || v === '') return null;
  const ms = typeof v === 'number' ? v * 1000 : Date.parse(v);
  const s = Math.floor(ms / 1000);
  if (!Number.isFinite(s) || s < 946684800 || s > 4102444800) {
    throw new HttpError(400, `invalid_${field}`, `That ${field} is not valid.`);
  }
  return s;
}

export function clamp(n, lo, hi, dflt) {
  const x = Number.parseInt(n, 10);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
}
