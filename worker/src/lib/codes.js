// The three kinds of code Tap In generates, and how each one is made.
//
//  1. Invite code   PGF-26-VIP-7K4Q-9XM2   handed to an attendee, claimed once, stored only as a hash
//  2. One-time code 482913                 proves a phone or email belongs to the person signing in
//  3. Pass token    TP-8W3QZ-M4T0K-...     identifies a pass at the gate; the server can recompute it
//
// Plus the gate key staff use to authorise a scanner: GK-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX.

import { B32, base32, hmacBytes, hmacHex, normaliseCode, randomBase32, randomInt } from './util.js';

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

// ---------- 3b. live (rotating) pass tokens ----------
// token = "TQ" + id (10) + window (6, base32 of the 30-second window number) + mac (10).
// mac = HMAC(pepper, "live|" + id + "|" + window). Only a phone that asked the server in the last
// minute or so holds a token the gate will accept, so a screenshot goes stale almost at once.

export const LIVE_STEP = 30; // seconds per window
export const LIVE_GRACE = 2; // windows after the current one that the gate still accepts (about 90 s in all)

const encodeWindow = (w) => {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out = B32[w % 32] + out;
    w = Math.floor(w / 32);
  }
  return out;
};
const decodeWindow = (s) => [...s].reduce((n, c) => n * 32 + B32.indexOf(c), 0);
export const liveWindow = (nowSec) => Math.floor(nowSec / LIVE_STEP);

async function liveMac(pepper, id, win) {
  return base32(await hmacBytes(pepper, `live|${id}|${win}`)).slice(0, 10);
}

export async function liveToken(pepper, id, nowSec) {
  const win = encodeWindow(liveWindow(nowSec));
  const s = id + win + (await liveMac(pepper, id, win));
  return `TQ-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}-${s.slice(20, 26)}`;
}

export function parseLiveToken(raw) {
  const m = /^TQ([0-9A-Z]{26})$/.exec(normaliseCode(raw));
  return m ? { id: m[1].slice(0, 10), win: m[1].slice(10, 16), mac: m[1].slice(16) } : null;
}

// Is the window recent enough, and does the mac match? (Caller compares in constant time.)
export function liveWindowFresh(win, nowSec) {
  const age = liveWindow(nowSec) - decodeWindow(win);
  return age >= -1 && age <= LIVE_GRACE; // one window of clock skew into the future
}
export const liveMacFor = liveMac;

// ---------- gate keys ----------

export function makeGateKey() {
  const r = randomBase32(24);
  return 'GK-' + r.match(/.{4}/g).join('-'); // 120 bits
}
export const hashGateKey = (pepper, key) => hmacHex(pepper, 'gate|' + normaliseCode(key));

// ---------- pay codes and till keys ----------
// A pay code is what a customer shows a vendor: "TPAY" + user id (12) + amount in kobo (6, base32)
// + minute window (6) + nonce (4) + mac (10). The amount is inside the signed code, so a vendor
// cannot charge more than the customer chose, and the till key alone cannot create a charge.

export const PAY_STEP = 60; // seconds per window
export const PAY_WINDOWS = 5; // a code is good for about five minutes
export const MAX_PAY_KOBO = 100_000_00; // N100,000 per payment

const enc = (n, len) => {
  let out = '';
  for (let i = 0; i < len; i++) {
    out = B32[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
};
const dec = (s) => [...s].reduce((n, c) => n * 32 + B32.indexOf(c), 0);

const payMac = async (pepper, id, amt, win, nonce) => base32(await hmacBytes(pepper, `pay|${id}|${amt}|${win}|${nonce}`)).slice(0, 10);

export async function makePayCode(pepper, userId, amountKobo, nowSec) {
  const amt = enc(amountKobo, 6);
  const win = enc(Math.floor(nowSec / PAY_STEP), 6);
  const nonce = randomBase32(4);
  const s = userId + amt + win + nonce + (await payMac(pepper, userId, amt, win, nonce));
  return 'TPAY-' + s.match(/.{1,6}/g).join('-');
}

export function parsePayCode(raw) {
  const m = /^TPAY([0-9A-Z]{12})([0-9A-Z]{6})([0-9A-Z]{6})([0-9A-Z]{4})([0-9A-Z]{10})$/.exec(normaliseCode(raw));
  return m ? { id: m[1], amt: m[2], win: m[3], nonce: m[4], mac: m[5], amountKobo: dec(m[2]), minute: dec(m[3]) } : null;
}
export const payCodeMac = payMac;
export const payCodeFresh = (p, nowSec) => {
  const age = Math.floor(nowSec / PAY_STEP) - p.minute;
  return age >= -1 && age <= PAY_WINDOWS;
};
// What the ledger remembers, so one code can only ever be charged once.
export const payCodeRef = (p) => `${p.id}${p.amt}${p.win}${p.nonce}`;

export function makeTillKey() {
  return 'TK-' + randomBase32(24).match(/.{4}/g).join('-'); // 120 bits
}
export const hashTillKey = (pepper, key) => hmacHex(pepper, 'till|' + normaliseCode(key));
