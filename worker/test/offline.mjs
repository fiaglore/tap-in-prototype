// Offline gates: rolling codes made on the phone, the scanner's downloaded list, and syncing scans made with no
// signal. Run with: node test/offline.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';
import * as server from '../src/lib/codes.js';
import * as browser from '../public/js/offline.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const group = (t) => console.log('\n' + t);

const env = makeEnv();
let ipN = 1;
const freshIp = () => '10.95.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const now = () => Math.floor(Date.now() / 1000);
const org = await signIn(env, 'org@offline.test', '10.95.200.1', 'Olu Organiser');

group('The phone and the server agree');
await test('a rolling code made in the browser is exactly the one the server would make', async () => {
  const ek = await server.eventOfflineKey('pepper-x', 'EVENT1');
  const pk = await server.passRollingKey(ek, 'ABCDEFGHJK');
  for (const t of [1_800_000_000, 1_800_000_031, now()]) assert.equal(await browser.rollingToken(pk, 'ABCDEFGHJK', t), await server.rollingToken(pk, 'ABCDEFGHJK', t));
});
await test('an imported code hashed in the browser matches the stored hash, whatever the spacing or case', async () => {
  const ek = await server.eventOfflineKey('pepper-x', 'EVENT1');
  assert.equal(await browser.codeHash(ek, 'tix 88812-ab'), await server.hashGuestCode('pepper-x', 'EVENT1', 'TIX88812AB'));
});
await test('schedules are judged the same in the browser', async () => {
  const { withinSchedule } = await import('../src/lib/schedule.js');
  const t = { days_mask: 0b0011111, from_min: 7 * 60, to_min: 19 * 60 };
  for (let at = 1_800_000_000; at < 1_800_000_000 + 7 * 86400; at += 3601) assert.equal(browser.withinSchedule(t, at, 60), withinSchedule(t, at, 60));
});

const ev = (await org.post('/api/events', { name: 'No Signal Fest', secure_qr: true, zones: ['Gate', 'VIP'], tiers: [{ name: 'GA', zones: ['Gate'] }, { name: 'VIP', zones: ['Gate', 'VIP'] }] })).body;
const id = ev.event.id;
const gate = ev.zones.find((z) => z.name === 'Gate').id;
const vip = ev.zones.find((z) => z.name === 'VIP').id;
const steward = (await org.post(`/api/events/${id}/stewards`, { name: 'Sam Steward' })).body;
const auth = { headers: { Authorization: 'Bearer ' + steward.key } };
const scan = (token, zone = gate) => client(env, freshIp()).post('/api/gate/scan', { token, zone_id: zone }, auth);
async function fan(n, tierName = 'GA') {
  const f = await signIn(env, `fan${n}@offline.test`, freshIp(), `Fan Number${n}`);
  const code = (await org.post(`/api/events/${id}/invites`, { tier_id: ev.tiers.find((t) => t.name === tierName).id, count: 1 })).body.codes[0];
  const pass = (await f.post('/api/claim', { code })).body.pass;
  const me = (await f.get('/api/me')).body;
  return { f, pass: me.passes.find((p) => p.id === pass.id), me };
}

group('Rolling codes on the phone');
let a;
await test('a live pass comes with its own rolling key and the server time; ordinary passes do not', async () => {
  a = await fan(1);
  assert.equal(a.pass.live, true);
  assert.equal(a.pass.token, null);
  assert.match(a.pass.roll_key, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Math.abs(a.me.server_time - now()) < 5);
  const plain = (await org.post('/api/events', { name: 'Plain', zones: ['G'], tiers: [{ name: 'T', zones: ['G'] }] })).body;
  const c = (await org.post(`/api/events/${plain.event.id}/invites`, { tier_id: plain.tiers[0].id, count: 1 })).body.codes[0];
  const p2 = (await a.f.post('/api/claim', { code: c })).body.pass;
  const mine = (await a.f.get('/api/me')).body.passes.find((p) => p.id === p2.id);
  assert.equal(mine.roll_key, undefined);
});
await test('the gate accepts a rolling code made on the phone, and refuses an old one or a forged one', async () => {
  const good = await browser.rollingToken(a.pass.roll_key, a.pass.id, now());
  assert.equal((await scan(good)).body.result, 'granted');
  const b = await fan(2);
  const old = await browser.rollingToken(b.pass.roll_key, b.pass.id, now() - 600);
  assert.equal((await scan(old)).body.reason, 'stale_code');
  const forged = await browser.rollingToken('not-the-real-key-not-the-real-key-000000000', b.pass.id, now());
  assert.equal((await scan(forged)).body.reason, 'invalid_token');
  assert.equal((await scan(await browser.rollingToken(b.pass.roll_key, b.pass.id, now()))).body.result, 'granted');
});

