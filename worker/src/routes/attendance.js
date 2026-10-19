// Attendance for Tap In for Business offices: who came in on which days, when they first arrived, who was late
// against their group's start time, and visitors. Scans record entries only (there is no exit scan), so the last
// scan of a day is "last seen at a door", not a leaving time. Days are in the office's time zone.

import { HttpError } from '../lib/util.js';
import { json } from '../lib/http.js';
import { ownedEvent } from './events.js';

const MAX_DAYS = 92;
const MAX_SCANS = 200_000;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const dayOfDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(t) ? Math.floor(t / 86400000) : null;
};
const dateOfDay = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
const weekday = (d) => (d + 3) % 7; // 0 = Monday (1 Jan 1970 was a Thursday)
const hhmm = (min) => (min === null || min === undefined ? '' : String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'));

// Build the report from raw rows. Exported for tests.
export function buildAttendance({ fromDay, toDay, tz, grace, people, visitors, scans }) {
  const days = [];
  for (let d = fromDay; d <= toDay; d++) days.push(d);
  const local = (at) => at + tz * 60;
  const dayOf = (at) => Math.floor(local(at) / 86400);
  const minuteOf = (at) => Math.floor(((local(at) % 86400) + 86400) % 86400 / 60);

  // First and last scan per person per day.
  const byKey = new Map();
  for (const s of scans) {
    const key = s.pass_id ? 'p:' + s.pass_id : 'g:' + s.guest_id;
    const d = dayOf(s.at);
    if (d < fromDay || d > toDay) continue;
    const k = key + '|' + d;
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, { first: s.at, last: s.at, scans: 1, door: s.zone });
    else { if (s.at < cur.first) { cur.first = s.at; cur.door = s.zone; } if (s.at > cur.last) cur.last = s.at; cur.scans++; }
  }

  const always = (p) => p.days_mask === 127 && p.from_min === 0 && p.to_min === 1440;
  const peopleOut = people.map((p) => {
    const perDay = {};
    let present = 0, late = 0, expected = 0, arrivalSum = 0;
    for (const d of days) {
      const scheduled = !!(p.days_mask & (1 << weekday(d)));
      if (scheduled && p.status === 'active') expected++;
      const v = byKey.get('p:' + p.id + '|' + d);
      if (!v) continue;
      const first = minuteOf(v.first);
      const isLate = !always(p) && scheduled && first > p.from_min + grace;
      present++; arrivalSum += first; if (isLate) late++;
      perDay[dateOfDay(d)] = { first: hhmm(first), last: hhmm(minuteOf(v.last)), scans: v.scans, late: isLate, door: v.door, scheduled };
    }
    return {
      id: p.id, name: p.name || 'Guest', contact: p.contact, group: p.group, starts: always(p) ? null : hhmm(p.from_min), status: p.status,
      days_present: present, expected_days: expected, attendance_pct: expected ? Math.round((Math.min(present, expected) / expected) * 1000) / 10 : null,
      late_days: late, avg_arrival: present ? hhmm(Math.round(arrivalSum / present)) : null, days: perDay
    };
  }).filter((p) => p.status === 'active' || p.days_present > 0)
    .sort((a, b) => b.days_present - a.days_present || a.name.localeCompare(b.name));

  const visitorsOut = visitors.map((g) => {
    const firstDay = days.find((d) => byKey.has('g:' + g.id + '|' + d));
    const v = firstDay !== undefined ? byKey.get('g:' + g.id + '|' + firstDay) : null;
    return { id: g.id, name: g.name, contact: g.contact, host: g.host, purpose: g.purpose, walk_in: !!g.walk_in, group: g.group,
      date: v ? dateOfDay(firstDay) : dateOfDay(dayOf(g.valid_from)), arrived: v ? hhmm(minuteOf(v.first)) : null, door: v ? v.door : null, status: g.status };
  }).filter((g) => { const d = dayOfDate(g.date); return d >= fromDay && d <= toDay; })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.arrived || '99').localeCompare(b.arrived || '99'));

  const daysOut = days.map((d) => {
    const date = dateOfDay(d);
    const here = peopleOut.filter((p) => p.days[date]);
    return {
      date, weekday: DAY_NAMES[weekday(d)],
      expected: people.filter((p) => p.status === 'active' && p.days_mask & (1 << weekday(d))).length,
      present: here.length, late: here.filter((p) => p.days[date].late).length,
      visitors: visitorsOut.filter((v) => v.date === date && v.arrived).length
    };
  });
  const workdays = daysOut.filter((d) => d.expected > 0);
  return {
    range: { from: dateOfDay(fromDay), to: dateOfDay(toDay), days: days.length },
    grace,
    summary: {
      people_with_access: people.filter((p) => p.status === 'active').length,
      came_in: peopleOut.filter((p) => p.days_present > 0).length,
      avg_present: workdays.length ? Math.round((workdays.reduce((n, d) => n + d.present, 0) / workdays.length) * 10) / 10 : 0,
      late_arrivals: daysOut.reduce((n, d) => n + d.late, 0),
      visitors: visitorsOut.filter((v) => v.arrived).length
    },
    days: daysOut,
    people: peopleOut,
    visitors: visitorsOut
  };
}

