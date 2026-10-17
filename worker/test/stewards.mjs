// Gate team (one scanner key per steward) and the event report. Run with: node test/stewards.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';
import { buildReport } from '../src/routes/stewards.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const group = (t) => console.log('\n' + t);

const env = makeEnv();
let ipN = 1;
const freshIp = () => '10.80.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const org = await signIn(env, 'boss@stewards.test', '10.80.200.1', 'Bola Boss');
const other = await signIn(env, 'other@stewards.test', '10.80.200.2', 'Other Org');

const ev = (await org.post('/api/events', { name: 'Gate Night', zones: ['Gate A', 'VIP'], tiers: [{ name: 'GA', zones: ['Gate A'], price_kobo: 1000000 }, { name: 'VIP', zones: ['Gate A', 'VIP'], price_kobo: 5000000 }] })).body;
const id = ev.event.id;
const gateA = ev.zones.find((z) => z.name === 'Gate A').id;
const vip = ev.zones.find((z) => z.name === 'VIP').id;
const ga = ev.tiers.find((t) => t.name === 'GA').id;
const vipTier = ev.tiers.find((t) => t.name === 'VIP').id;

// Guests: each claims one ticket and gets a pass token.
async function guest(n, tier = ga) {
  const g = await signIn(env, `guest${n}@stewards.test`, freshIp(), `Guest Number${n}`);
  const code = (await org.post(`/api/events/${id}/invites`, { tier_id: tier, count: 1 })).body.codes[0];
  return (await g.post('/api/claim', { code })).body.pass.token;
}
const scan = (key, token, zone = gateA) => client(env, freshIp()).post('/api/gate/scan', { token, zone_id: zone }, { headers: { Authorization: 'Bearer ' + key } });

