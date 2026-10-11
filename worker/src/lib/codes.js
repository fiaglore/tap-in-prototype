// The three kinds of code Tap In generates, and how each one is made.
//
//  1. Invite code   PGF-26-VIP-7K4Q-9XM2   handed to an attendee, claimed once, stored only as a hash
//  2. One-time code 482913                 proves a phone or email belongs to the person signing in
//  3. Pass token    TP-8W3QZ-M4T0K-...     identifies a pass at the gate; the server can recompute it
//
// Plus the gate key staff use to authorise a scanner: GK-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX.

import { base32, hmacBytes, hmacHex, normaliseCode, randomBase32, randomInt } from './util.js';

// ---------- 1. invite codes ----------

function initialsOrStem(name, { first = 4 } = {}) {
  const words = String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'XX';
  // A short leading word such as "VIP" is already a good code.
  if (words[0].length <= 3 && words.length > 1 && /^[A-Z]+$/.test(words[0]) && first === 3) return words[0];
  let out = words.map((w) => w[0]).join('').slice(0, first);
  if (out.length < 2) out = words[0].slice(0, 3);
  return out.padEnd(2, 'X');
}

export const eventPrefix = (name) => initialsOrStem(name, { first: 4 }); // "Palm Grove Festival" -> PGF
export const tierCode = (name) => initialsOrStem(name, { first: 3 }); //    "VIP Access" -> VIP, "General Admission" -> GA

// Readable label (event, year, tier) plus 8 random characters = 40 bits of entropy.
// Only the random part protects the code; the label is a convenience for people.
export function makeInviteCode({ prefix, year2, tier }) {
  const r = randomBase32(8);
  return `${prefix}-${year2}-${tier}-${r.slice(0, 4)}-${r.slice(4)}`;
}

export const hashInvite = (pepper, code) => hmacHex(pepper, 'invite|' + normaliseCode(code));
export const inviteHint = (code) => code.slice(-4);

// ---------- 2. one-time sign-in codes ----------

export const makeOtp = () => String(randomInt(1_000_000)).padStart(6, '0');
// Six digits is only a million guesses, so the hash is keyed (pepper) and bound to the identifier.
export const hashOtp = (pepper, identifier, code) => hmacHex(pepper, `otp|${identifier}|${code}`);

// ---------- 3. pass tokens ----------
// token = "TP" + id (10 chars, stored) + mac (10 chars, never stored).
// mac = first 50 bits of HMAC(pepper, "pass|" + id). A database leak reveals no usable token, and a
// guessed token fails the check before the database is even queried. The gate verifies it the same way.

export async function passMac(pepper, id) {
  return base32(await hmacBytes(pepper, 'pass|' + id)).slice(0, 10);
}

export async function passToken(pepper, id) {
  const s = id + (await passMac(pepper, id));
  return `TP-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

export function parsePassToken(raw) {
  const m = /^TP([0-9A-Z]{20})$/.exec(normaliseCode(raw));
  return m ? { id: m[1].slice(0, 10), mac: m[1].slice(10) } : null;
}

// ---------- gate keys ----------

export function makeGateKey() {
  const r = randomBase32(24);
  return 'GK-' + r.match(/.{4}/g).join('-'); // 120 bits
}
export const hashGateKey = (pepper, key) => hmacHex(pepper, 'gate|' + normaliseCode(key));
