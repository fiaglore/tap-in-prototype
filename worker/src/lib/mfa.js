// Two-step sign-in with an authenticator app (TOTP, RFC 6238: SHA-1, 6 digits, 30 seconds), plus one-time recovery codes.
// The secret is encrypted at rest (AES-GCM, key derived from SECRET_PEPPER). Recovery codes are stored only as keyed hashes.
import { hmacHex, nowSec, randomBase32, randomBytes, safeEqual } from './util.js';

const RFC4648 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret() {
  const bytes = randomBytes(20);
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += RFC4648[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out; // 20 bytes = exactly 32 characters, no padding
}
function decodeSecret(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    const i = RFC4648.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export async function totp(secret, step) {
  const key = await crypto.subtle.importKey('raw', decodeSecret(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, step >>> 0);
  new DataView(msg.buffer).setUint32(0, Math.floor(step / 2 ** 32));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
export const currentStep = (t = nowSec()) => Math.floor(t / 30);

// Returns the matching step (within one step either side, for clock drift) or null.
export async function matchTotp(secret, code, t = nowSec()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = currentStep(t);
  for (const step of [now, now - 1, now + 1]) if (safeEqual(await totp(secret, step), c)) return step;
  return null;
}

async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mfa-secret|' + env.SECRET_PEPPER));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function sealSecret(env, secret) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(secret)));
  return b64(iv) + '.' + b64(ct);
}
export async function openSecret(env, sealed) {
  const [iv, ct] = String(sealed).split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct)));
}

export const makeRecoveryCodes = () => Array.from({ length: 8 }, () => { const r = randomBase32(10); return `${r.slice(0, 5)}-${r.slice(5)}`; });
export const normaliseRecovery = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
export const hashRecovery = (env, code) => hmacHex(env.SECRET_PEPPER, 'mfa-recovery|' + normaliseRecovery(code));

export function otpauthUri(secret, account) {
  return `otpauth://totp/${encodeURIComponent('Tap In:' + account)}?secret=${secret}&issuer=Tap%20In&algorithm=SHA1&digits=6&period=30`;
}

// Staff must use two-step sign-in unless STAFF_MFA is explicitly "off" (tests and local development).
export const staffMfaRequired = (env) => String(env.STAFF_MFA || 'on').toLowerCase() !== 'off';
// Organiser money actions (refunds) need it for organisers who turned it on; REQUIRE_ORGANISER_MFA=1 makes it mandatory for everyone.
export const organiserMfaMandatory = (env) => String(env.REQUIRE_ORGANISER_MFA || '0') === '1';
export const MFA_FRESH_SEC = 12 * 3600;
