// Organiser routes: create events, issue invite codes, see who is in. Every route here checks that the
// signed-in user owns the event; someone else's event answers 404, the same as one that does not exist.

import {
  HttpError,
  clamp,
  cleanText,
  newId,
  nowSec,
  parseIdentifier,
  parseWhen
} from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { parseSchedule, scheduleOut } from '../lib/schedule.js';
import { eventPrefix, hashGateKey, hashInvite, inviteHint, makeGateKey, makeInviteCode, tierCode } from '../lib/codes.js';

export const MAX_EVENTS_PER_USER = 20;
export const MAX_INVITES_PER_EVENT = 20000;
const MAX_BATCH = 500;
const MAX_PRICE_KOBO = 500_000_00; // ₦500,000, a sane ceiling for the demo

function assertOrganiser(env, user) {
  const allow = String(env.ORGANISER_IDENTIFIERS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allow.length) return;
  const mine = [user.phone, user.email].filter(Boolean).map((s) => s.toLowerCase());
  if (!mine.some((m) => allow.includes(m))) {
    throw new HttpError(403, 'not_an_organiser', 'This account is not allowed to create events.');
  }
}

async function ownedEvent(env, user, id) {
  const ev = await env.DB.prepare(
    `SELECT id, name, prefix, kind, venue, city, starts_at, allow_reentry, secure_qr, sales_start, sales_end, gate_key_hint, created_at
     FROM events WHERE id = ?1 AND owner_id = ?2`
  )
    .bind(String(id).slice(0, 40), user.id)
    .first();
  if (!ev) throw new HttpError(404, 'not_found', 'Event not found.');
  return ev;
}

const publicEvent = (e) => ({
  id: e.id,
  name: e.name,
  prefix: e.prefix,
  kind: e.kind,
  venue: e.venue,
  city: e.city,
  starts_at: e.starts_at,
  allow_reentry: !!e.allow_reentry,
  secure_qr: !!e.secure_qr,
  sales_start: e.sales_start,
  sales_end: e.sales_end,
  gate_key_hint: e.gate_key_hint,
  created_at: e.created_at
});

async function structure(env, eventId) {
  const zones = (await env.DB.prepare('SELECT id, name FROM zones WHERE event_id = ?1 ORDER BY sort, name').bind(eventId).all()).results;
  const tiers = (
    await env.DB.prepare(
      `SELECT id, name, price_kobo, capacity, days_mask, from_min, to_min,
        (SELECT COUNT(*) FROM invites i WHERE i.tier_id = tiers.id AND i.status != 'revoked') AS issued
       FROM tiers WHERE event_id = ?1 ORDER BY sort, name`
    )
      .bind(eventId)
      .all()
  ).results;
  const links = (
    await env.DB.prepare('SELECT tier_id, zone_id FROM tier_zones WHERE tier_id IN (SELECT id FROM tiers WHERE event_id = ?1)')
      .bind(eventId)
      .all()
  ).results;
  return {
    zones,
    tiers: tiers.map(({ days_mask, from_min, to_min, ...t }) => ({ ...t, schedule: scheduleOut({ days_mask, from_min, to_min }), zone_ids: links.filter((l) => l.tier_id === t.id).map((l) => l.zone_id) }))
  };
}

