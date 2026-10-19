// Office attendance: days in, first arrival, late against the group's start time, visitors, and CSV exports.
// Run with: node test/attendance.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const env = makeEnv();
let ipN = 1;
const freshIp = () => '10.96.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const org = await signIn(env, 'hr@attend.test', '10.96.200.1', 'HR Person');
const other = await signIn(env, 'other@attend.test', '10.96.200.2', 'Other');
const off = (await org.post('/api/events', { kind: 'workplace', name: 'Acme HQ', require_photo: false, zones: ['Front door', 'Lab'], tiers: [
  { name: 'Staff', zones: ['Front door', 'Lab'], days: [0, 1, 2, 3, 4], from: '07:00', to: '19:00' },
  { name: 'Security', zones: ['Front door'] }
] })).body;
const id = off.event.id;
const front = off.zones.find((z) => z.name === 'Front door').id;
const staff = off.tiers.find((t) => t.name === 'Staff').id;
const security = off.tiers.find((t) => t.name === 'Security').id;

async function person(email, name, tier) {
  const c = await signIn(env, email, freshIp(), name);
  await org.post(`/api/events/${id}/people`, { tier_id: tier, people: [{ contact: email, name }] });
  const me = (await c.get('/api/me')).body;
  const w = me.waiting[0];
  const claimed = (await c.post('/api/claim', { invite_id: w.id })).body;
  return claimed.pass ? claimed.pass.id : (await c.get('/api/me')).body.passes[0].id;
}
// Week of Monday 12 October 2026. Lagos is UTC+1, so 07:00 Lagos = 06:00 UTC.
const lagos = (date, hm) => Math.floor(Date.parse(`${date}T${hm}:00+01:00`) / 1000);
const scanAt = (passId, at, zone = front) => env.DB.raw.prepare("INSERT INTO scans (id, event_id, pass_id, zone_id, result, once, at) VALUES (?, ?, ?, ?, 'granted', 0, ?)").run('S' + Math.random().toString(36).slice(2, 14).toUpperCase(), id, passId, zone, at);

