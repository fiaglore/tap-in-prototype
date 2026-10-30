// Guest lists: people who get in without a Tap In account.
//  - Invitations (weddings, private parties, launches): the organiser adds names, each guest gets a link that opens
//    their invitation, where they RSVP and find the QR code the usher scans. Plus-ones come in on the same code.
//  - Imported tickets: a list exported from another ticketer (or a bank-transfer spreadsheet). The printed codes are
//    checked at the gate like Tap In passes, so organisers can keep selling wherever they sell.

import { HttpError, cleanText, newId, normaliseCode, nowSec, parseIdentifier, safeEqual } from '../lib/util.js';
import { clientIp, json, readJson } from '../lib/http.js';
import { guestToken, hashGuestCode, inviteLinkMac, inviteLinkToken, parseInviteLinkToken, wristbandCode } from '../lib/codes.js';
import { isFull, record } from '../lib/limits.js';
import { ownedEvent } from './events.js';

const MAX_INVITES_PER_CALL = 500;
const MAX_IMPORT_PER_CALL = 1000;
const MAX_GUESTS_PER_EVENT = 20_000;
const MAX_PARTY = 20;

const partyOf = (v) => {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PARTY ? n : null;
};

async function eventTiers(env, eventId) {
  return (await env.DB.prepare('SELECT id, name FROM tiers WHERE event_id = ?1 ORDER BY sort, name').bind(eventId).all()).results;
}
function pickTier(tiers, id) {
  const t = tiers.find((x) => x.id === id);
  if (!t) throw new HttpError(400, 'invalid_tier', 'Choose which ticket type these guests get.');
  return t;
}
async function roomFor(env, eventId, n) {
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM guests WHERE event_id = ?1').bind(eventId).first();
  if (c.n + n > MAX_GUESTS_PER_EVENT) throw new HttpError(400, 'too_many_guests', `An event can hold up to ${MAX_GUESTS_PER_EVENT.toLocaleString('en-GB')} guests.`);
}

// GET /api/events/:id/guests -> the whole list, with each invitation's link, and the RSVP summary
export async function listGuests({ env, user, params, url }) {
  const ev = await ownedEvent(env, user, params.id);
  const rows = (
    await env.DB.prepare(
      `SELECT g.id, g.kind, g.name, g.contact, g.party_size, g.table_label, g.code_hint, g.rsvp, g.attending, g.rsvp_at, g.status, g.created_at,
        g.wristbanded, g.wristband_of, g.wb_seat, g.wb_seats,
        t.name AS tier,
        (SELECT MIN(s.at) FROM scans s WHERE s.guest_id = g.id AND s.result = 'granted') AS entered_at
       FROM guests g JOIN tiers t ON t.id = g.tier_id WHERE g.event_id = ?1 AND g.kind IN ('invite', 'import') ORDER BY g.created_at, g.name LIMIT ${MAX_GUESTS_PER_EVENT}`
    )
      .bind(ev.id)
      .all()
  ).results;
  const base = url.origin;
  const guests = await Promise.all(rows.map(async (g) => ({
    ...g,
    link: g.kind === 'invite' ? `${base}/i/#${await inviteLinkToken(env.SECRET_PEPPER, g.id)}` : null
  })));
  const active = guests.filter((g) => g.status === 'active');
  const invites = active.filter((g) => g.kind === 'invite');
  const people = (g) => (g.rsvp === 'yes' && g.attending ? g.attending : g.party_size);
  return json({
    guests,
    summary: {
      invitations: invites.length,
      invited_people: invites.reduce((n, g) => n + g.party_size, 0),
      yes: invites.filter((g) => g.rsvp === 'yes').length,
      yes_people: invites.filter((g) => g.rsvp === 'yes').reduce((n, g) => n + people(g), 0),
      no: invites.filter((g) => g.rsvp === 'no').length,
      pending: invites.filter((g) => g.rsvp === 'pending').length,
      imported: active.filter((g) => g.kind === 'import' && !g.wristband_of).length,
      wristbands: active.filter((g) => g.wristband_of).length,
      arrived: active.filter((g) => g.entered_at).length
    }
  });
}