// A ticket-type limit: blank means no limit, otherwise a whole number from 1 to 1,000,000.
function parseCapacity(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : /^\d{1,7}$/.test(String(v).trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new HttpError(400, 'invalid_capacity', `Enter a ticket limit between 1 and 1,000,000 for "${name}", or leave it blank.`);
  return n;
}

function uniqueNames(list, label, min, max, maxLen) {
  if (!Array.isArray(list) || list.length < min || list.length > max) {
    throw new HttpError(400, `invalid_${label}s`, `Add between ${min} and ${max} ${label}s.`);
  }
  const seen = new Set();
  return list.map((raw) => {
    const name = cleanText(raw, label, { max: maxLen });
    if (seen.has(name.toLowerCase())) throw new HttpError(400, `duplicate_${label}`, `Two ${label}s are called "${name}".`);
    seen.add(name.toLowerCase());
    return name;
  });
}

// POST /api/events
export async function createEvent({ request, env, user }) {
  assertOrganiser(env, user);
  const b = await readJson(request);
  const kind = b.kind === undefined ? 'event' : b.kind;
  if (kind !== 'event' && kind !== 'workplace') throw new HttpError(400, 'invalid_kind', 'Choose event or workplace.');
  const workplace = kind === 'workplace';
  const name = cleanText(b.name, 'name', { min: 2, max: 80 });
  const venue = cleanText(b.venue, 'venue', { optional: true, max: 80 });
  const city = cleanText(b.city, 'city', { optional: true, max: 60 });
  const startsAt = parseWhen(b.starts_at, 'date');

  const zoneNames = uniqueNames(b.zones, 'zone', 1, 12, 40);
  if (!Array.isArray(b.tiers)) throw new HttpError(400, 'invalid_tiers', 'Add at least one ticket type.');
  const tierNames = uniqueNames(
    b.tiers.map((t) => t?.name),
    'ticket type',
    1,
    10,
    40
  );
  const zoneIndex = new Map(zoneNames.map((z, i) => [z.toLowerCase(), i]));
  const tierZones = b.tiers.map((t, ti) => {
    const wanted = Array.isArray(t.zones) ? t.zones : [];
    const idx = [...new Set(wanted.map((z) => zoneIndex.get(String(z).trim().toLowerCase())))];
    if (!idx.length || idx.includes(undefined)) {
      throw new HttpError(400, 'invalid_tier_zones', `Choose at least one valid zone for "${tierNames[ti]}".`);
    }
    return idx;
  });
  const tierSchedules = b.tiers.map((t, ti) => (workplace ? parseSchedule(t, tierNames[ti]) : parseSchedule({}, tierNames[ti])));
  const tierCaps = b.tiers.map((t, ti) => parseCapacity(t?.capacity, tierNames[ti]));
  const salesStart = parseWhen(b.sales_start, 'sales start');
  const salesEnd = parseWhen(b.sales_end, 'sales end');
  if (salesStart && salesEnd && salesEnd <= salesStart) throw new HttpError(400, 'invalid_sales_window', 'Ticket sales must end after they start.');
  const tierPrices = b.tiers.map((t, ti) => {
    if (t?.price_kobo === undefined || t?.price_kobo === null || t?.price_kobo === '') return 0;
    const p = Number.parseInt(t.price_kobo, 10);
    if (!Number.isInteger(p) || p < 0 || p > MAX_PRICE_KOBO) {
      throw new HttpError(400, 'invalid_price', `Enter a valid price for "${tierNames[ti]}".`);
    }
    return p;
  });

  const owned = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE owner_id = ?1').bind(user.id).first();
  if (owned.n >= MAX_EVENTS_PER_USER) throw new HttpError(400, 'event_limit', `You can have up to ${MAX_EVENTS_PER_USER} events.`);

  const id = newId(12);
  const now = nowSec();
  const zoneRows = zoneNames.map((n, i) => ({ id: newId(10), name: n, sort: i }));
  const tierRows = tierNames.map((n, i) => ({ id: newId(10), name: n, sort: i, price_kobo: tierPrices[i], capacity: tierCaps[i], ...tierSchedules[i] }));
  const linkRows = tierZones.flatMap((idxs, ti) => idxs.map((zi) => ({ t: tierRows[ti].id, z: zoneRows[zi].id })));
  const gateKey = makeGateKey();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (id, owner_id, name, prefix, venue, city, starts_at, allow_reentry, gate_key_hash, gate_key_hint, created_at, kind, secure_qr, sales_start, sales_end)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    ).bind(
      id,
      user.id,
      name,
      eventPrefix(name),
      venue,
      city,
      startsAt,
      workplace || b.allow_reentry ? 1 : 0, // people go in and out of an office all day
      await hashGateKey(env.SECRET_PEPPER, gateKey),
      gateKey.slice(-4),
      now,
      kind,
      b.secure_qr ? 1 : 0,
      salesStart,
      salesEnd
    ),
    env.DB.prepare(
      `INSERT INTO zones (id, event_id, name, sort)
       SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.name'), json_extract(value, '$.sort') FROM json_each(?2)`
    ).bind(id, JSON.stringify(zoneRows)),
    env.DB.prepare(
      `INSERT INTO tiers (id, event_id, name, sort, price_kobo, capacity, days_mask, from_min, to_min)
       SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.name'), json_extract(value, '$.sort'), json_extract(value, '$.price_kobo'), json_extract(value, '$.capacity'),
              json_extract(value, '$.days_mask'), json_extract(value, '$.from_min'), json_extract(value, '$.to_min') FROM json_each(?2)`
    ).bind(id, JSON.stringify(tierRows)),
    env.DB.prepare(
      `INSERT INTO tier_zones (tier_id, zone_id)
       SELECT json_extract(value, '$.t'), json_extract(value, '$.z') FROM json_each(?1)`
    ).bind(JSON.stringify(linkRows))
  ]);

  const ev = await ownedEvent(env, user, id);
  return json({ event: publicEvent(ev), ...(await structure(env, id)), gate_key: gateKey }, 201);
}

