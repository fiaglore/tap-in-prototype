// Editing an event after it is set up: details, areas and ticket types. Run with: node test/edit.mjs
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
const freshIp = () => '10.97.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const org = await signIn(env, 'org@edit.test', '10.97.200.1', 'Edit Organiser');
const other = await signIn(env, 'other@edit.test', '10.97.200.2', 'Other');
const ev = (await org.post('/api/events', { name: 'Fest Typo', venue: 'Old Venue', city: 'Lagos', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 100000 }] })).body;
const id = ev.event.id;
const gate = ev.zones[0].id;
const ga = ev.tiers[0].id;
const del = (path) => org.call('DELETE', path);
const scan = (token, zone) => client(env, freshIp()).post('/api/gate/scan', { token, zone_id: zone }, { headers: { Authorization: 'Bearer ' + ev.gate_key } });

await test('the name, venue, city and date can be changed; tickets already issued keep working', async () => {
  const code = (await org.post(`/api/events/${id}/invites`, { tier_id: ga, count: 1 })).body.codes[0];
  const r = await org.patch('/api/events/' + id, { name: 'Fest Proper', venue: 'Harbour Point', city: 'Abuja', starts_at: new Date(Date.now() + 86400e3).toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.event.name, 'Fest Proper');
  assert.equal(r.body.event.venue, 'Harbour Point');
  assert.equal(r.body.event.city, 'Abuja');
  assert.ok(r.body.event.starts_at > Date.now() / 1000);
  const fan = await signIn(env, 'fan@edit.test', freshIp(), 'Fan');
  assert.equal((await fan.post('/api/claim', { code })).status, 201, 'a code made before the rename still claims');
  assert.equal((await client(env, freshIp()).get('/api/public/events/' + id)).body.event.name, 'Fest Proper');
  assert.equal((await org.patch('/api/events/' + id, { name: 'X' })).status, 400, 'too short');
  assert.equal((await other.patch('/api/events/' + id, { name: 'Hijack' })).status, 404);
  assert.equal((await org.patch('/api/events/' + id, { venue: '' })).body.event.venue, null, 'venue can be cleared');
});
let vip, backstage;
await test('areas can be added and renamed, with no duplicate names', async () => {
  const r = await org.post(`/api/events/${id}/zones`, { name: 'VIP Lounge' });
  assert.equal(r.status, 201);
  vip = r.body.zones.find((z) => z.name === 'VIP Lounge').id;
  assert.equal((await org.post(`/api/events/${id}/zones`, { name: 'vip lounge' })).status, 400);
  const ren = await org.patch(`/api/events/${id}/zones/${gate}`, { name: 'Main Gate' });
  assert.equal(ren.body.zones.find((z) => z.id === gate).name, 'Main Gate');
  backstage = (await org.post(`/api/events/${id}/zones`, { name: 'Backstage' })).body.zones.find((z) => z.name === 'Backstage').id;
});
await test('a ticket type can be renamed and opened to more areas; passes follow at their next scan', async () => {
  const fan = await signIn(env, 'fan2@edit.test', freshIp(), 'Fan Two');
  const code = (await org.post(`/api/events/${id}/invites`, { tier_id: ga, count: 1 })).body.codes[0];
  const pass = (await fan.post('/api/claim', { code })).body.pass;
  assert.equal((await scan(pass.token, vip)).body.reason, 'no_zone_access');
  const r = await org.patch(`/api/events/${id}/tiers/${ga}`, { name: 'General', zone_ids: [gate, vip] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.tiers.find((x) => x.id === ga);
  assert.equal(t.name, 'General');
  assert.deepEqual(t.zone_ids.sort(), [gate, vip].sort());
  assert.equal((await scan(pass.token, vip)).body.result, 'granted');
  assert.equal((await org.patch(`/api/events/${id}/tiers/${ga}`, { zone_ids: [] })).status, 400, 'at least one area');
  assert.equal((await org.patch(`/api/events/${id}/tiers/${ga}`, { zone_ids: ['NOTMINE'] })).status, 400);
});
let crew;
await test('a new ticket type can be added with its areas, price and limit, and removed while unused', async () => {
  const r = await org.post(`/api/events/${id}/tiers`, { name: 'Crew', zone_ids: [backstage, gate], price_kobo: 0, capacity: 20 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  crew = r.body.tiers.find((t) => t.name === 'Crew');
  assert.equal(crew.capacity, 20);
  assert.equal((await org.post(`/api/events/${id}/tiers`, { name: 'crew', zone_ids: [gate] })).status, 400);
  const temp = (await org.post(`/api/events/${id}/tiers`, { name: 'Temp', zone_ids: [gate] })).body.tiers.find((t) => t.name === 'Temp');
  assert.equal((await del(`/api/events/${id}/tiers/${temp.id}`)).status, 200);
  assert.equal((await del(`/api/events/${id}/tiers/${ga}`)).status, 409, 'a type with tickets cannot be removed');
});
await test('an area can be removed before anyone is scanned there, but not a type’s only area or a used one', async () => {
  assert.equal((await del(`/api/events/${id}/zones/${backstage}`)).status, 200, 'Crew still has the gate');
  assert.equal((await del(`/api/events/${id}/zones/${vip}`)).status, 409, 'someone was scanned at VIP');
  const solo = (await org.post(`/api/events/${id}/zones`, { name: 'Solo' })).body.zones.find((z) => z.name === 'Solo').id;
  await org.post(`/api/events/${id}/tiers`, { name: 'Solo Pass', zone_ids: [solo] });
  const r = await del(`/api/events/${id}/zones/${solo}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'zone_needed');
});
await test('an event cannot be created or moved into the past; an event that has started can still be renamed', async () => {
  const yesterday = new Date(Date.now() - 86400e3).toISOString();
  const made = await org.post('/api/events', { name: 'Too Late', starts_at: yesterday, zones: ['G'], tiers: [{ name: 'T', zones: ['G'] }] });
  assert.equal(made.status, 400);
  assert.equal(made.body.error.code, 'date_in_past');
  const moved = await org.patch('/api/events/' + id, { starts_at: yesterday });
  assert.equal(moved.status, 400);
  assert.equal(moved.body.error.code, 'date_in_past');
  // Doors opened an hour ago: the organiser fixes a typo in the name, sending the same date back.
  const startedAt = Math.floor(Date.now() / 1000) - 3600;
  env.DB.raw.prepare('UPDATE events SET starts_at = ? WHERE id = ?').run(startedAt, id);
  const renamed = await org.patch('/api/events/' + id, { name: 'Fest Proper Live', starts_at: new Date(startedAt * 1000).toISOString() });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.event.starts_at, startedAt);
  assert.equal((await org.patch('/api/events/' + id, { starts_at: null })).status, 200, 'the date can be cleared ("to be announced")');
});
await test('offices: a group’s days and hours can be changed', async () => {
  const off = (await org.post('/api/events', { kind: 'workplace', name: 'Acme HQ', require_photo: false, zones: ['Front door'], tiers: [{ name: 'Staff', zones: ['Front door'], days: [0, 1, 2, 3, 4], from: '07:00', to: '19:00' }] })).body;
  const r = await org.patch(`/api/events/${off.event.id}/tiers/${off.tiers[0].id}`, { days: [0, 1, 2, 3, 4, 5], from: '06:00', to: '22:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.tiers[0].schedule, { days: [0, 1, 2, 3, 4, 5], from: '06:00', to: '22:00' });
  assert.equal((await org.patch(`/api/events/${off.event.id}/tiers/${off.tiers[0].id}`, { from: '20:00', to: '08:00' })).status, 400);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
