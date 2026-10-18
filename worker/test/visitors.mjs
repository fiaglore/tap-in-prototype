// Tap In for Business visitors: one-tap visitor links and walk-in check-in. Run with: node test/visitors.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';
import { endOfDay } from '../src/routes/guests.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const env = makeEnv();
let ipN = 1;
const freshIp = () => '10.98.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const anon = () => client(env, freshIp());
const now = () => Math.floor(Date.now() / 1000);
const iso = (sec) => new Date(sec * 1000).toISOString();
const org = await signIn(env, 'admin@visitors.test', '10.98.200.1', 'Office Admin');
const off = (await org.post('/api/events', { kind: 'workplace', name: 'Acme HQ', require_photo: false, zones: ['Reception', 'Server room'], tiers: [{ name: 'Staff', zones: ['Reception', 'Server room'] }, { name: 'Visitors', zones: ['Reception'] }] })).body;
const id = off.event.id;
const reception = off.zones.find((z) => z.name === 'Reception').id;
const server = off.zones.find((z) => z.name === 'Server room').id;
const visitorsTier = off.tiers.find((t) => t.name === 'Visitors').id;
const desk = (await org.post(`/api/events/${id}/stewards`, { name: 'Front Desk' })).body;
const auth = { headers: { Authorization: 'Bearer ' + desk.key } };
const scan = (token, zone = reception) => anon().post('/api/gate/scan', { token, zone_id: zone }, auth);
const tokenOf = (link) => link.split('#')[1];

