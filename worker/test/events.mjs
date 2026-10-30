// Phase 2 tests: events and concerts. Ticket limits, sales windows, and the live (rotating) QR.
// Run with: node test/events.mjs
import assert from 'node:assert/strict';
import { PEPPER, client, makeEnv, signIn } from './harness.mjs';
import { liveToken, passToken } from '../src/lib/codes.js';

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

const env = makeEnv();
const now = () => Math.floor(Date.now() / 1000);
const iso = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
let org, fan;
const mk = async (extra = {}, tierExtra = {}) => {
  const r = await org.post('/api/events', { name: 'Test Fest', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 500000, ...tierExtra }], ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const issued = (tierId) => env.DB.raw.prepare("SELECT COUNT(*) AS n FROM invites WHERE tier_id = ? AND status != 'revoked'").get(tierId).n;

org = await signIn(env, 'promoter@example.com', '10.40.0.1', 'Pat Promoter');
fan = await signIn(env, 'fan@example.com', '10.40.0.2', 'Fan Person');

group('Ticket limits');
await test('a ticket type can have a limit; blank means unlimited; nonsense is refused', async () => {
  const ok = await mk({}, { capacity: 3 });
  assert.equal(ok.tiers[0].capacity, 3);
  assert.equal(ok.tiers[0].issued, 0);
  assert.equal((await mk({}, {})).tiers[0].capacity, null);
  for (const bad of [0, -1, 1.5, 'lots', 2_000_000]) {
    const r = await org.post('/api/events', { name: 'Bad', zones: ['G'], tiers: [{ name: 'T', zones: ['G'], capacity: bad }] });
    assert.equal(r.status, 400, 'accepted ' + bad);
    assert.equal(r.body.error.code, 'invalid_capacity');
  }
});
await test('the organiser cannot issue more codes than the limit, and a refused batch issues nothing', async () => {
  const e = await mk({}, { capacity: 3 });
  const t = e.tiers[0].id;
  assert.equal((await org.post(`/api/events/${e.event.id}/invites`, { tier_id: t, count: 2 })).status, 201);
  const over = await org.post(`/api/events/${e.event.id}/invites`, { tier_id: t, count: 2 });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'sold_out');
  assert.equal(issued(t), 2, 'a refused batch must not issue part of itself');
  assert.equal((await org.post(`/api/events/${e.event.id}/invites`, { tier_id: t, count: 1 })).status, 201);
});
await test('cancelling an unused invite frees its place', async () => {
  const e = await mk({}, { capacity: 1 });
  const t = e.tiers[0].id;
  await org.post(`/api/events/${e.event.id}/invites`, { tier_id: t, count: 1 });
  assert.equal((await org.post(`/api/events/${e.event.id}/invites`, { tier_id: t, count: 1 })).status, 409);
  const inv = (await org.get(`/api/events/${e.event.id}/invites`)).body.invites[0];
  await org.post(`/api/events/${e.event.id}/invites/${inv.id}/revoke`);
  assert.equal((await org.post(`/api/events/${e.event.id}/invites`, { tier_id: t, count: 1 })).status, 201);
});
await test('public buyers hit the same limit, and a sold-out ticket shows as sold out without leaking counts', async () => {
  const e = await mk({}, { capacity: 2 });
  const t = e.tiers[0].id;
  assert.equal((await fan.post(`/api/public/events/${e.event.id}/buy`, { tier_id: t, qty: 3 })).status, 409);
  assert.equal(issued(t), 0);
  assert.equal((await fan.post(`/api/public/events/${e.event.id}/buy`, { tier_id: t, qty: 2 })).status, 201);
  const page = (await client(env, '10.40.1.1').get(`/api/public/events/${e.event.id}`)).body;
  assert.equal(page.tiers[0].sold_out, true);
  assert.ok(!('capacity' in page.tiers[0]) && !('issued' in page.tiers[0]));
  assert.equal((await fan.post(`/api/public/events/${e.event.id}/buy`, { tier_id: t, qty: 1 })).body.error.code, 'sold_out');
});
await test('buyers only see how many are left once it is a handful', async () => {
  const big = await mk({}, { capacity: 500 });
  assert.equal((await client(env, '10.40.1.2').get(`/api/public/events/${big.event.id}`)).body.tiers[0].left, null);
  const small = await mk({}, { capacity: 5 });
  await fan.post(`/api/public/events/${small.event.id}/buy`, { tier_id: small.tiers[0].id, qty: 2 });
  assert.equal((await client(env, '10.40.1.2').get(`/api/public/events/${small.event.id}`)).body.tiers[0].left, 3);
});
await test('two buyers racing for the last ticket: exactly one gets it', async () => {
  const e = await mk({}, { capacity: 1 });
  const other = await signIn(env, 'rival@example.com', '10.40.0.3', 'Rival');
  const [a, b] = await Promise.all([
    fan.post(`/api/public/events/${e.event.id}/buy`, { tier_id: e.tiers[0].id, qty: 1 }),
    other.post(`/api/public/events/${e.event.id}/buy`, { tier_id: e.tiers[0].id, qty: 1 })
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(issued(e.tiers[0].id), 1);
});
await test('the limit can be raised or lowered, but not below what is issued; price changes work', async () => {
  const e = await mk({}, { capacity: 4 });
  const t = e.tiers[0].id;
  await org.post(`/api/events/${e.event.id}/invites`, { tier_id: t, count: 3 });
  const low = await org.call('PATCH', `/api/events/${e.event.id}/tiers/${t}`, { body: { capacity: 2 } });
  assert.equal(low.status, 400);
  assert.equal(low.body.error.code, 'capacity_below_issued');
  const up = await org.call('PATCH', `/api/events/${e.event.id}/tiers/${t}`, { body: { capacity: 10, price_kobo: 750000 } });
  assert.equal(up.status, 200);
  assert.equal(up.body.tiers[0].capacity, 10);
  assert.equal(up.body.tiers[0].price_kobo, 750000);
  assert.equal((await org.call('PATCH', `/api/events/${e.event.id}/tiers/${t}`, { body: { capacity: null } })).body.tiers[0].capacity, null);
  assert.equal((await org.call('PATCH', `/api/events/${e.event.id}/tiers/${t}`, { body: { price_kobo: -5 } })).status, 400);
});
await test('only the owner can change a ticket type', async () => {
  const e = await mk({}, { capacity: 4 });
  assert.equal((await fan.call('PATCH', `/api/events/${e.event.id}/tiers/${e.tiers[0].id}`, { body: { capacity: 99 } })).status, 404);
});

group('Sales windows');
await test('sales that have not opened, or have closed, refuse to sell; an open window sells', async () => {
  const later = await mk({ sales_start: iso(3600) });
  assert.equal((await client(env, '10.40.2.1').get(`/api/public/events/${later.event.id}`)).body.event.sales, 'upcoming');
  assert.equal((await fan.post(`/api/public/events/${later.event.id}/buy`, { tier_id: later.tiers[0].id })).body.error.code, 'sales_not_open');
  const over = await mk({ sales_start: iso(-7200), sales_end: iso(-3600) });
  assert.equal((await fan.post(`/api/public/events/${over.event.id}/buy`, { tier_id: over.tiers[0].id })).body.error.code, 'sales_closed');
  const open = await mk({ sales_start: iso(-3600), sales_end: iso(3600) });
  assert.equal((await client(env, '10.40.2.1').get(`/api/public/events/${open.event.id}`)).body.event.sales, 'open');
  assert.equal((await fan.post(`/api/public/events/${open.event.id}/buy`, { tier_id: open.tiers[0].id })).status, 201);
});
await test('the organiser can still issue codes outside the sales window (comps, sponsors)', async () => {
  const over = await mk({ sales_end: iso(-60), sales_start: iso(-3600) });
  assert.equal((await org.post(`/api/events/${over.event.id}/invites`, { tier_id: over.tiers[0].id, count: 1 })).status, 201);
});
await test('a window that ends before it starts is refused, and it can be changed later', async () => {
  const bad = await org.post('/api/events', { name: 'Bad window', zones: ['G'], tiers: [{ name: 'T', zones: ['G'] }], sales_start: iso(3600), sales_end: iso(60) });
  assert.equal(bad.body.error.code, 'invalid_sales_window');
  const e = await mk({ sales_start: iso(3600) });
  const r = await org.call('PATCH', '/api/events/' + e.event.id, { body: { sales_start: null } });
  assert.equal(r.status, 200);
  assert.equal(r.body.event.sales_start, null);
  assert.equal((await client(env, '10.40.2.2').get(`/api/public/events/${e.event.id}`)).body.event.sales, 'open');
  assert.equal((await org.call('PATCH', '/api/events/' + e.event.id, { body: { sales_end: iso(-60), sales_start: iso(60) } })).status, 400);
});
await test('ticket sales cannot open after the event date: refused when creating and when editing', async () => {
  const day = 86400;
  const org = await signIn(env, 'sales-dates@example.com', '10.40.0.9', 'Sales Dates'); // its own organiser: events are limited per person
  const mk = async (extra) => (await org.post('/api/events', { name: 'Test Fest', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'] }], ...extra })).body;
  const late = await org.post('/api/events', { name: 'Late sales', zones: ['G'], tiers: [{ name: 'T', zones: ['G'] }], starts_at: iso(2 * day), sales_start: iso(3 * day) });
  assert.equal(late.status, 400);
  assert.equal(late.body.error.code, 'sales_open_after_event');
  // Before the event, or no sales date at all, is fine; so is an event with no date yet.
  assert.equal((await org.post('/api/events', { name: 'Ok sales', zones: ['G'], tiers: [{ name: 'T', zones: ['G'] }], starts_at: iso(2 * day), sales_start: iso(day) })).status, 201);
  assert.equal((await org.post('/api/events', { name: 'No date', zones: ['G'], tiers: [{ name: 'T', zones: ['G'] }], sales_start: iso(3 * day) })).status, 201);
  const e = await mk({ starts_at: iso(5 * day), sales_start: iso(day) });
  const patch = (body) => org.call('PATCH', '/api/events/' + e.event.id, { body });
  const edit = await patch({ sales_start: iso(6 * day) });
  assert.equal(edit.status, 400);
  assert.equal(edit.body.error.code, 'sales_open_after_event');
  // Moving the event earlier than the sales-open date is refused too, and nothing is saved.
  const move = await patch({ name: 'Renamed', starts_at: iso(day / 2) });
  assert.equal(move.status, 400);
  assert.equal(move.body.error.code, 'sales_open_after_event');
  const after = (await org.get('/api/events/' + e.event.id)).body.event;
  assert.equal(after.name, 'Test Fest', 'a refused edit saves nothing');
  // Changing both together to a valid pair works; renaming alone is never blocked.
  assert.equal((await patch({ starts_at: iso(8 * day), sales_start: iso(7 * day) })).status, 200);
  assert.equal((await patch({ name: 'Renamed' })).status, 200);
});

group('Live QR (screenshots stop working)');
let sec, secPass, gk, zone;
const scan = (token, ip = '10.40.9.1') => client(env, ip).post('/api/gate/scan', { token, zone_id: zone }, { headers: { Authorization: 'Bearer ' + gk } });
await test('on a secure event the permanent pass code is never handed to the phone', async () => {
  sec = await mk({ secure_qr: true, allow_reentry: true });
  gk = sec.gate_key;
  zone = sec.zones[0].id;
  assert.equal(sec.event.secure_qr, true);
  const code = (await org.post(`/api/events/${sec.event.id}/invites`, { tier_id: sec.tiers[0].id, count: 1 })).body.codes[0];
  secPass = (await fan.post('/api/claim', { code })).body.pass;
  assert.equal(secPass.token, null);
  assert.equal(secPass.live, true);
  assert.equal((await fan.get('/api/me')).body.passes.find((p) => p.id === secPass.id).token, null);
});
await test('the phone gets a live code that the gate accepts', async () => {
  const r = await fan.get(`/api/me/passes/${secPass.id}/live`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.token, /^TQ-/);
  assert.equal(r.body.refresh_in, 20);
  const s = await scan(r.body.token);
  assert.equal(s.body.result, 'granted', JSON.stringify(s.body));
  assert.equal(s.body.holder, 'Fan P.');
});
await test('a screenshot of an old code stops working; a fresh one still does', async () => {
  const old = await liveToken(PEPPER, secPass.id, now() - 600);
  const r = await scan(old);
  assert.equal(r.body.result, 'denied');
  assert.equal(r.body.reason, 'stale_code');
  const justNow = await liveToken(PEPPER, secPass.id, now() - 45);
  assert.equal((await scan(justNow)).body.result, 'granted');
});
await test('the permanent code is refused on a secure event, a forged live code is refused, nothing is admitted', async () => {
  const stat = await scan(await passToken(PEPPER, secPass.id));
  assert.equal(stat.body.reason, 'static_pass');
  const good = (await fan.get(`/api/me/passes/${secPass.id}/live`)).body.token;
  const forged = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
  assert.equal((await scan(forged)).body.reason, 'invalid_token');
  const otherEvent = await mk({ secure_qr: true });
  const code = (await org.post(`/api/events/${otherEvent.event.id}/invites`, { tier_id: otherEvent.tiers[0].id, count: 1 })).body.codes[0];
  const p2 = (await fan.post('/api/claim', { code })).body.pass;
  const live2 = (await fan.get(`/api/me/passes/${p2.id}/live`)).body.token;
  assert.equal((await scan(live2)).body.reason, 'wrong_event');
});
await test('only the holder can get a live code, and only for an active pass', async () => {
  const other = await signIn(env, 'thief@example.com', '10.40.0.4', 'Thief');
  assert.equal((await other.get(`/api/me/passes/${secPass.id}/live`)).status, 404);
  assert.equal((await client(env, '10.40.0.5').get(`/api/me/passes/${secPass.id}/live`)).status, 401);
  const att = (await org.get(`/api/events/${sec.event.id}/attendees`)).body.attendees[0];
  await org.post(`/api/events/${sec.event.id}/passes/${att.id}/revoke`);
  assert.equal((await fan.get(`/api/me/passes/${secPass.id}/live`)).status, 409);
  assert.equal((await scan(await liveToken(PEPPER, secPass.id, now()))).body.reason, 'revoked');
});
await test('a normal event is unchanged: the permanent code still works there', async () => {
  const plain = await mk();
  const code = (await org.post(`/api/events/${plain.event.id}/invites`, { tier_id: plain.tiers[0].id, count: 1 })).body.codes[0];
  const p = (await fan.post('/api/claim', { code })).body.pass;
  assert.match(p.token, /^TP-/);
  const r = await client(env, '10.40.9.9').post('/api/gate/scan', { token: p.token, zone_id: plain.zones[0].id }, { headers: { Authorization: 'Bearer ' + plain.gate_key } });
  assert.equal(r.body.result, 'granted');
});
await test('the secure setting can be switched on later', async () => {
  const e = await mk();
  const r = await org.call('PATCH', '/api/events/' + e.event.id, { body: { secure_qr: true } });
  assert.equal(r.body.event.secure_qr, true);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed: ' + failures.join('; '));
  process.exit(1);
}