group('The scanner’s saved list');
let list;
await test('a signed-in scanner downloads the rules, every ticket (first name and initial only), entries and the event key', async () => {
  await org.post(`/api/events/${id}/guests/import`, { tier_id: ev.tiers[0].id, rows: [{ code: 'EXT-555-AAA', name: 'Imported Person' }] });
  const r = await client(env, freshIp()).get('/api/gate/list', auth);
  assert.equal(r.status, 200);
  list = r.body;
  assert.equal(list.event.secure_qr, true);
  assert.ok(list.passes.length >= 2);
  assert.ok(list.passes.every((p) => /^[A-Z][a-z]+( [A-Z]\.)?$/.test(p.holder) || p.holder === 'Guest'));
  assert.ok(!JSON.stringify(list).includes('@offline.test'), 'no emails');
  assert.equal(list.key, await server.eventOfflineKey(env.SECRET_PEPPER, id));
  assert.equal(list.entries.length, 2);
  assert.ok(list.guests.some((g) => g.code_hash));
  assert.deepEqual(list.steward, { name: 'Sam Steward' });
  assert.equal((await client(env, freshIp()).get('/api/gate/list', { headers: { Authorization: 'Bearer ST-NOPE-NOPE-NOPE-NOPE-NOPE-NOPE' } })).status, 401);
});
await test('with only the saved list, the scanner can check a rolling code and an imported code', async () => {
  const c = await fan(3);
  const fresh = await (await client(env, freshIp()).get('/api/gate/list', auth)).body;
  const t = await browser.rollingToken(c.pass.roll_key, c.pass.id, now());
  const who = await browser.identify(t, fresh.key, now());
  assert.equal(who.kind, 'pass');
  assert.equal(who.rolling, true);
  assert.equal(who.stale, false);
  assert.ok(fresh.passes.some((p) => p.id === who.id));
  const imp = await browser.identify('ext 555 aaa', fresh.key, now());
  assert.equal(imp.kind, 'import');
  assert.ok(fresh.guests.some((g) => g.code_hash === imp.hash));
  const forged = await browser.identify(await browser.rollingToken('x'.repeat(43), c.pass.id, now()), fresh.key, now());
  assert.equal(forged.kind, 'import', 'a forged rolling code is not treated as a pass');
});

group('Syncing scans made offline');
await test('offline scans are recorded with the steward and marked as offline; sending twice records once', async () => {
  const c = await fan(4);
  const d = await fan(5, 'VIP');
  const scans = [
    { id: 'OFFLINEAAAAAAAA1', ref: 'p:' + c.pass.id, zone_id: gate, result: 'granted', at: now() - 120 },
    { id: 'OFFLINEAAAAAAAA2', ref: null, zone_id: gate, result: 'denied', reason: 'invalid_token', at: now() - 100 },
    { id: 'OFFLINEAAAAAAAA3', ref: 'p:' + d.pass.id, zone_id: vip, result: 'granted', at: now() - 90 }
  ];
  const r = await client(env, freshIp()).post('/api/gate/sync', { scans }, auth);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { synced: 3, duplicates: 0, skipped: 0 });
  const rows = env.DB.raw.prepare("SELECT id, steward_id, result FROM scans WHERE id LIKE 'OFOFFLINE%' ORDER BY id").all();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x) => x.steward_id === steward.steward.id));
  const again = await client(env, freshIp()).post('/api/gate/sync', { scans }, auth);
  assert.equal(again.body.synced, 0, 'resending is harmless');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM scans WHERE id LIKE 'OFOFFLINE%'").get().n, 3);
});
await test('a ticket two offline scanners both let in is recorded and marked; the report flags it', async () => {
  const e = await fan(6);
  const s1 = { id: 'OFFLINEBBBBBBBB1', ref: 'p:' + e.pass.id, zone_id: gate, result: 'granted', at: now() - 60 };
  const s2 = { id: 'OFFLINEBBBBBBBB2', ref: 'p:' + e.pass.id, zone_id: gate, result: 'granted', at: now() - 50 };
  const r = await client(env, freshIp()).post('/api/gate/sync', { scans: [s1, s2] }, auth);
  assert.deepEqual(r.body, { synced: 2, duplicates: 1, skipped: 0 });
  const rep = (await org.get(`/api/events/${id}/report`)).body;
  assert.ok(rep.flags.some((f) => /let in twice while scanners had no signal/.test(f.text)));
  assert.ok(rep.flags.some((f) => /made with no signal/.test(f.text)));
  assert.ok(rep.totals.offline_scans >= 5);
  const csv = (await org.call('GET', `/api/events/${id}/scans.csv`, { raw: true })).body;
  assert.ok(csv.includes('Entered (offline)'));
  assert.ok(csv.includes('Entered twice while offline'));
});
await test('bad offline rows are skipped: unknown tickets, other events’ areas, odd times, made-up reasons', async () => {
  const r = await client(env, freshIp()).post('/api/gate/sync', { scans: [
    { id: 'OFFLINECCCCCCCC1', ref: 'p:ZZZZZZZZZZ', zone_id: gate, result: 'granted', at: now() },
    { id: 'OFFLINECCCCCCCC2', ref: null, zone_id: 'NOTAZONE', result: 'denied', reason: 'invalid_token', at: now() },
    { id: 'OFFLINECCCCCCCC3', ref: null, zone_id: gate, result: 'denied', reason: 'invalid_token', at: now() + 3600 },
    { id: 'OFFLINECCCCCCCC4', ref: null, zone_id: gate, result: 'denied', reason: 'because', at: now() },
    { id: 'bad id', ref: null, zone_id: gate, result: 'denied', reason: 'invalid_token', at: now() }
  ] }, auth);
  assert.deepEqual(r.body, { synced: 0, duplicates: 0, skipped: 5 });
});
await test('a removed steward cannot send offline scans', async () => {
  await org.post(`/api/events/${id}/stewards/${steward.steward.id}/revoke`, {});
  const r = await client(env, freshIp()).post('/api/gate/sync', { scans: [{ id: 'OFFLINEDDDDDDDD1', ref: null, zone_id: gate, result: 'denied', reason: 'invalid_token', at: now() }] }, auth);
  assert.equal(r.status, 401);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
