// Phase 1 tests: Tap In access for companies and offices.
// Run with: node test/workplace.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';
import { parseSchedule, scheduleOut, withinSchedule } from '../src/lib/schedule.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       '));
  }
}
const group = (t) => console.log('\n' + t);

group('Working hours');
const weekdays = parseSchedule({ days: [0, 1, 2, 3, 4], from: '08:00', to: '18:00' }, 'Staff');
// 2026-10-14 is a Wednesday. 09:30 Lagos (UTC+1) = 08:30 UTC.
const wed = (h, m = 0) => Date.UTC(2026, 9, 14, h, m) / 1000;
const sat = (h, m = 0) => Date.UTC(2026, 9, 17, h, m) / 1000;
await test('a weekday group is valid inside its hours and refused outside them, in Lagos time', () => {
  assert.equal(withinSchedule(weekdays, wed(8, 30)), true);
  assert.equal(withinSchedule(weekdays, wed(6, 59)), false); // 07:59 Lagos
  assert.equal(withinSchedule(weekdays, wed(7, 0)), true); // 08:00 Lagos
  assert.equal(withinSchedule(weekdays, wed(16, 59)), true); // 17:59
  assert.equal(withinSchedule(weekdays, wed(17, 0)), false); // 18:00 is the end
  assert.equal(withinSchedule(weekdays, sat(9, 0)), false);
});
await test('midnight in Lagos belongs to the next day', () => {
  assert.equal(withinSchedule(parseSchedule({ days: [2], from: '00:00', to: '01:00' }, 'x'), Date.UTC(2026, 9, 13, 23, 30) / 1000), true);
});
await test('bad hours are rejected and defaults mean always', () => {
  assert.throws(() => parseSchedule({ from: '18:00', to: '08:00' }, 'x'), /end after it starts/);
  assert.throws(() => parseSchedule({ days: [] }, 'x'), /at least one day/);
  assert.throws(() => parseSchedule({ days: [7] }, 'x'), /at least one day/);
  assert.throws(() => parseSchedule({ from: '25:00' }, 'x'), /HH:MM/);
  assert.deepEqual(scheduleOut(parseSchedule({}, 'x')), { days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' });
  assert.equal(withinSchedule(parseSchedule({}, 'x'), sat(3)), true);
});

group('Creating an office');
const env = makeEnv();
const G = (key) => ({ headers: { Authorization: 'Bearer ' + key } });
let boss, office, staffTier, visitorTier, hq, lab, staff;
const today = (Math.floor(Date.now() / 86400000) + 3) % 7;
const otherDay = (today + 3) % 7;

await test('creates a workplace with doors, access groups and hours; re-entry is always on', async () => {
  boss = await signIn(env, 'boss@acme.test', '10.20.0.1', 'Ada Boss');
  const r = await boss.post('/api/events', {
    kind: 'workplace', name: 'Acme HQ', city: 'Lagos', allow_reentry: false,
    zones: ['Front door', 'Server room'],
    tiers: [
      { name: 'Staff', zones: ['Front door', 'Server room'] },
      { name: 'Visitor', zones: ['Front door'], days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '18:00' }
    ]
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  office = r.body;
  assert.equal(office.event.kind, 'workplace');
  assert.equal(office.event.allow_reentry, true);
  staffTier = office.tiers.find((t) => t.name === 'Staff');
  visitorTier = office.tiers.find((t) => t.name === 'Visitor');
  assert.deepEqual(staffTier.schedule, { days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '24:00' });
  assert.equal(visitorTier.schedule.from, '08:00');
  hq = office.zones.find((z) => z.name === 'Front door');
  lab = office.zones.find((z) => z.name === 'Server room');
});
await test('an ordinary event ignores hours and keeps its own re-entry rule', async () => {
  const r = await boss.post('/api/events', { name: 'Launch party', zones: ['Door'], tiers: [{ name: 'GA', zones: ['Door'], from: '08:00', to: '09:00' }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.event.kind, 'event');
  assert.equal(r.body.event.allow_reentry, false);
  assert.equal(r.body.tiers[0].schedule.from, '00:00');
});
await test('an unknown kind is refused', async () => {
  const r = await boss.post('/api/events', { kind: 'bank', name: 'Nope', zones: ['A'], tiers: [{ name: 'T', zones: ['A'] }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_kind');
});

group('Adding people');
await test('staff are added by phone or email; bad and duplicate contacts are reported, not fatal', async () => {
  const r = await boss.post(`/api/events/${office.event.id}/people`, {
    tier_id: staffTier.id,
    people: [{ contact: 'tolu@acme.test', name: 'Tolu A' }, { contact: '0803 412 7790' }, { contact: 'TOLU@acme.test' }, { contact: 'nonsense' }]
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.added.length, 2);
  assert.deepEqual(r.body.skipped.map((s) => s.reason), ['Listed twice.', 'Not a valid phone number or email.']);
  const again = await boss.post(`/api/events/${office.event.id}/people`, { tier_id: staffTier.id, people: [{ contact: 'tolu@acme.test' }] });
  assert.equal(again.body.added.length, 0);
  assert.equal(again.body.skipped[0].reason, 'Already has access in this group.');
});
await test('only the owner can add people, and the group must belong to the workplace', async () => {
  const stranger = await signIn(env, 'stranger@example.com', '10.20.0.2');
  assert.equal((await stranger.post(`/api/events/${office.event.id}/people`, { tier_id: staffTier.id, people: [{ contact: 'a@b.co' }] })).status, 404);
  assert.equal((await boss.post(`/api/events/${office.event.id}/people`, { tier_id: 'nope', people: [{ contact: 'a@b.co' }] })).status, 400);
  assert.equal((await boss.post(`/api/events/${office.event.id}/people`, { tier_id: staffTier.id, people: [] })).status, 400);
});
await test('a past end date is refused', async () => {
  const r = await boss.post(`/api/events/${office.event.id}/people`, { tier_id: visitorTier.id, people: [{ contact: 'v@x.co' }], access_until: '2020-01-01T00:00:00Z' });
  assert.equal(r.status, 400);
});

group('Using the pass at the door');
let pass;
await test('the invite waits in the person’s app, and claiming gives a staff pass', async () => {
  staff = await signIn(env, 'tolu@acme.test', '10.20.0.3', 'Tolu Adeyemi');
  const me = await staff.get('/api/me');
  assert.equal(me.body.waiting.length, 1);
  assert.equal(me.body.waiting[0].event.kind, 'workplace');
  const c = await staff.post('/api/claim', { invite_id: me.body.waiting[0].id });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  pass = c.body.pass;
  assert.equal(pass.event.kind, 'workplace');
  assert.equal(pass.expires_at, null);
});
const key = async () => (await boss.post(`/api/events/${office.event.id}/gate-key`)).body.gate_key;
let gk;
const scan = (zone, p = pass) => client(env, '10.20.9.1').post('/api/gate/scan', { token: p.token, zone_id: zone.id }, G(gk));
await test('staff can come and go through the door all day', async () => {
  gk = await key();
  assert.equal((await scan(hq)).body.result, 'granted');
  assert.equal((await scan(hq)).body.result, 'granted');
  assert.equal((await scan(lab)).body.result, 'granted');
});
await test('the gate reports that it is guarding a workplace', async () => {
  assert.equal((await client(env, '10.20.9.2').get('/api/gate/info', G(gk))).body.event.kind, 'workplace');
});
await test('a group limited to other days is turned away with a clear reason', async () => {
  const r = await boss.post('/api/events', {
    kind: 'workplace', name: 'Acme Annex', zones: ['Door'],
    tiers: [{ name: 'Weekend crew', zones: ['Door'], days: [otherDay] }]
  });
  const gkey = r.body.gate_key;
  await boss.post(`/api/events/${r.body.event.id}/people`, { tier_id: r.body.tiers[0].id, people: [{ contact: 'tolu@acme.test' }] });
  const me = await staff.get('/api/me');
  const w = me.body.waiting.find((x) => x.event.name === 'Acme Annex');
  const p = (await staff.post('/api/claim', { invite_id: w.id })).body.pass;
  const s = await client(env, '10.20.9.3').post('/api/gate/scan', { token: p.token, zone_id: r.body.zones[0].id }, G(gkey));
  assert.equal(s.body.result, 'denied');
  assert.equal(s.body.reason, 'outside_hours');
  assert.equal(s.body.message, 'This pass is not valid at this time.');
});
await test('a visitor pass with an end date works, then expires', async () => {
  const until = new Date(Date.now() + 3600e3).toISOString();
  const add = await boss.post(`/api/events/${office.event.id}/people`, { tier_id: visitorTier.id, people: [{ contact: 'visitor@guest.test', name: 'Vee' }], access_until: until });
  assert.equal(add.status, 201);
  const visitor = await signIn(env, 'visitor@guest.test', '10.20.0.4', 'Vee Guest');
  const w = (await visitor.get('/api/me')).body.waiting[0];
  const vp = (await visitor.post('/api/claim', { invite_id: w.id })).body.pass;
  assert.ok(vp.expires_at > Date.now() / 1000);
  // Whether the visitor group is open right now depends on the clock; force the hours open for this check.
  env.DB.raw.prepare('UPDATE tiers SET from_min = 0, to_min = 1440 WHERE id = ?').run(visitorTier.id);
  assert.equal((await scan(hq, vp)).body.result, 'granted');
  assert.equal((await scan(lab, vp)).body.reason, 'no_zone_access');
  env.DB.raw.prepare('UPDATE passes SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, vp.id);
  const late = await scan(hq, vp);
  assert.equal(late.body.result, 'denied');
  assert.equal(late.body.reason, 'expired');
  assert.equal(late.body.message, 'This pass has expired.');
});
await test('cancelling a pass (leaving the company) shuts the door immediately', async () => {
  const people = (await boss.get(`/api/events/${office.event.id}/attendees`)).body.attendees;
  const t = people.find((a) => a.contact === 'tolu@acme.test');
  assert.equal((await boss.post(`/api/events/${office.event.id}/passes/${t.id}/revoke`)).status, 200);
  assert.equal((await scan(hq)).body.reason, 'revoked');
});
await test('attendee list shows when a pass expires', async () => {
  const people = (await boss.get(`/api/events/${office.event.id}/attendees`)).body.attendees;
  assert.ok(people.some((a) => a.expires_at));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed: ' + failures.join('; '));
  process.exit(1);
}