async function load(env, user, params, url) {
  const ev = await ownedEvent(env, user, params.id);
  if (ev.kind !== 'workplace') throw new HttpError(400, 'not_an_office', 'Attendance is for Tap In for Business offices.');
  const { tz_offset_min: tz } = await env.DB.prepare('SELECT tz_offset_min FROM events WHERE id = ?1').bind(ev.id).first();
  const today = Math.floor((Date.now() / 1000 + tz * 60) / 86400);
  const toDay = dayOfDate(url.searchParams.get('to')) ?? today;
  const fromDay = dayOfDate(url.searchParams.get('from')) ?? toDay - 6;
  if (fromDay > toDay) throw new HttpError(400, 'invalid_range', 'The start date must be on or before the end date.');
  if (toDay - fromDay + 1 > MAX_DAYS) throw new HttpError(400, 'invalid_range', `Choose up to ${MAX_DAYS} days at a time.`);
  const g = Number.parseInt(url.searchParams.get('grace') ?? '15', 10);
  const grace = Number.isInteger(g) && g >= 0 && g <= 240 ? g : 15;
  const start = fromDay * 86400 - tz * 60;
  const end = (toDay + 1) * 86400 - tz * 60;
  const [people, visitors, scans, waiting] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id, p.status, u.name, COALESCE(u.phone, u.email) AS contact, t.name AS "group", t.days_mask, t.from_min, t.to_min
       FROM passes p JOIN users u ON u.id = p.user_id JOIN tiers t ON t.id = p.tier_id WHERE p.event_id = ?1`
    ).bind(ev.id).all(),
    env.DB.prepare(
      `SELECT g.id, g.name, g.contact, g.host, g.purpose, g.walk_in, g.valid_from, g.status, t.name AS "group"
       FROM guests g JOIN tiers t ON t.id = g.tier_id WHERE g.event_id = ?1 AND g.kind = 'visitor' AND g.valid_until > ?2 AND g.valid_from < ?3`
    ).bind(ev.id, start, end).all(),
    env.DB.prepare(
      `SELECT s.at, s.pass_id, s.guest_id, z.name AS zone FROM scans s LEFT JOIN zones z ON z.id = s.zone_id
       WHERE s.event_id = ?1 AND s.result = 'granted' AND s.at >= ?2 AND s.at < ?3 ORDER BY s.at LIMIT ${MAX_SCANS}`
    ).bind(ev.id, start, end).all(),
    // People given access by phone or email who have not added their pass yet.
    env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE event_id = ?1 AND status = 'unused' AND bound_identifier IS NOT NULL").bind(ev.id).first()
  ]);
  const report = buildAttendance({ fromDay, toDay, tz, grace, people: people.results, visitors: visitors.results, scans: scans.results });
  report.summary.not_set_up = waiting.n;
  return { ev, report };
}

// GET /api/events/:id/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD&grace=15
export async function attendance({ env, user, params, url }) {
  return json((await load(env, user, params, url)).report);
}

// GET /api/events/:id/attendance.csv?type=daily|summary|visitors&from&to&grace
const cell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export async function attendanceCsv({ env, user, params, url }) {
  const { ev, report: r } = await load(env, user, params, url);
  const type = ['daily', 'summary', 'visitors'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'daily';
  let rows;
  if (type === 'summary') {
    rows = [['Name', 'Phone or email', 'Group', 'Group starts', 'Days in', 'Days expected', 'Attendance %', 'Late days', 'Average arrival', 'Access']]
      .concat(r.people.map((p) => [p.name, p.contact, p.group, p.starts || 'Any time', p.days_present, p.expected_days, p.attendance_pct ?? '', p.late_days, p.avg_arrival || '', p.status === 'active' ? 'Active' : 'Removed']));
  } else if (type === 'visitors') {
    rows = [['Date', 'Visitor', 'Phone or email', 'Visiting', 'Reason', 'How', 'Arrived', 'Door', 'Group']]
      .concat(r.visitors.map((v) => [v.date, v.name, v.contact, v.host, v.purpose, v.walk_in ? 'Walk-in' : 'Invited', v.arrived || 'Did not arrive', v.door, v.group]));
  } else {
    rows = [['Date', 'Day', 'Name', 'Phone or email', 'Group', 'First scan', 'Last seen', 'Scans', 'Late', 'First door']];
    for (const d of r.days) for (const p of r.people) { const x = p.days[d.date]; if (x) rows.push([d.date, d.weekday, p.name, p.contact, p.group, x.first, x.last, x.scans, x.late ? 'Yes' : 'No', x.door]); }
  }
  const file = `tap-in-${(ev.prefix || 'office').toLowerCase()}-${type}-${r.range.from}-to-${r.range.to}.csv`;
  return new Response(rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}