group('Gate team');
let ada, kemi;
await test('an organiser adds a steward and gets their scanner key once; only a scrambled copy is stored', async () => {
  const r = await org.post(`/api/events/${id}/stewards`, { name: 'Ada Steward' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.key, /^ST-[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
  assert.equal(r.body.steward.name, 'Ada Steward');
  ada = r.body;
  const row = env.DB.raw.prepare('SELECT key_hash, key_hint FROM stewards WHERE id = ?').get(ada.steward.id);
  assert.notEqual(row.key_hash, ada.key);
  assert.ok(!row.key_hash.includes(ada.key.replace(/-/g, '')));
  assert.equal(row.key_hint, ada.key.slice(-4));
  const list = (await org.get(`/api/events/${id}/stewards`)).body.stewards;
  assert.equal(list.length, 1);
  assert.equal(list[0].key, undefined, 'the key is never listed again');
  kemi = (await org.post(`/api/events/${id}/stewards`, { name: 'Kemi Steward' })).body;
});
await test('only the event owner can see or add stewards', async () => {
  assert.equal((await other.get(`/api/events/${id}/stewards`)).status, 404);
  assert.equal((await other.post(`/api/events/${id}/stewards`, { name: 'Sneaky' })).status, 404);
  assert.equal((await org.post(`/api/events/${id}/stewards`, { name: '' })).status, 400);
});
await test('a steward key opens the scanner for its event and says who is signed in', async () => {
  const r = await client(env, freshIp()).get('/api/gate/info', { headers: { Authorization: 'Bearer ' + ada.key } });
  assert.equal(r.status, 200);
  assert.equal(r.body.event.id, id);
  assert.deepEqual(r.body.steward, { name: 'Ada Steward' });
  const shared = await client(env, freshIp()).get('/api/gate/info', { headers: { Authorization: 'Bearer ' + ev.gate_key } });
  assert.equal(shared.body.steward, null);
});
await test('every scan records the steward who made it; the shared key records none', async () => {
  const t = await guest(1);
  assert.equal((await scan(ada.key, t)).body.result, 'granted');
  const t2 = await guest(2);
  assert.equal((await scan(ev.gate_key, t2)).body.result, 'granted');
  const rows = env.DB.raw.prepare('SELECT steward_id FROM scans WHERE event_id = ? ORDER BY at, rowid').all(id);
  assert.equal(rows[0].steward_id, ada.steward.id);
  assert.equal(rows[1].steward_id, null);
  const feed = (await org.get('/api/events/' + id)).body.recent;
  assert.ok(feed.some((r) => r.steward === 'Ada Steward'));
});
await test('a removed steward is locked out at once; other stewards keep working', async () => {
  const r = await org.post(`/api/events/${id}/stewards/${kemi.steward.id}/revoke`, {});
  assert.equal(r.status, 200);
  assert.ok(r.body.stewards.find((s) => s.id === kemi.steward.id).revoked_at);
  const t = await guest(3);
  const refused = await scan(kemi.key, t);
  assert.equal(refused.status, 401);
  assert.equal((await scan(ada.key, t)).body.result, 'granted');
  assert.equal((await org.post(`/api/events/${id}/stewards/${kemi.steward.id}/revoke`, {})).status, 404, 'cannot remove twice');
});
await test('a steward key for one event does not open another event', async () => {
  const ev2 = (await other.post('/api/events', { name: 'Elsewhere', zones: ['Door'], tiers: [{ name: 'GA', zones: ['Door'] }] })).body;
  const t = await guest(4);
  const r = await client(env, freshIp()).post('/api/gate/scan', { token: t, zone_id: ev2.zones[0].id }, { headers: { Authorization: 'Bearer ' + ada.key } });
  assert.equal(r.status, 400, 'the other event’s area is unknown to this key');
});

group('Report');
await test('the report counts tickets, entries, re-entries, refusals by group and each steward’s lane', async () => {
  const t5 = await guest(5, vipTier);
  assert.equal((await scan(ada.key, t5)).body.result, 'granted');
  assert.equal((await scan(ada.key, t5)).body.reason, 'already_used');
  assert.equal((await scan(ada.key, t5)).body.reason, 'already_used');
  assert.equal((await scan(ada.key, t5)).body.reason, 'already_used');
  assert.equal((await scan(ada.key, 'TP-NOT-A-REAL-CODE')).body.reason, 'invalid_token');
  const t6 = await guest(6);
  assert.equal((await scan(ada.key, t6, vip)).body.reason, 'no_zone_access');
  await guest(7); // a no-show

  const r = await org.get(`/api/events/${id}/report`);
  assert.equal(r.status, 200);
  const rep = r.body;
  assert.equal(rep.totals.issued, 7);
  assert.equal(rep.totals.came, 4);
  assert.equal(rep.totals.no_shows, 3);
  assert.equal(rep.totals.admits, 4);
  assert.equal(rep.totals.reentries, 0);
  assert.equal(rep.totals.refusals, 5, 'a removed steward\u2019s scan is turned away before it is logged');
  assert.equal(rep.refusals.by_group.reused, 3);
  assert.equal(rep.refusals.by_group.fake, 1);
  assert.equal(rep.refusals.by_group.wrong_area, 1);
  assert.equal(rep.fraud.attempts, 4, '3 reused + 1 fake; a wrong-area scan is not fraud');
  assert.equal(rep.fraud.value_attempts, 4);
  assert.ok(rep.fraud.avg_ticket_kobo > 0);
  assert.equal(rep.fraud.est_value_kobo, rep.fraud.value_attempts * rep.fraud.avg_ticket_kobo);
  const a = rep.stewards.find((s) => s.name === 'Ada Steward');
  assert.equal(a.admits, 3);
  assert.equal(a.refusals, 5);
  assert.ok(a.peak_per_min >= 1);
  assert.equal(rep.shared_key.admits, 1);
  assert.ok(rep.flags.some((f) => /shared gate key/.test(f.text)));
  assert.ok(rep.flags.some((f) => /3 or more times/.test(f.text)), 'a ticket shown again 3 times is flagged');
  assert.equal(rep.tiers.find((t) => t.name === 'VIP').came, 1);
  assert.ok(rep.speed.series.points.reduce((n, p) => n + p.n, 0) === 4);
});
await test('the report is private to the organiser', async () => {
  assert.equal((await other.get(`/api/events/${id}/report`)).status, 404);
  assert.equal((await client(env, freshIp()).get(`/api/events/${id}/report`)).status, 401);
});
await test('report maths: busiest minute, bursts of fakes and a steward who never refuses are spotted', () => {
  const base = 1_800_000_000;
  const scans = [];
  let n = 0;
  const add = (o) => scans.push({ id: String(n++), pass_id: o.pass ?? 'p' + n, zone_id: o.zone ?? 'z1', steward_id: o.st ?? 's1', result: o.res ?? 'granted', reason: o.reason ?? null, at: o.at });
  for (let i = 0; i < 60; i++) add({ at: base + i * 2, st: 's1' });            // 60 admits in 2 minutes by s1
  for (let i = 0; i < 20; i++) add({ at: base + 400 + i, st: 's2', res: 'denied', reason: 'already_used', pass: 'p5' });
  for (let i = 0; i < 6; i++) add({ at: base + 900 + i * 10, st: 's2', res: 'denied', reason: 'invalid_token', pass: null });
  scans.sort((a, b) => a.at - b.at);
  const rep = buildReport({ id: 'e', name: 'X', kind: 'event' }, {
    scans, passes: [], tiers: [], zones: [{ id: 'z1', name: 'Gate A' }],
    stewards: [{ id: 's1', name: 'Sam', revoked_at: null }, { id: 's2', name: 'Tayo', revoked_at: null }]
  });
  assert.equal(rep.speed.peak_per_min, 30);
  assert.equal(rep.stewards.find((s) => s.name === 'Sam').avg_per_active_min, 30);
  assert.ok(rep.flags.some((f) => /Sam let in 60 people and refused none/.test(f.text)));
  assert.ok(rep.flags.some((f) => /burst of 6 fake/.test(f.text)));
  assert.equal(rep.fraud.est_value_kobo, null, 'no paid tickets, so no value estimate');
});
await test('the scan export is a CSV with steward names, no contact details, and formula-safe cells', async () => {
  const sneaky = (await org.post(`/api/events/${id}/stewards`, { name: '=HYPERLINK("x")' })).body;
  const t = await guest(8);
  await scan(sneaky.key, t);
  const res = await org.call('GET', `/api/events/${id}/scans.csv`, { raw: true });
  assert.equal(res.status, 200);
  const text = typeof res.body === 'string' ? res.body : res.text;
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="tap-in-.*-scans\.csv"/);
  assert.ok(text.startsWith('Time (Lagos),Area,Result,Reason,Ticket type,Guest,Steward'));
  assert.ok(text.includes('Ada Steward'));
  assert.ok(text.includes('Shared gate key'));
  assert.ok(text.includes(`"'=HYPERLINK(""x"")"`), 'formula cells are made safe');
  assert.ok(!text.includes('@stewards.test'), 'no emails in the export');
  assert.equal((await other.call('GET', `/api/events/${id}/scans.csv`, { raw: true })).status, 404);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
