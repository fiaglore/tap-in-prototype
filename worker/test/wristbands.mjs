// Printable wristbands: random codes stored as imported tickets that the gate scans like any other.
// Run with: node test/wristbands.mjs
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
const freshIp = () => '10.91.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const anon = () => client(env, freshIp());
const org = await signIn(env, 'host@wristbands.test', '10.91.200.1', 'Hosting Person');
const other = await signIn(env, 'other@wristbands.test', '10.91.200.2', 'Other Host');

const ev = (await org.post('/api/events', { name: 'Palm Grove Festival', zones: ['Main gate', 'VIP area'], tiers: [{ name: 'Regular', zones: ['Main gate'] }, { name: 'VIP', zones: ['Main gate', 'VIP area'] }], listed: false })).body;
const id = ev.event.id;
const main = ev.zones.find((z) => z.name === 'Main gate').id;
const vip = ev.zones.find((z) => z.name === 'VIP area').id;
const tier = (n) => ev.tiers.find((t) => t.name === n).id;
const scan = (token, zone = main, key = ev.gate_key) => anon().post('/api/gate/scan', { token, zone_id: zone }, { headers: { Authorization: 'Bearer ' + key } });

let bands;
await test('the organiser makes wristbands: numbered, random, unique codes returned once', async () => {
  const r = await org.post(`/api/events/${id}/wristbands`, { tier_id: tier('Regular'), count: 25 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  bands = r.body.wristbands;
  assert.equal(bands.length, 25);
  assert.equal(r.body.tier, 'Regular');
  assert.deepEqual(bands.map((w) => w.number), Array.from({ length: 25 }, (_, i) => i + 1));
  for (const w of bands) assert.match(w.code, /^WB[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.equal(new Set(bands.map((w) => w.code)).size, 25);
});
await test('numbering continues on a second batch', async () => {
  const r = await org.post(`/api/events/${id}/wristbands`, { tier_id: tier('VIP'), count: 2 });
  assert.deepEqual(r.body.wristbands.map((w) => w.number), [26, 27]);
  bands.push(...r.body.wristbands.map((w) => ({ ...w, vip: true })));
});
await test('nothing secret is stored: no plain code in the database', async () => {
  const rows = env.DB.raw.prepare("SELECT * FROM guests WHERE event_id = ? AND name LIKE 'Wristband-%'").all(id);
  assert.equal(rows.length, 27);
  const dump = JSON.stringify(rows);
  for (const w of bands) assert.ok(!dump.includes(w.code), 'plain code stored');
  assert.ok(rows.every((r) => r.code_hash && r.kind === 'import'));
});
await test('the gate admits a wristband once per area, then says already used', async () => {
  const a = await scan(bands[0].code);
  assert.equal(a.body.result, 'granted', JSON.stringify(a.body));
  assert.equal(a.body.holder, 'Wristband-1');
  const b = await scan(bands[0].code);
  assert.equal(b.body.result, 'denied');
  assert.equal(b.body.reason, 'already_used');
});
await test('scanning is forgiving about case, spaces and dashes (as printed WB-XXXXX-XXXXX)', async () => {
  const c = bands[1].code;
  const printed = `${c.slice(0, 2)}-${c.slice(2, 7)}-${c.slice(7)}`.toLowerCase();
  assert.equal((await scan(printed)).body.result, 'granted');
});
await test('a wristband only opens the areas its ticket type allows', async () => {
  assert.equal((await scan(bands[2].code, vip)).body.result, 'denied', 'Regular wristband at the VIP area');
  const v = bands.find((w) => w.vip);
  assert.equal((await scan(v.code, vip)).body.result, 'granted', 'VIP wristband at the VIP area');
});
await test('a made-up code is refused', async () => {
  const r = await scan('WB' + '0'.repeat(10));
  assert.equal(r.body.result, 'denied');
  assert.equal(r.body.reason, 'invalid_token');
});
await test('a cancelled wristband is refused', async () => {
  const list = (await org.get(`/api/events/${id}/guests`)).body.guests;
  const g = list.find((x) => x.name === 'Wristband-4');
  assert.ok(g, 'wristbands show in the guest list');
  assert.equal((await org.post(`/api/events/${id}/guests/${g.id}/revoke`, {})).status, 200);
  const r = await scan(bands[3].code);
  assert.equal(r.body.result, 'denied');
});
await test('wristband codes do not work at a different event', async () => {
  const ev2 = (await org.post('/api/events', { name: 'Other Night', zones: ['Door'], tiers: [{ name: 'Entry', zones: ['Door'] }], listed: false })).body;
  const r = await anon().post('/api/gate/scan', { token: bands[5].code, zone_id: ev2.zones[0].id }, { headers: { Authorization: 'Bearer ' + ev2.gate_key } });
  assert.equal(r.body.result, 'denied');
});
await test('count and ticket type are checked; only the owner can make wristbands', async () => {
  for (const count of [0, 501, 1.5, 'x', undefined]) {
    const r = await org.post(`/api/events/${id}/wristbands`, { tier_id: tier('Regular'), count });
    assert.equal(r.status, 400, 'count ' + count);
  }
  assert.equal((await org.post(`/api/events/${id}/wristbands`, { tier_id: 'nope', count: 1 })).status, 400);
  assert.ok([403, 404].includes((await other.post(`/api/events/${id}/wristbands`, { tier_id: tier('Regular'), count: 1 })).status));
  assert.equal((await anon().post(`/api/events/${id}/wristbands`, { tier_id: tier('Regular'), count: 1 })).status, 401);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