// GET /api/events
export async function listEvents({ env, user, url }) {
  const kind = url.searchParams.get('kind');
  const rows = (
    await env.DB.prepare(
      `SELECT e.id, e.name, e.kind, e.venue, e.city, e.starts_at, e.created_at,
        (SELECT COUNT(*) FROM passes p WHERE p.event_id = e.id AND p.status = 'active') AS registered,
        (SELECT COUNT(DISTINCT s.pass_id) FROM scans s WHERE s.event_id = e.id AND s.result = 'granted') AS checked_in,
        (SELECT COUNT(*) FROM invites i WHERE i.event_id = e.id AND i.status = 'unused') AS invites_open
       FROM events e WHERE e.owner_id = ?1 AND (?2 IS NULL OR e.kind = ?2) ORDER BY e.created_at DESC`
    )
      .bind(user.id, kind === 'event' || kind === 'workplace' ? kind : null)
      .all()
  ).results;
  return json({ events: rows });
}

async function recentScans(env, eventId, limit) {
  return (
    await env.DB.prepare(
      `SELECT s.id, s.result, s.reason, s.at, z.name AS zone, u.name AS holder, t.name AS tier
       FROM scans s
       LEFT JOIN zones z ON z.id = s.zone_id
       LEFT JOIN passes p ON p.id = s.pass_id
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN tiers t ON t.id = p.tier_id
       WHERE s.event_id = ?1 ORDER BY s.at DESC, s.id DESC LIMIT ?2`
    )
      .bind(eventId, limit)
      .all()
  ).results;
}

async function stats(env, eventId) {
  const q = (sql) => env.DB.prepare(sql).bind(eventId);
  const [reg, chk, den, scn, inv, byTier, byZone, volume] = await Promise.all([
    q("SELECT COUNT(*) AS n FROM passes WHERE event_id = ?1 AND status = 'active'").first(),
    q("SELECT COUNT(DISTINCT pass_id) AS n FROM scans WHERE event_id = ?1 AND result = 'granted'").first(),
    q("SELECT COUNT(*) AS n FROM scans WHERE event_id = ?1 AND result = 'denied'").first(),
    q('SELECT COUNT(*) AS n FROM scans WHERE event_id = ?1').first(),
    q('SELECT status, COUNT(*) AS n FROM invites WHERE event_id = ?1 GROUP BY status').all(),
    q(
      `SELECT t.id, t.name,
        (SELECT COUNT(*) FROM passes p WHERE p.tier_id = t.id AND p.status = 'active') AS registered,
        (SELECT COUNT(DISTINCT s.pass_id) FROM scans s JOIN passes p ON p.id = s.pass_id
          WHERE p.tier_id = t.id AND s.result = 'granted') AS checked_in
       FROM tiers t WHERE t.event_id = ?1 ORDER BY t.sort, t.name`
    ).all(),
    q(
      `SELECT z.id, z.name,
        (SELECT COUNT(*) FROM scans s WHERE s.zone_id = z.id AND s.result = 'granted') AS granted,
        (SELECT COUNT(*) FROM scans s WHERE s.zone_id = z.id AND s.result = 'denied') AS denied
       FROM zones z WHERE z.event_id = ?1 ORDER BY z.sort, z.name`
    ).all(),
    q(
      `SELECT (at / 3600) * 3600 AS hour, COUNT(*) AS n FROM scans
       WHERE event_id = ?1 AND result = 'granted' GROUP BY hour ORDER BY hour DESC LIMIT 24`
    ).all()
  ]);
  const invites = { unused: 0, claimed: 0, revoked: 0 };
  for (const r of inv.results) invites[r.status] = r.n;
  return {
    registered: reg.n,
    checked_in: chk.n,
    denied: den.n,
    scans: scn.n,
    invites,
    by_tier: byTier.results,
    by_zone: byZone.results,
    entry_volume: volume.results.reverse()
  };
}