let ada, bola, sam;
await test('setup: three people with access', async () => {
  ada = await person('ada@attend.test', 'Ada Obi', staff);
  bola = await person('bola@attend.test', 'Bola Ade', staff);
  sam = await person('sam@attend.test', 'Sam Guard', security);
  assert.ok(ada && bola && sam);
  scanAt(ada, lagos('2026-10-12', '06:55'));
  scanAt(ada, lagos('2026-10-12', '12:30'));
  scanAt(ada, lagos('2026-10-13', '07:20')); // late with a 15-minute grace
  scanAt(ada, lagos('2026-10-14', '07:10')); // inside the grace
  scanAt(bola, lagos('2026-10-12', '08:45')); // late
  scanAt(sam, lagos('2026-10-17', '22:00')); // Saturday night; Security has no hours, so never late
  scanAt(ada, lagos('2026-10-19', '07:00')); // outside the range asked for
});
let r;
await test('the report counts days in, expected days, attendance, late days and average arrival per person', async () => {
  const res = await org.get(`/api/events/${id}/attendance?from=2026-10-12&to=2026-10-18`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  r = res.body;
  assert.equal(r.range.days, 7);
  const a = r.people.find((p) => p.name === 'Ada Obi');
  assert.equal(a.days_present, 3);
  assert.equal(a.expected_days, 5, 'Mon to Fri');
  assert.equal(a.attendance_pct, 60);
  assert.equal(a.late_days, 1);
  assert.equal(a.avg_arrival, '07:08');
  assert.deepEqual(a.days['2026-10-12'], { first: '06:55', last: '12:30', scans: 2, late: false, door: 'Front door', scheduled: true });
  assert.equal(a.days['2026-10-13'].late, true);
  assert.equal(a.days['2026-10-14'].late, false);
  assert.equal(a.contact, 'ada@attend.test');
  const b = r.people.find((p) => p.name === 'Bola Ade');
  assert.equal(b.late_days, 1);
  const s = r.people.find((p) => p.name === 'Sam Guard');
  assert.equal(s.late_days, 0, 'a group with no set hours is never late');
  assert.equal(s.starts, null);
  assert.equal(s.expected_days, 7);
});
await test('each day shows how many were expected, came in and were late', async () => {
  const mon = r.days.find((d) => d.date === '2026-10-12');
  assert.deepEqual({ weekday: mon.weekday, expected: mon.expected, present: mon.present, late: mon.late }, { weekday: 'Mon', expected: 3, present: 2, late: 1 });
  const sat = r.days.find((d) => d.date === '2026-10-17');
  assert.equal(sat.expected, 1, 'only Security works Saturdays');
  assert.equal(sat.present, 1);
  assert.equal(r.summary.came_in, 3);
  assert.equal(r.summary.late_arrivals, 2);
  assert.equal(r.summary.not_set_up, 0);
  await org.post(`/api/events/${id}/people`, { tier_id: staff, people: [{ contact: 'newbie@attend.test', name: 'New Starter' }] });
  assert.equal((await org.get(`/api/events/${id}/attendance?from=2026-10-12&to=2026-10-18`)).body.summary.not_set_up, 1, 'given access, pass not added yet');
});
await test('a stricter or looser grace period changes who is late', async () => {
  const strict = (await org.get(`/api/events/${id}/attendance?from=2026-10-12&to=2026-10-18&grace=0`)).body;
  assert.equal(strict.people.find((p) => p.name === 'Ada Obi').late_days, 2);
  const loose = (await org.get(`/api/events/${id}/attendance?from=2026-10-12&to=2026-10-18&grace=120`)).body;
  assert.equal(loose.summary.late_arrivals, 0);
});
await test('visitors in the range are listed with who they visited and when they arrived', async () => {
  const desk = (await org.post(`/api/events/${id}/stewards`, { name: 'Desk' })).body;
  const w = await client(env, freshIp()).post('/api/gate/walkin', { name: 'Musa Courier', host: 'Mailroom', purpose: 'Delivery', tier_id: security, zone_id: front }, { headers: { Authorization: 'Bearer ' + desk.key } });
  assert.equal(w.status, 201);
  const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
  const res = (await org.get(`/api/events/${id}/attendance?from=${today}&to=${today}`)).body;
  const v = res.visitors.find((x) => x.name === 'Musa Courier');
  assert.equal(v.host, 'Mailroom');
  assert.equal(v.walk_in, true);
  assert.match(v.arrived, /^\d\d:\d\d$/);
  assert.equal(res.summary.visitors, 1);
  assert.ok(!res.people.some((p) => p.name === 'Musa Courier'), 'visitors are listed separately from staff');
});
await test('CSV exports: daily rows, one row per person, and the visitor log', async () => {
  const get = (type) => org.call('GET', `/api/events/${id}/attendance.csv?type=${type}&from=2026-10-12&to=2026-10-18`, { raw: true });
  const daily = await get('daily');
  assert.equal(daily.status, 200);
  assert.match(daily.headers.get('content-disposition'), /attachment; filename="tap-in-.*-daily-2026-10-12-to-2026-10-18\.csv"/);
  const lines = daily.body.trim().split('\r\n');
  assert.equal(lines[0], 'Date,Day,Name,Phone or email,Group,First scan,Last seen,Scans,Late,First door');
  assert.equal(lines.length, 1 + 5, 'Ada 3 days, Bola 1, Sam 1');
  assert.ok(lines.includes('2026-10-13,Tue,Ada Obi,ada@attend.test,Staff,07:20,07:20,1,Yes,Front door'));
  const summary = (await get('summary')).body.trim().split('\r\n');
  assert.equal(summary[0], 'Name,Phone or email,Group,Group starts,Days in,Days expected,Attendance %,Late days,Average arrival,Access');
  assert.ok(summary.includes('Ada Obi,ada@attend.test,Staff,07:00,3,5,60,1,07:08,Active'));
  const vis = (await get('visitors')).body.split('\r\n')[0];
  assert.equal(vis, 'Date,Visitor,Phone or email,Visiting,Reason,How,Arrived,Door,Group');
});
await test('private to the office owner; offices only; sensible ranges', async () => {
  assert.equal((await other.get(`/api/events/${id}/attendance`)).status, 404);
  assert.equal((await client(env, freshIp()).get(`/api/events/${id}/attendance`)).status, 401);
  const ev = (await org.post('/api/events', { name: 'A Concert', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }] })).body;
  assert.equal((await org.get(`/api/events/${ev.event.id}/attendance`)).status, 400);
  assert.equal((await org.get(`/api/events/${id}/attendance?from=2026-10-20&to=2026-10-12`)).status, 400);
  assert.equal((await org.get(`/api/events/${id}/attendance?from=2026-01-01&to=2026-10-12`)).status, 400, 'over 92 days');
  assert.equal((await org.get(`/api/events/${id}/attendance`)).body.range.days, 7, 'last 7 days by default');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