// POST /api/events/:id/guests { tier_id, guests: [{ name, contact?, party_size?, table? }] } -> invitations
export async function addInvitations({ request, env, user, params, url }) {
  const ev = await ownedEvent(env, user, params.id);
  const b = await readJson(request, 256 * 1024);
  const tier = pickTier(await eventTiers(env, ev.id), b.tier_id);
  const list = Array.isArray(b.guests) ? b.guests : [];
  if (!list.length) throw new HttpError(400, 'no_guests', 'Add at least one guest.');
  if (list.length > MAX_INVITES_PER_CALL) throw new HttpError(400, 'too_many', `Add up to ${MAX_INVITES_PER_CALL} guests at a time.`);
  await roomFor(env, ev.id, list.length);

  const now = nowSec();
  const added = [];
  const skipped = [];
  const stmts = [];
  for (const [i, g] of list.entries()) {
    const line = i + 1;
    let name;
    try { name = cleanText(g && g.name, 'name', { max: 80 }); } catch { skipped.push({ line, reason: 'Missing name' }); continue; }
    let contact = null;
    if (g.contact) {
      const c = parseIdentifier(g.contact);
      if (!c) { skipped.push({ line, name, reason: 'Phone or email not recognised' }); continue; }
      contact = c.value;
    }
    const party = partyOf(g.party_size);
    if (!party) { skipped.push({ line, name, reason: `Party size must be 1 to ${MAX_PARTY}` }); continue; }
    let table = null;
    try { table = cleanText(g.table, 'table', { max: 30, optional: true }); } catch { skipped.push({ line, name, reason: 'Table name too long' }); continue; }
    const id = newId(10);
    stmts.push(env.DB.prepare(
      `INSERT INTO guests (id, event_id, tier_id, kind, name, contact, party_size, table_label, created_at) VALUES (?1, ?2, ?3, 'invite', ?4, ?5, ?6, ?7, ?8)`
    ).bind(id, ev.id, tier.id, name, contact, party, table, now));
    added.push({ id, name, contact, party_size: party, table_label: table, link: `${url.origin}/i/#${await inviteLinkToken(env.SECRET_PEPPER, id)}` });
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ tier: tier.name, added, skipped }, 201);
}

// POST /api/events/:id/guests/import { tier_id, rows: [{ code, name?, tier? }] } -> tickets sold elsewhere
// `tier` may name one of the event's ticket types; otherwise the chosen default applies. Repeated codes are skipped.
export async function importGuests({ request, env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const b = await readJson(request, 512 * 1024);
  const tiers = await eventTiers(env, ev.id);
  const fallback = pickTier(tiers, b.tier_id);
  const byName = new Map(tiers.map((t) => [t.name.trim().toLowerCase(), t]));
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) throw new HttpError(400, 'no_rows', 'The list is empty.');
  if (rows.length > MAX_IMPORT_PER_CALL) throw new HttpError(400, 'too_many', `Import up to ${MAX_IMPORT_PER_CALL} rows at a time.`);
  await roomFor(env, ev.id, rows.length);

  const now = nowSec();
  const skipped = [];
  const seen = new Set();
  const prepared = [];
  for (const [i, r] of rows.entries()) {
    const line = i + 1;
    const code = normaliseCode(r && r.code);
    if (code.length < 4 || code.length > 64) { skipped.push({ line, reason: 'Missing or unusable ticket code' }); continue; }
    if (seen.has(code)) { skipped.push({ line, reason: 'Same code appears earlier in this list' }); continue; }
    seen.add(code);
    let name = 'Guest';
    try { name = cleanText(r.name, 'name', { max: 80, optional: true }) || 'Guest'; } catch { /* keep "Guest" */ }
    const tier = (r.tier && byName.get(String(r.tier).trim().toLowerCase())) || fallback;
    prepared.push({ line, code, name, tier, hash: await hashGuestCode(env.SECRET_PEPPER, ev.id, code) });
  }
  let imported = 0;
  if (prepared.length) {
    const res = await env.DB.batch(prepared.map((p) => env.DB.prepare(
      `INSERT OR IGNORE INTO guests (id, event_id, tier_id, kind, name, party_size, code_hash, code_hint, created_at) VALUES (?1, ?2, ?3, 'import', ?4, 1, ?5, ?6, ?7)`
    ).bind(newId(10), ev.id, p.tier.id, p.name, p.hash, p.code.slice(-4), now)));
    res.forEach((r, k) => { if (r.meta.changes) imported++; else skipped.push({ line: prepared[k].line, reason: 'Already imported' }); });
  }
  skipped.sort((a, b2) => a.line - b2.line);
  return json({ imported, skipped }, 201);
}