// GET /api/events/:id
export async function getEvent({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  return json({
    event: publicEvent(ev),
    ...(await structure(env, ev.id)),
    stats: await stats(env, ev.id),
    recent: await recentScans(env, ev.id, 12)
  });
}

// PATCH /api/events/:id  { allow_reentry }
export async function patchEvent({ request, env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const b = await readJson(request);
  if (typeof b.allow_reentry === 'boolean') {
    await env.DB.prepare('UPDATE events SET allow_reentry = ?1 WHERE id = ?2').bind(b.allow_reentry ? 1 : 0, ev.id).run();
  }
  if (typeof b.secure_qr === 'boolean') {
    await env.DB.prepare('UPDATE events SET secure_qr = ?1 WHERE id = ?2').bind(b.secure_qr ? 1 : 0, ev.id).run();
  }
  if ('sales_start' in b || 'sales_end' in b) {
    const start = 'sales_start' in b ? parseWhen(b.sales_start, 'sales start') : ev.sales_start;
    const end = 'sales_end' in b ? parseWhen(b.sales_end, 'sales end') : ev.sales_end;
    if (start && end && end <= start) throw new HttpError(400, 'invalid_sales_window', 'Ticket sales must end after they start.');
    await env.DB.prepare('UPDATE events SET sales_start = ?1, sales_end = ?2 WHERE id = ?3').bind(start, end, ev.id).run();
  }
  return json({ event: publicEvent(await ownedEvent(env, user, ev.id)) });
}

// PATCH /api/events/:id/tiers/:tierId  { capacity?, price_kobo? }
// Raise or lower a ticket limit, or change the price for tickets sold from now on. A limit cannot be set
// below what has already been issued.
export async function patchTier({ request, env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const { tiers } = await structure(env, ev.id);
  const tier = tiers.find((t) => t.id === params.tierId);
  if (!tier) throw new HttpError(404, 'not_found', 'Ticket type not found.');
  const b = await readJson(request);
  let capacity = tier.capacity;
  let price = tier.price_kobo;
  if ('capacity' in b) {
    capacity = parseCapacity(b.capacity, tier.name);
    if (capacity !== null && capacity < tier.issued) {
      throw new HttpError(400, 'capacity_below_issued', `${tier.issued} "${tier.name}" tickets are already issued, so the limit cannot be lower than that.`);
    }
  }
  if ('price_kobo' in b) {
    price = Number.parseInt(b.price_kobo, 10);
    if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE_KOBO) throw new HttpError(400, 'invalid_price', `Enter a valid price for "${tier.name}".`);
  }
  await env.DB.prepare('UPDATE tiers SET capacity = ?1, price_kobo = ?2 WHERE id = ?3').bind(capacity, price, tier.id).run();
  return json({ ...(await structure(env, ev.id)) });
}

// GET /api/events/:id/scans?limit=
export async function listScans({ env, user, params, url }) {
  const ev = await ownedEvent(env, user, params.id);
  return json({ scans: await recentScans(env, ev.id, clamp(url.searchParams.get('limit'), 1, 100, 25)) });
}

// POST /api/events/:id/gate-key  -> a new gate key; the old one stops working immediately
export async function rotateGateKey({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const key = makeGateKey();
  await env.DB.prepare('UPDATE events SET gate_key_hash = ?1, gate_key_hint = ?2 WHERE id = ?3')
    .bind(await hashGateKey(env.SECRET_PEPPER, key), key.slice(-4), ev.id)
    .run();
  return json({ gate_key: key });
}

// Mints `count` invite codes for a tier and stores them as unused invites. Returns the plain codes
// and their row ids exactly once; only the hashes are stored, so the codes cannot be shown again.
// A clash on the unique hash is astronomically unlikely, but handled by drawing fresh codes.
export async function mintInvites(env, ev, tier, count, { label = null, bound = null, expires = null, accessUntil = null } = {}) {
  const year2 = String(new Date((ev.starts_at || nowSec()) * 1000).getUTCFullYear()).slice(-2);
  const base = { prefix: ev.prefix, year2, tier: tierCode(tier.name) };
  const now = nowSec();

  for (let attempt = 0; attempt < 3; attempt++) {
    const codes = [];
    const rows = [];
    for (let i = 0; i < count; i++) {
      const code = makeInviteCode(base);
      codes.push(code);
      rows.push({ id: newId(12), h: await hashInvite(env.SECRET_PEPPER, code), t: inviteHint(code) });
    }
    try {
      const r = await env.DB.prepare(
        `INSERT INTO invites (id, event_id, tier_id, code_hash, code_hint, label, bound_identifier, status, expires_at, access_until, created_at)
         SELECT json_extract(value, '$.id'), ?1, ?2, json_extract(value, '$.h'), json_extract(value, '$.t'), ?3, ?4, 'unused', ?5, ?8, ?6
         FROM json_each(?7)
         WHERE ?9 IS NULL OR (SELECT COUNT(*) FROM invites WHERE tier_id = ?2 AND status != 'revoked') + ?10 <= ?9`
      )
        .bind(ev.id, tier.id, label, bound, expires, now, JSON.stringify(rows), accessUntil, tier.capacity ?? null, count)
        .run();
      // The limit is checked inside the insert itself, so two buyers cannot both take the last ticket.
      if (r.meta.changes !== count) throw new HttpError(409, 'sold_out', `Not enough "${tier.name}" tickets left.`);
      return { codes, ids: rows.map((x) => x.id) };
    } catch (err) {
      if (!/UNIQUE constraint failed/i.test(String(err?.message)) || attempt === 2) throw err;
    }
  }
}

// POST /api/events/:id/invites  { tier_id, count, label?, bound_to?, expires_at? }
export async function createInvites({ request, env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const b = await readJson(request);
  const { tiers } = await structure(env, ev.id);
  const tier = tiers.find((t) => t.id === b.tier_id);
  if (!tier) throw new HttpError(400, 'invalid_tier', 'Choose a ticket type.');

  const count = Number.parseInt(b.count, 10);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
    throw new HttpError(400, 'invalid_count', `Create between 1 and ${MAX_BATCH} codes at a time.`);
  }
  const label = cleanText(b.label, 'label', { optional: true, max: 60 });
  let bound = null;
  if (b.bound_to) {
    if (count !== 1) throw new HttpError(400, 'invalid_bound', 'Tie a code to a phone or email one at a time.');
    const id = parseIdentifier(b.bound_to);
    if (!id) throw new HttpError(400, 'invalid_bound', 'That phone number or email is not valid.');
    bound = id.value;
  }
  const expires = parseWhen(b.expires_at, 'expiry');
  if (expires && expires <= nowSec()) throw new HttpError(400, 'invalid_expiry', 'The expiry must be in the future.');

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE event_id = ?1').bind(ev.id).first();
  if (total.n + count > MAX_INVITES_PER_EVENT) {
    throw new HttpError(400, 'invite_limit', `An event can have up to ${MAX_INVITES_PER_EVENT} invites.`);
  }

  const { codes } = await mintInvites(env, ev, tier, count, { label, bound, expires });
  return json({ tier: tier.name, label, codes }, 201);
}

// GET /api/events/:id/invites?status=&limit=&offset=
export async function listInvites({ env, user, params, url }) {
  const ev = await ownedEvent(env, user, params.id);
  const status = url.searchParams.get('status');
  const limit = clamp(url.searchParams.get('limit'), 1, 200, 50);
  const offset = clamp(url.searchParams.get('offset'), 0, 1_000_000, 0);
  const filter = ['unused', 'claimed', 'revoked'].includes(status) ? 'AND i.status = ?2' : '';
  const bind = filter ? [ev.id, status, limit, offset] : [ev.id, limit, offset];
  const lim = filter ? '?3 OFFSET ?4' : '?2 OFFSET ?3';
  const rows = (
    await env.DB.prepare(
      `SELECT i.id, i.code_hint, i.label, i.status, i.bound_identifier, i.expires_at, i.created_at, i.claimed_at,
              t.name AS tier, u.name AS claimed_by
       FROM invites i JOIN tiers t ON t.id = i.tier_id LEFT JOIN users u ON u.id = i.claimed_by
       WHERE i.event_id = ?1 ${filter} ORDER BY i.created_at DESC, i.id LIMIT ${lim}`
    )
      .bind(...bind)
      .all()
  ).results;
  return json({ invites: rows, limit, offset });
}

// POST /api/events/:id/invites/:inviteId/revoke   (unused invites only; claimed ones: revoke the pass)
export async function revokeInvite({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const r = await env.DB.prepare("UPDATE invites SET status = 'revoked' WHERE id = ?1 AND event_id = ?2 AND status = 'unused'")
    .bind(params.inviteId.slice(0, 40), ev.id)
    .run();
  if (r.meta.changes !== 1) throw new HttpError(409, 'not_revocable', 'Only unused invites can be cancelled.');
  return json({ ok: true });
}

// GET /api/events/:id/attendees
export async function listAttendees({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const rows = (
    await env.DB.prepare(
      `SELECT p.id, p.status, p.created_at, p.expires_at, t.name AS tier, u.name, u.phone, u.email,
        (SELECT MIN(s.at) FROM scans s WHERE s.pass_id = p.id AND s.result = 'granted') AS first_entry
       FROM passes p JOIN users u ON u.id = p.user_id JOIN tiers t ON t.id = p.tier_id
       WHERE p.event_id = ?1 ORDER BY p.created_at DESC LIMIT 500`
    )
      .bind(ev.id)
      .all()
  ).results;
  return json({
    attendees: rows.map((r) => ({
      id: r.id,
      status: r.status,
      tier: r.tier,
      name: r.name,
      contact: r.phone || r.email,
      registered_at: r.created_at,
      expires_at: r.expires_at,
      first_entry: r.first_entry
    }))
  });
}

// POST /api/events/:id/passes/:passId/revoke
export async function revokePass({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const r = await env.DB.prepare("UPDATE passes SET status = 'revoked' WHERE id = ?1 AND event_id = ?2 AND status = 'active'")
    .bind(params.passId.slice(0, 40), ev.id)
    .run();
  if (r.meta.changes !== 1) throw new HttpError(409, 'not_revocable', 'That pass is already cancelled.');
  return json({ ok: true });
}

const MAX_PEOPLE = 200;

// POST /api/events/:id/people  { tier_id, people: [{ contact, name? }], access_until? }
// Adds staff, contractors or visitors to a workplace by phone or email. Each person gets a code tied to
// their own contact, so it simply shows up in their Tap In app after they sign in; nothing is handed out.
// `access_until` (a date) makes the resulting passes stop working then. Invalid and duplicate contacts
// are reported back rather than failing the whole batch.
export async function addPeople({ request, env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const b = await readJson(request);
  const { tiers } = await structure(env, ev.id);
  const tier = tiers.find((t) => t.id === b.tier_id);
  if (!tier) throw new HttpError(400, 'invalid_tier', 'Choose an access group.');
  if (!Array.isArray(b.people) || !b.people.length || b.people.length > MAX_PEOPLE) {
    throw new HttpError(400, 'invalid_people', `Add between 1 and ${MAX_PEOPLE} people at a time.`);
  }
  const accessUntil = parseWhen(b.access_until, 'end date');
  if (accessUntil && accessUntil <= nowSec()) throw new HttpError(400, 'invalid_expiry', 'The end date must be in the future.');

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE event_id = ?1').bind(ev.id).first();
  if (total.n + b.people.length > MAX_INVITES_PER_EVENT) throw new HttpError(400, 'invite_limit', `A workplace can have up to ${MAX_INVITES_PER_EVENT} invites.`);

  const added = [];
  const skipped = [];
  const seen = new Set();
  for (const p of b.people) {
    const contact = String(p?.contact ?? '').trim();
    const id = parseIdentifier(contact);
    if (!id) {
      skipped.push({ contact: contact.slice(0, 80), reason: 'Not a valid phone number or email.' });
      continue;
    }
    if (seen.has(id.value)) {
      skipped.push({ contact: contact.slice(0, 80), reason: 'Listed twice.' });
      continue;
    }
    seen.add(id.value);
    const open = await env.DB.prepare(
      `SELECT 1 AS x FROM invites WHERE event_id = ?1 AND bound_identifier = ?2 AND tier_id = ?3 AND status = 'unused'
       UNION SELECT 1 FROM passes p JOIN users u ON u.id = p.user_id
         WHERE p.event_id = ?1 AND p.tier_id = ?3 AND p.status = 'active' AND (u.phone = ?2 OR u.email = ?2)`
    )
      .bind(ev.id, id.value, tier.id)
      .first();
    if (open) {
      skipped.push({ contact: id.value, reason: 'Already has access in this group.' });
      continue;
    }
    const label = cleanText(p?.name, 'name', { optional: true, max: 60 });
    await mintInvites(env, ev, tier, 1, { label, bound: id.value, accessUntil });
    added.push({ contact: id.value, name: label });
  }
  return json({ tier: tier.name, added, skipped }, 201);
}
