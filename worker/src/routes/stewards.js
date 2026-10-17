// Gate team and the event report.
// Each steward gets their own scanner key, so the scan log says who admitted whom. The report turns that log
// into what an organiser needs after the night: how many came in and how fast, what was refused and why,
// and anything worth a second look.

import { HttpError, cleanText, newId, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { hashStewardKey, makeStewardKey } from '../lib/codes.js';
import { ownedEvent } from './events.js';

const MAX_STEWARDS = 100;
const MAX_REPORT_SCANS = 200_000;

async function stewardRows(env, eventId) {
  return (
    await env.DB.prepare(
      `SELECT s.id, s.name, s.key_hint, s.created_at, s.revoked_at, s.last_seen_at,
        (SELECT COUNT(*) FROM scans c WHERE c.steward_id = s.id AND c.result = 'granted') AS admits,
        (SELECT COUNT(*) FROM scans c WHERE c.steward_id = s.id AND c.result = 'denied') AS refusals
       FROM stewards s WHERE s.event_id = ?1 ORDER BY s.revoked_at IS NOT NULL, s.created_at`
    )
      .bind(eventId)
      .all()
  ).results;
}

// GET /api/events/:id/stewards
export async function listStewards({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  return json({ stewards: await stewardRows(env, ev.id) });
}

// POST /api/events/:id/stewards { name } -> the steward's scanner key, shown once
export async function createSteward({ request, env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const b = await readJson(request);
  const name = cleanText(b.name, 'name', { max: 60 });
  const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM stewards WHERE event_id = ?1 AND revoked_at IS NULL').bind(ev.id).first();
  if (active.n >= MAX_STEWARDS) throw new HttpError(400, 'too_many_stewards', `An event can have up to ${MAX_STEWARDS} stewards at a time. Remove some first.`);
  const key = makeStewardKey();
  const id = newId(12);
  const now = nowSec();
  await env.DB.prepare('INSERT INTO stewards (id, event_id, name, key_hash, key_hint, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id, ev.id, name, await hashStewardKey(env.SECRET_PEPPER, key), key.slice(-4), now)
    .run();
  return json({ steward: { id, name, key_hint: key.slice(-4), created_at: now, revoked_at: null, last_seen_at: null, admits: 0, refusals: 0 }, key }, 201);
}

// POST /api/events/:id/stewards/:stewardId/revoke -> their scanner stops working at the next scan
export async function revokeSteward({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const r = await env.DB.prepare('UPDATE stewards SET revoked_at = ?1 WHERE id = ?2 AND event_id = ?3 AND revoked_at IS NULL')
    .bind(nowSec(), String(params.stewardId).slice(0, 40), ev.id)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found', 'Steward not found.');
  return json({ stewards: await stewardRows(env, ev.id) });
}

// ---- Report ------------------------------------------------------------------------------------------

// Every refusal reason falls into one plain-language group.
export const REFUSAL_GROUPS = {
  invalid_token: 'fake',
  already_used: 'reused',
  stale_code: 'screenshot',
  static_pass: 'screenshot',
  revoked: 'cancelled',
  no_zone_access: 'wrong_area',
  wrong_event: 'wrong_area',
  outside_hours: 'timing',
  expired: 'timing'
};
// Groups that are someone trying to get in without a valid ticket of their own.
const FRAUD_GROUPS = ['fake', 'reused', 'screenshot', 'cancelled'];
// Groups used for the "value protected" estimate: each could have been a ticket sale.
const VALUE_GROUPS = ['fake', 'reused', 'screenshot'];

const lagosTime = (sec) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' }).format(new Date(sec * 1000));

// Entries per bucket from first to last entry, with a bucket size that keeps the chart under ~100 bars.
function series(times) {
  if (!times.length) return { bucket_secs: 300, points: [] };
  const first = times[0], last = times[times.length - 1];
  const size = [300, 900, 1800, 3600, 10800, 86400].find((s) => (last - first) / s <= 96) || 86400;
  const start = Math.floor(first / size) * size;
  const counts = new Array(Math.floor((last - start) / size) + 1).fill(0);
  for (const t of times) counts[Math.floor((t - start) / size)]++;
  return { bucket_secs: size, points: counts.map((n, i) => ({ t: start + i * size, n })) };
}

// The busiest single minute, and the average rate over the minutes in which anyone was let in.
function rates(times) {
  const perMin = new Map();
  for (const t of times) { const m = Math.floor(t / 60); perMin.set(m, (perMin.get(m) || 0) + 1); }
  let peak = 0, peakAt = null;
  for (const [m, n] of perMin) if (n > peak) { peak = n; peakAt = m * 60; }
  return { peak_per_min: peak, peak_at: peakAt, avg_per_active_min: perMin.size ? Math.round((times.length / perMin.size) * 10) / 10 : 0 };
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export function buildReport(ev, { scans, passes, tiers, zones, stewards, guests = [] }) {
  const tierById = new Map(tiers.map((t) => [t.id, t]));
  // A ticket is a Tap In pass or a guest (invitation or imported ticket); both are counted the same way.
  const holderKey = (s) => s.pass_id || (s.guest_id ? 'g:' + s.guest_id : null);
  passes = passes.concat(guests.map((g) => ({ id: 'g:' + g.id, tier_id: g.tier_id, status: g.status })));
  const activePasses = passes.filter((p) => p.status === 'active');
  const granted = scans.filter((s) => s.result === 'granted');
  const denied = scans.filter((s) => s.result === 'denied');
  const inPasses = new Set(granted.map(holderKey));
  const firstEntries = new Set(granted.map((s) => holderKey(s) + '|' + s.zone_id));

  // Refusals, by reason and by group.
  const byReason = {};
  const byGroup = { fake: 0, reused: 0, screenshot: 0, cancelled: 0, wrong_area: 0, timing: 0 };
  for (const s of denied) {
    byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    const g = REFUSAL_GROUPS[s.reason];
    if (g) byGroup[g]++;
  }
  const attempts = FRAUD_GROUPS.reduce((n, g) => n + byGroup[g], 0);
  const valueAttempts = VALUE_GROUPS.reduce((n, g) => n + byGroup[g], 0);
  const paid = activePasses.map((p) => (tierById.get(p.tier_id) || {}).price_kobo || 0).filter((k) => k > 0);
  const avgPrice = paid.length ? Math.round(paid.reduce((a, b) => a + b, 0) / paid.length) : null;

  // Speed: overall, per area and per steward (each steward is one lane).
  const times = granted.map((s) => s.at);
  const lane = (list) => ({ admits: list.filter((s) => s.result === 'granted').length, refusals: list.filter((s) => s.result === 'denied').length, ...rates(list.filter((s) => s.result === 'granted').map((s) => s.at)) });
  const group = (key) => { const m = new Map(); for (const s of scans) { const k = s[key] ?? null; if (!m.has(k)) m.set(k, []); m.get(k).push(s); } return m; };

  const byZone = group('zone_id');
  const zonesOut = zones.map((z) => ({ id: z.id, name: z.name, ...lane(byZone.get(z.id) || []) }));

  const bySteward = group('steward_id');
  const stewardsOut = stewards.map((st) => {
    const list = bySteward.get(st.id) || [];
    const l = lane(list);
    return { id: st.id, name: st.name, removed: !!st.revoked_at, ...l, refusal_rate: pct(l.refusals, l.admits + l.refusals), first_at: list[0]?.at ?? null, last_at: list[list.length - 1]?.at ?? null };
  }).filter((s) => s.admits + s.refusals > 0 || !s.removed);
  const shared = bySteward.get(null) || [];
  const sharedOut = shared.length ? { ...lane(shared), refusal_rate: pct(shared.filter((s) => s.result === 'denied').length, shared.length) } : null;

  const tiersOut = tiers.map((t) => {
    const ids = activePasses.filter((p) => p.tier_id === t.id).map((p) => p.id);
    const came = ids.filter((id) => inPasses.has(id)).length;
    return { id: t.id, name: t.name, issued: ids.length, came, pct: pct(came, ids.length) };
  });

  // Things worth a second look. Each is a prompt to check, not proof of wrongdoing.
  const flags = [];
  const overallRefusal = pct(denied.length, scans.length);
  if (shared.length) {
    flags.push({ level: stewards.length ? 'warn' : 'info', text: `${shared.length} scan${shared.length === 1 ? ' was' : 's were'} made with the shared gate key, so ${shared.length === 1 ? 'it' : 'they'} cannot be traced to a named steward. Give each steward their own scanner link.` });
  }
  for (const st of stewardsOut) {
    if (st.admits >= 50 && st.refusals === 0 && overallRefusal >= 3) {
      flags.push({ level: 'warn', text: `${st.name} let in ${st.admits} people and refused none, while ${overallRefusal}% of scans across the event were refused. Worth a look at their lane.` });
    }
  }
  const reusedPerPass = new Map();
  for (const s of denied) if (s.reason === 'already_used' && holderKey(s)) reusedPerPass.set(holderKey(s), (reusedPerPass.get(holderKey(s)) || 0) + 1);
  const heavy = [...reusedPerPass.values()].filter((n) => n >= 3).length;
  if (heavy) flags.push({ level: 'warn', text: `${heavy} ticket${heavy === 1 ? ' was' : 's were'} shown again 3 or more times after first entry. That usually means a shared screenshot or a ticket passed back out.` });
  // Bursts: 5 or more fake codes at one area within two minutes.
  for (const z of zones) {
    const fakes = denied.filter((s) => s.zone_id === z.id && s.reason === 'invalid_token').map((s) => s.at);
    for (let i = 0; i + 4 < fakes.length; ) {
      let j = i + 4;
      if (fakes[j] - fakes[i] <= 120) {
        while (j + 1 < fakes.length && fakes[j + 1] - fakes[i] <= 600) j++;
        flags.push({ level: 'warn', text: `A burst of ${j - i + 1} fake or unreadable codes at ${z.name} around ${lagosTime(fakes[i])}.` });
        i = j + 1;
      } else i++;
    }
  }

  return {
    event: { id: ev.id, name: ev.name, kind: ev.kind, venue: ev.venue, city: ev.city, starts_at: ev.starts_at, allow_reentry: !!ev.allow_reentry },
    generated_at: nowSec(),
    totals: {
      issued: activePasses.length,
      cancelled: passes.length - activePasses.length,
      came: inPasses.size,
      no_shows: activePasses.filter((p) => !inPasses.has(p.id)).length,
      attendance_pct: pct(activePasses.filter((p) => inPasses.has(p.id)).length, activePasses.length),
      scans: scans.length,
      admits: granted.length,
      reentries: granted.length - firstEntries.size,
      refusals: denied.length,
      refusal_pct: overallRefusal,
      first_entry: times[0] ?? null,
      last_entry: times[times.length - 1] ?? null
    },
    speed: { ...rates(times), series: series(times) },
    refusals: { by_group: byGroup, by_reason: byReason },
    fraud: {
      attempts,
      value_attempts: valueAttempts,
      avg_ticket_kobo: avgPrice,
      est_value_kobo: avgPrice === null ? null : valueAttempts * avgPrice
    },
    guest_list: guests.length ? {
      invitations: guests.filter((g) => g.kind === 'invite' && g.status === 'active').length,
      imported: guests.filter((g) => g.kind === 'import' && g.status === 'active').length,
      rsvp_yes: guests.filter((g) => g.kind === 'invite' && g.status === 'active' && g.rsvp === 'yes').length,
      arrived: guests.filter((g) => g.status === 'active' && inPasses.has('g:' + g.id)).length
    } : null,
    zones: zonesOut,
    tiers: tiersOut,
    stewards: stewardsOut,
    shared_key: sharedOut,
    flags,
    truncated: scans.length >= MAX_REPORT_SCANS
  };
}

async function reportData(env, eventId) {
  const q = (sql) => env.DB.prepare(sql).bind(eventId);
  const [scans, passes, tiers, zones, stewards, guests] = await Promise.all([
    q(`SELECT id, pass_id, guest_id, zone_id, steward_id, result, reason, at FROM scans WHERE event_id = ?1 ORDER BY at, id LIMIT ${MAX_REPORT_SCANS}`).all(),
    q('SELECT id, tier_id, status FROM passes WHERE event_id = ?1').all(),
    q('SELECT id, name, price_kobo FROM tiers WHERE event_id = ?1 ORDER BY sort, name').all(),
    q('SELECT id, name FROM zones WHERE event_id = ?1 ORDER BY sort, name').all(),
    q('SELECT id, name, revoked_at FROM stewards WHERE event_id = ?1 ORDER BY created_at').all(),
    q('SELECT id, tier_id, kind, status, rsvp FROM guests WHERE event_id = ?1').all()
  ]);
  return { scans: scans.results, passes: passes.results, tiers: tiers.results, zones: zones.results, stewards: stewards.results, guests: guests.results };
}

// GET /api/events/:id/report
export async function eventReport({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  return json(buildReport(ev, await reportData(env, ev.id)));
}

// GET /api/events/:id/scans.csv -> every scan, for the organiser's own records. No phone numbers or emails.
const REASON_TEXT = {
  invalid_token: 'Fake or unreadable code', already_used: 'Already used', stale_code: 'Old code or screenshot', static_pass: 'Screenshot or printout',
  revoked: 'Cancelled pass', no_zone_access: 'Wrong area', wrong_event: 'Other event', outside_hours: 'Outside hours', expired: 'Pass expired'
};
// A cell that starts with = + - @ could run as a formula in a spreadsheet; prefix it so it stays text.
const cell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const lagosStamp = (sec) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(sec * 1000)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

export async function scansCsv({ env, user, params }) {
  const ev = await ownedEvent(env, user, params.id);
  const rows = (
    await env.DB.prepare(
      `SELECT s.at, s.result, s.reason, z.name AS zone, t.name AS tier, COALESCE(u.name, g.name) AS holder, st.name AS steward
       FROM scans s
       LEFT JOIN zones z ON z.id = s.zone_id
       LEFT JOIN passes p ON p.id = s.pass_id
       LEFT JOIN guests g ON g.id = s.guest_id
       LEFT JOIN tiers t ON t.id = COALESCE(p.tier_id, g.tier_id)
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN stewards st ON st.id = s.steward_id
       WHERE s.event_id = ?1 ORDER BY s.at, s.id LIMIT ${MAX_REPORT_SCANS}`
    )
      .bind(ev.id)
      .all()
  ).results;
  const lines = [['Time (Lagos)', 'Area', 'Result', 'Reason', 'Ticket type', 'Guest', 'Steward'].join(',')];
  for (const r of rows) {
    lines.push([lagosStamp(r.at), r.zone, r.result === 'granted' ? 'Entered' : 'Refused', r.reason ? REASON_TEXT[r.reason] || r.reason : '', r.tier, r.holder, r.steward || 'Shared gate key'].map(cell).join(','));
  }
  const file = `tap-in-${(ev.prefix || 'event').toLowerCase()}-scans.csv`;
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}