// ---- Wristbands: a physical, per-person code for guests who are confirmed ---------------------------------
// Confirmed means: replied Yes to an invitation, holds a Tap In pass, or holds an imported ticket. Each person gets
// their own wristband (a party of 3 gets 3), stored as a guest row that points at what it was made for. Once a
// person has wristbands, their phone invitation, pass or old printed code stops admitting, so nobody gets in twice.

const MAX_WRISTBAND_PEOPLE = 200;
const MAX_WRISTBANDS_PER_CALL = 600;

// Everyone who may have wristbands, with how many and how many are already made. `entered` people are listed but
// refused: they are already inside.
async function confirmedPeople(env, eventId) {
  const q = (sql) => env.DB.prepare(sql).bind(eventId);
  const [invites, passes, imports, bands, entered] = await Promise.all([
    q(`SELECT g.id, g.name, g.table_label, g.party_size, g.attending, t.name AS tier, t.id AS tier_id
       FROM guests g JOIN tiers t ON t.id = g.tier_id
       WHERE g.event_id = ?1 AND g.kind = 'invite' AND g.status = 'active' AND g.rsvp = 'yes'`).all(),
    q(`SELECT p.id, u.name, t.name AS tier, t.id AS tier_id
       FROM passes p JOIN users u ON u.id = p.user_id JOIN tiers t ON t.id = p.tier_id
       WHERE p.event_id = ?1 AND p.status = 'active'`).all(),
    q(`SELECT g.id, g.name, g.table_label, t.name AS tier, t.id AS tier_id
       FROM guests g JOIN tiers t ON t.id = g.tier_id
       WHERE g.event_id = ?1 AND g.kind = 'import' AND g.wristband_of IS NULL AND g.name NOT LIKE 'Wristband-%' AND g.status = 'active'`).all(),
    q(`SELECT wristband_of AS origin, wb_seat AS seat, wb_gen AS gen, status FROM guests WHERE event_id = ?1 AND wristband_of IS NOT NULL`).all(),
    q(`SELECT DISTINCT COALESCE(pass_id, guest_id) AS id FROM scans WHERE event_id = ?1 AND result = 'granted'`).all()
  ]);
  const inside = new Set(entered.results.map((r) => r.id));
  const byOrigin = new Map();
  for (const r of bands.results) (byOrigin.get(r.origin) || byOrigin.set(r.origin, []).get(r.origin)).push(r);
  const person = (kind, row, seats, label) => {
    const rows = byOrigin.get(row.id) || [];
    return {
      kind, id: row.id, name: row.name, table: row.table_label || null, tier: row.tier, tier_id: row.tier_id, seats, source: label,
      made: new Set(rows.filter((r) => r.status === 'active').map((r) => r.seat)).size,
      entered: inside.has(row.id)
    };
  };
  return [
    ...invites.results.map((g) => person('guest', g, g.attending || g.party_size, 'Replied yes')),
    ...passes.results.map((p) => person('pass', p, 1, 'Tap In pass')),
    ...imports.results.map((g) => person('guest', g, 1, 'Imported ticket'))
  ].sort((a, c) => a.name.localeCompare(c.name));
}