let v;
await test('the office invites a visitor for today and gets a one-tap link', async () => {
  const r = await org.post(`/api/events/${id}/visitors`, { tier_id: visitorsTier, name: 'Kunle Bello', contact: '0805 000 1111', host: 'Tolu (Finance)', purpose: 'Audit meeting' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  v = r.body.visitor;
  assert.match(v.link, /\/i\/#[0-9A-Z]{22}$/);
  assert.equal(v.contact, '+2348050001111');
  assert.ok(v.valid_from <= now() && v.valid_until > now(), 'today by default');
  assert.equal(v.valid_until, endOfDay(now(), 60));
});
await test('the visitor opens the link with no app or account and sees the office, host, time and QR', async () => {
  const r = await anon().post('/api/invitation', { token: tokenOf(v.link) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kind, 'visitor');
  assert.equal(r.body.event.name, 'Acme HQ');
  assert.equal(r.body.guest.host, 'Tolu (Finance)');
  assert.equal(r.body.guest.purpose, 'Audit meeting');
  assert.match(r.body.code, /^TG-/);
  assert.equal((await anon().post('/api/invitation/rsvp', { token: tokenOf(v.link), response: 'yes' })).status, 400, 'no RSVP for visitors');
  v.code = r.body.code;
});
await test('at the door the visitor gets in where the group allows, and the host is shown', async () => {
  const r = await scan(v.code);
  assert.equal(r.body.result, 'granted', JSON.stringify(r.body));
  assert.equal(r.body.holder, 'Kunle B.');
  assert.equal(r.body.host, 'Tolu (Finance)');
  assert.equal(r.body.guest, 'visitor');
  assert.equal((await scan(v.code, server)).body.reason, 'no_zone_access');
});
await test('a visitor pass works only inside its window', async () => {
  const later = await org.post(`/api/events/${id}/visitors`, { tier_id: visitorsTier, name: 'Tomorrow Person', valid_from: iso(now() + 86400), valid_until: iso(now() + 2 * 86400) });
  const code1 = (await anon().post('/api/invitation', { token: tokenOf(later.body.visitor.link) })).body.code;
  assert.equal((await scan(code1)).body.reason, 'outside_hours', 'not yet');
  const gone = (await org.post(`/api/events/${id}/visitors`, { tier_id: visitorsTier, name: 'Short Visit', valid_from: iso(now() - 3600), valid_until: iso(now() + 60) })).body.visitor;
  env.DB.raw.prepare('UPDATE guests SET valid_until = ? WHERE id = ?').run(now() - 1, gone.id);
  const code2 = (await anon().post('/api/invitation', { token: tokenOf(gone.link) })).body.code;
  assert.equal((await scan(code2)).body.reason, 'expired', 'visit over');
  assert.equal((await org.post(`/api/events/${id}/visitors`, { tier_id: visitorsTier, name: 'Past', valid_from: iso(now() - 7200), valid_until: iso(now() - 3600) })).status, 400);
  assert.equal((await org.post(`/api/events/${id}/visitors`, { tier_id: visitorsTier, name: 'Forever', valid_until: iso(now() + 90 * 86400) })).status, 400);
});
await test('walk-in: the person at the door records a visitor, who is let in and on record until the end of the day', async () => {
  const r = await anon().post('/api/gate/walkin', { name: 'Musa Courier', contact: '0809 222 3333', host: 'Mailroom', purpose: 'Delivery', tier_id: visitorsTier, zone_id: reception }, auth);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.result, 'granted');
  assert.equal(r.body.holder, 'Musa C.');
  assert.equal(r.body.walk_in, true);
  assert.match(r.body.link, /\/i\/#/);
  const row = env.DB.raw.prepare("SELECT walk_in, valid_until, host FROM guests WHERE name = 'Musa Courier'").get();
  assert.equal(row.walk_in, 1);
  assert.equal(row.valid_until, endOfDay(now(), 60));
  const scanRow = env.DB.raw.prepare("SELECT s.steward_id FROM scans s JOIN guests g ON g.id = s.guest_id WHERE g.name = 'Musa Courier'").get();
  assert.equal(scanRow.steward_id, desk.steward.id, 'the walk-in is recorded against the steward');
  // they step out and come back on the link they were sent
  const code = (await anon().post('/api/invitation', { token: tokenOf(r.body.link) })).body.code;
  assert.equal((await scan(code)).body.result, 'granted', 'offices allow coming and going');
});
await test('walk-ins need a name and a real group; events (not offices) cannot use it', async () => {
  assert.equal((await anon().post('/api/gate/walkin', { name: '', tier_id: visitorsTier, zone_id: reception }, auth)).status, 400);
  assert.equal((await anon().post('/api/gate/walkin', { name: 'X Y', tier_id: 'NOPE', zone_id: reception }, auth)).status, 400);
  const ev = (await org.post('/api/events', { name: 'A Concert', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }] })).body;
  const r = await anon().post('/api/gate/walkin', { name: 'X Y', tier_id: ev.tiers[0].id, zone_id: ev.zones[0].id }, { headers: { Authorization: 'Bearer ' + ev.gate_key } });
  assert.equal(r.status, 400);
  assert.equal((await anon().get('/api/gate/info', auth)).body.tiers.length, 2, 'the scanner gets the groups for the walk-in form');
});
await test('the office sees today’s visitors with who they visited, when they arrived and how they came', async () => {
  const r = await org.get(`/api/events/${id}/visitors`);
  assert.equal(r.status, 200);
  const k = r.body.visitors.find((x) => x.name === 'Kunle Bello');
  assert.ok(k.entered_at);
  assert.equal(k.walk_in, 0);
  const m = r.body.visitors.find((x) => x.name === 'Musa Courier');
  assert.equal(m.walk_in, 1);
  assert.equal(m.host, 'Mailroom');
  assert.ok(m.link);
  assert.ok(!(await org.get(`/api/events/${id}/guests`)).body.guests.some((g) => g.name === 'Kunle Bello'), 'visitors are not mixed into the event guest list');
  const ev = (await org.post('/api/events', { name: 'Concert Two', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }] })).body;
  assert.equal((await org.post(`/api/events/${ev.event.id}/visitors`, { tier_id: ev.tiers[0].id, name: 'Nope' })).status, 400);
});
await test('cancelling a visitor stops their link and code', async () => {
  assert.equal((await org.post(`/api/events/${id}/guests/${v.id}/revoke`, {})).status, 200);
  assert.equal((await anon().post('/api/invitation', { token: tokenOf(v.link) })).status, 410);
  assert.equal((await scan(v.code)).body.reason, 'revoked');
});
await test('the offline list carries visit windows so a scanner can judge them with no signal', async () => {
  const list = (await anon().get('/api/gate/list', auth)).body;
  const m = list.guests.find((g) => g.holder === 'Musa C.');
  assert.ok(m.valid_until > now());
  assert.equal(m.host, 'Mailroom');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