// GET /api/events/:id/wristbands -> the confirmed people, and how many wristbands each has
export async function listWristbandPeople({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  if (ev.kind !== 'event') throw new HttpError(400, 'not_an_event', 'Wristbands are for events.');
  return json({ people: await confirmedPeople(env, ev.id) });
}

// POST /api/events/:id/wristbands { people: [{ kind: 'guest' | 'pass', id }] }
// Makes whatever wristbands are missing for each person, then returns every active wristband for them (new and
// existing), so the same call prints, reprints, and replaces a cancelled one.
export async function makeWristbands({ request, env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  if (ev.kind !== 'event') throw new HttpError(400, 'not_an_event', 'Wristbands are for events.');
  const b = await readJson(request);
  const asked = Array.isArray(b.people) ? b.people : [];
  if (!asked.length) throw new HttpError(400, 'no_people', 'Choose who the wristbands are for.');
  if (asked.length > MAX_WRISTBAND_PEOPLE) throw new HttpError(400, 'too_many', `Choose up to ${MAX_WRISTBAND_PEOPLE} people at a time.`);

  const confirmed = new Map((await confirmedPeople(env, ev.id)).map((p) => [p.kind + ':' + p.id, p]));
  const picked = [];
  const seenKey = new Set();
  for (const a of asked) {
    const key = `${a && a.kind}:${a && a.id}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    const p = confirmed.get(key);
    if (!p) throw new HttpError(400, 'not_confirmed', 'Wristbands are only for confirmed guests: people who replied Yes, or hold a pass or an imported ticket.');
    if (p.entered) throw new HttpError(409, 'already_entered', `${p.name} is already inside, so they do not need a wristband.`);
    picked.push(p);
  }
  if (picked.reduce((n, p) => n + p.seats, 0) > MAX_WRISTBANDS_PER_CALL) throw new HttpError(400, 'too_many', `That is more than ${MAX_WRISTBANDS_PER_CALL} wristbands at once. Choose fewer people.`);

  const existing = (await env.DB.prepare(
    `SELECT id, wristband_of AS origin, wb_seat AS seat, wb_gen AS gen, status FROM guests WHERE event_id = ?1 AND wristband_of IN (SELECT value FROM json_each(?2))`
  ).bind(ev.id, JSON.stringify(picked.map((p) => p.id))).all()).results;
  const rowsOf = new Map();
  for (const r of existing) (rowsOf.get(r.origin + ':' + r.seat) || rowsOf.set(r.origin + ':' + r.seat, []).get(r.origin + ':' + r.seat)).push(r);
  await roomFor(env, ev.id, picked.reduce((n, p) => n + p.seats, 0));

  const now = nowSec();
  const stmts = [];
  const out = [];
  for (const p of picked) {
    for (let seat = 1; seat <= p.seats; seat++) {
      const rows = rowsOf.get(`${p.id}:${seat}`) || [];
      let gen = (rows.find((r) => r.status === 'active') || {}).gen;
      if (gen === undefined) {
        gen = rows.length; // every earlier wristband for this seat was cancelled: a new generation, a new code
        const code = await wristbandCode(env.SECRET_PEPPER, ev.id, p.id, seat, gen);
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO guests (id, event_id, tier_id, kind, name, party_size, table_label, code_hash, code_hint, wristband_of, wb_seat, wb_seats, wb_gen, created_at)
           VALUES (?1, ?2, ?3, 'import', ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
        ).bind(newId(10), ev.id, p.tier_id, p.name, p.table, await hashGuestCode(env.SECRET_PEPPER, ev.id, code), code.slice(-4), p.id, seat, p.seats, gen, now));
      }
      out.push({ name: p.name, table: p.table, tier: p.tier, seat, seats: p.seats, code: await wristbandCode(env.SECRET_PEPPER, ev.id, p.id, seat, gen) });
    }
    // The original code stops admitting from now on.
    stmts.push(env.DB.prepare(`UPDATE ${p.kind === 'pass' ? 'passes' : 'guests'} SET wristbanded = 1 WHERE id = ?1 AND event_id = ?2`).bind(p.id, ev.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ wristbands: out }, 201);
}

// POST /api/events/:id/guests/:guestId/revoke -> the code and link stop working
export async function revokeGuest({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const r = await env.DB.prepare("UPDATE guests SET status = 'revoked' WHERE id = ?1 AND event_id = ?2 AND status = 'active'")
    .bind(String(params.guestId).slice(0, 40), ev.id)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found', 'Guest not found.');
  return json({ ok: true });
}

// ---- The guest's side: open the invitation, RSVP. No account; the link is the key. ----------------------

export async function invitationFor(request, env, token) {
  const bucket = 'invite:ip:' + clientIp(request);
  if (await isFull(env.DB, bucket, 30, 600)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
  const t = parseInviteLinkToken(token);
  const ok = t && safeEqual(await inviteLinkMac(env.SECRET_PEPPER, t.id), t.mac);
  const g = ok
    ? await env.DB.prepare(
        `SELECT g.id, g.name, g.party_size, g.table_label, g.rsvp, g.attending, g.status, g.kind, g.host, g.purpose, g.valid_from, g.valid_until,
          e.name AS event_name, e.venue, e.city, e.starts_at, e.allow_reentry, e.kind AS event_kind, t.name AS tier
         FROM guests g JOIN events e ON e.id = g.event_id JOIN tiers t ON t.id = g.tier_id WHERE g.id = ?1 AND g.kind IN ('invite', 'visitor')`
      ).bind(t.id).first()
    : null;
  if (!g) {
    await record(env.DB, bucket);
    throw new HttpError(404, 'invitation_not_found', 'This invitation link is not valid. Ask the host to send it again.');
  }
  if (g.status !== 'active') throw new HttpError(410, 'invitation_cancelled', 'This invitation has been cancelled. Contact the host if you think this is a mistake.');
  return g;
}

const invitationOut = async (env, g) => ({
  kind: g.kind,
  event: { name: g.event_name, venue: g.venue, city: g.city, starts_at: g.starts_at, reentry: !!g.allow_reentry, kind: g.event_kind },
  guest: { name: g.name, party_size: g.party_size, table: g.table_label, tier: g.tier, rsvp: g.rsvp, attending: g.attending, host: g.host, purpose: g.purpose, valid_from: g.valid_from, valid_until: g.valid_until },
  code: await guestToken(env.SECRET_PEPPER, g.id)
});

// POST /api/invitation { token }  (POST so the link token never lands in a URL or a log)
export async function openInvitation({ request, env }) {
  const b = await readJson(request);
  return json(await invitationOut(env, await invitationFor(request, env, b.token)));
}

// POST /api/invitation/rsvp { token, response: 'yes'|'no', attending? }
export async function rsvp({ request, env }) {
  const b = await readJson(request);
  const g = await invitationFor(request, env, b.token);
  if (g.kind !== 'invite') throw new HttpError(400, 'not_an_invitation', 'Visitor passes do not need a reply.');
  if (b.response !== 'yes' && b.response !== 'no') throw new HttpError(400, 'invalid_response', 'Choose whether you are coming.');
  let attending = null;
  if (b.response === 'yes') {
    attending = b.attending === undefined ? g.party_size : Number(b.attending);
    if (!Number.isInteger(attending) || attending < 1 || attending > g.party_size) {
      throw new HttpError(400, 'invalid_attending', `This invitation is for up to ${g.party_size} ${g.party_size === 1 ? 'person' : 'people'}.`);
    }
  }
  await env.DB.prepare('UPDATE guests SET rsvp = ?1, attending = ?2, rsvp_at = ?3 WHERE id = ?4').bind(b.response, attending, nowSec(), g.id).run();
  return json(await invitationOut(env, { ...g, rsvp: b.response, attending }));
}

// ---- Tap In for Business: visitors ----------------------------------------------------------------------
// A visitor is invited ahead (the office sends a one-tap link: no app, no account) or checked in at the door as a
// walk-in. Their pass works only inside its window, by default the rest of the day in the office's time zone.

const MAX_VISIT_DAYS = 30;
// End of the local day (the office's time zone) that `at` falls in.
export const endOfDay = (at, tzOffsetMin = 60) => (Math.floor((at + tzOffsetMin * 60) / 86400) + 1) * 86400 - tzOffsetMin * 60;
const startOfDay = (at, tzOffsetMin = 60) => endOfDay(at, tzOffsetMin) - 86400;

function visitorFields(b) {
  const name = cleanText(b.name, 'name', { max: 80 });
  let contact = null;
  if (b.contact) {
    const c = parseIdentifier(b.contact);
    if (!c) throw new HttpError(400, 'invalid_contact', 'That phone number or email was not recognised.');
    contact = c.value;
  }
  const host = cleanText(b.host, 'host', { max: 80, optional: true });
  const purpose = cleanText(b.purpose, 'purpose', { max: 120, optional: true });
  return { name, contact, host, purpose };
}
async function workplace(env, ev) {
  if (ev.kind !== 'workplace') throw new HttpError(400, 'not_an_office', 'Visitors are for Tap In for Business offices.');
  return (await env.DB.prepare('SELECT tz_offset_min FROM events WHERE id = ?1').bind(ev.id).first()).tz_offset_min;
}
const visitorOut = async (env, origin, g) => ({ ...g, link: `${origin}/i/#${await inviteLinkToken(env.SECRET_PEPPER, g.id)}` });

// POST /api/events/:id/visitors { tier_id, name, contact?, host?, purpose?, valid_from?, valid_until? }
export async function addVisitor({ request, env, user, params, url }) {
  const ev = await ownedEvent(env, user, params.id);
  const tz = await workplace(env, ev);
  const b = await readJson(request);
  const tier = pickTier(await eventTiers(env, ev.id), b.tier_id);
  const f = visitorFields(b);
  const now = nowSec();
  const parse = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw new HttpError(400, 'invalid_window', `Enter a valid ${label}.`);
    return Math.floor(t / 1000);
  };
  const from = parse(b.valid_from, 'start time') ?? startOfDay(now, tz);
  const until = parse(b.valid_until, 'end time') ?? endOfDay(from, tz);
  if (until <= from) throw new HttpError(400, 'invalid_window', 'The visit must end after it starts.');
  if (until <= now) throw new HttpError(400, 'invalid_window', 'That visit has already ended. Choose a time that has not passed.');
  if (until - from > MAX_VISIT_DAYS * 86400) throw new HttpError(400, 'invalid_window', `A visitor pass can last up to ${MAX_VISIT_DAYS} days. Add longer-term people under "Add people".`);
  await roomFor(env, ev.id, 1);
  const id = newId(10);
  await env.DB.prepare(
    `INSERT INTO guests (id, event_id, tier_id, kind, name, contact, host, purpose, valid_from, valid_until, created_at) VALUES (?1, ?2, ?3, 'visitor', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(id, ev.id, tier.id, f.name, f.contact, f.host, f.purpose, from, until, now).run();
  return json({ visitor: await visitorOut(env, url.origin, { id, name: f.name, contact: f.contact, host: f.host, purpose: f.purpose, tier: tier.name, valid_from: from, valid_until: until, walk_in: 0, status: 'active', entered_at: null }) }, 201);
}

// GET /api/events/:id/visitors -> visits from the last 30 days and upcoming ones, newest first
export async function listVisitors({ env, user, params, url }) {
  const ev = await ownedEvent(env, user, params.id);
  await workplace(env, ev);
  const rows = (
    await env.DB.prepare(
      `SELECT g.id, g.name, g.contact, g.host, g.purpose, g.valid_from, g.valid_until, g.walk_in, g.status, g.created_at, t.name AS tier,
        (SELECT MIN(s.at) FROM scans s WHERE s.guest_id = g.id AND s.result = 'granted') AS entered_at
       FROM guests g JOIN tiers t ON t.id = g.tier_id
       WHERE g.event_id = ?1 AND g.kind = 'visitor' AND g.valid_until > ?2 ORDER BY g.valid_from DESC, g.created_at DESC LIMIT 2000`
    ).bind(ev.id, nowSec() - 30 * 86400).all()
  ).results;
  return json({ visitors: await Promise.all(rows.map((g) => visitorOut(env, url.origin, g))) });
}
