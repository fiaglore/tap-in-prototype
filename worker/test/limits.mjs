// Per-person ticket limits (2 by default, a group type up to 5) and sales waves (early bird, then regular).
// Run with: node test/limits.mjs
import assert from 'node:assert/strict';
import { makeEnv, signIn } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const env = makeEnv({ TICKET_CHECKOUT: 'demo' });
const db = env.DB.raw;
const org = await signIn(env, 'org@limits.test', '10.150.0.1', 'Org');
let n = 1;
const fan = (name) => signIn(env, `${name}${n}@limits.test`, '10.150.1.' + (n++ % 250 + 1), name);
const mk = async (tiers, extra = {}) => {
  const r = await org.post('/api/events', { name: 'Limits Fest', zones: ['Gate'], tiers: tiers.map((t) => ({ zones: ['Gate'], ...t })), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const buy = (c, e, tier, qty) => c.post(`/api/public/events/${e.event.id}/buy`, { tier_id: tier.id, qty });
const page = async (c, e) => (await c.get(`/api/public/events/${e.event.id}`)).body;
const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

console.log('\nPer-person limit');
await test('the default is 2 per person, and the page tells buyers so', async () => {
  const e = await mk([{ name: 'General' }]);
  const a = await fan('a');
  assert.equal((await page(a, e)).tiers[0].max_per_buyer, 2);
  const r = await buy(a, e, e.tiers[0], 3);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'ticket_limit');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites WHERE tier_id = ?').get(e.tiers[0].id).n, 0);
  assert.equal((await buy(a, e, e.tiers[0], 2)).status, 201);
});
await test('the limit adds up across purchases, and another person is not affected', async () => {
  const e = await mk([{ name: 'General' }]);
  const a = await fan('a'), b = await fan('b');
  assert.equal((await buy(a, e, e.tiers[0], 1)).status, 201);
  const second = await buy(a, e, e.tiers[0], 2);
  assert.equal(second.status, 409); assert.match(second.body.error.message, /already have 1/);
  assert.equal((await buy(a, e, e.tiers[0], 1)).status, 201);
  const third = await buy(a, e, e.tiers[0], 1);
  assert.equal(third.status, 409); assert.match(third.body.error.message, /most/);
  assert.equal((await buy(b, e, e.tiers[0], 2)).status, 201);
});
await test('a failed purchase (sold out) does not use up the person\'s share', async () => {
  const e = await mk([{ name: 'Tiny', capacity: 1, max_per_buyer: 2 }]);
  const a = await fan('a'), b = await fan('b');
  assert.equal((await buy(a, e, e.tiers[0], 2)).body.error.code, 'sold_out');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tier_buys WHERE tier_id = ?').get(e.tiers[0].id).n, 0);
  assert.equal((await buy(b, e, e.tiers[0], 1)).status, 201);
});
await test('a group ticket type allows up to 5 per person, and 6 or more cannot be set', async () => {
  const e = await mk([{ name: 'General' }, { name: 'Group', max_per_buyer: 5 }]);
  const g = e.tiers.find((t) => t.name === 'Group');
  assert.equal(g.max_per_buyer, 5);
  const a = await fan('a');
  assert.equal((await buy(a, e, g, 6)).body.error.code, 'ticket_limit');
  assert.equal((await buy(a, e, g, 5)).status, 201);
  assert.equal((await org.patch(`/api/events/${e.event.id}/tiers/${g.id}`, { max_per_buyer: 6 })).status, 400);
  assert.equal((await org.patch(`/api/events/${e.event.id}/tiers/${g.id}`, { max_per_buyer: 0 })).status, 400);
  assert.equal((await org.patch(`/api/events/${e.event.id}/tiers/${g.id}`, { max_per_buyer: 3 })).status, 200);
  const added = await org.post(`/api/events/${e.event.id}/tiers`, { name: 'Crew', zone_ids: [e.zones[0].id], max_per_buyer: 5 });
  assert.equal(added.status, 201); assert.equal(added.body.tiers.find((t) => t.name === 'Crew').max_per_buyer, 5);
});
await test('paid tickets follow the same limit, counting orders that are still pending as well as paid ones', async () => {
  const paid = makeEnv({ TICKET_CHECKOUT: 'mock', PAYMENT_WEBHOOK_SECRET: 'whs-0123456789abcdef', PLATFORM_COMMISSION_BPS: '500', PLATFORM_FLAT_KOBO: '10000' });
  const o = await signIn(paid, 'o2@limits.test', '10.151.0.1', 'Org');
  const f = await signIn(paid, 'f2@limits.test', '10.151.0.2', 'Fan');
  const e = (await o.post('/api/events', { name: 'Paid', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 500000 }] })).body;
  const co = (q) => f.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id, qty: q });
  assert.equal((await co(3)).body.error.code, 'ticket_limit');
  assert.equal((await co(1)).status, 201);
  const more = await co(2);
  assert.equal(more.status, 409); assert.equal(more.body.error.code, 'ticket_limit');
  assert.equal((await co(1)).status, 201);
  assert.equal((await co(1)).body.error.code, 'ticket_limit');
});
await test('a limit set at 1 means one ticket per person', async () => {
  const e = await mk([{ name: 'Solo', max_per_buyer: 1 }]);
  const a = await fan('a');
  assert.equal((await buy(a, e, e.tiers[0], 2)).body.error.code, 'ticket_limit');
  assert.equal((await buy(a, e, e.tiers[0], 1)).status, 201);
  assert.equal((await buy(a, e, e.tiers[0], 1)).body.error.code, 'ticket_limit');
});

console.log('\nSales waves');
await test('a wave that has not opened cannot be bought, and shows when it opens; once open it can', async () => {
  const opens = now() + 2 * HOUR;
  const e = await mk([{ name: 'Early bird' }, { name: 'Regular', opens_at: opens }]);
  const reg = e.tiers.find((t) => t.name === 'Regular');
  const a = await fan('a');
  const w = (await page(a, e)).tiers.find((t) => t.name === 'Regular').wave;
  assert.equal(w.state, 'upcoming'); assert.equal(w.opens_at, opens);
  const r = await buy(a, e, reg, 1);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'tier_not_open');
  assert.equal((await buy(a, e, e.tiers.find((t) => t.name === 'Early bird'), 1)).status, 201);
  db.prepare('UPDATE tiers SET opens_at = ? WHERE id = ?').run(now() - 5, reg.id);
  assert.equal((await page(a, e)).tiers.find((t) => t.name === 'Regular').wave.state, 'open');
  assert.equal((await buy(a, e, reg, 1)).status, 201);
});
await test('a wave stops selling at its closing time', async () => {
  const e = await mk([{ name: 'Early bird', closes_at: now() + 2 * HOUR }]);
  const a = await fan('a');
  assert.equal((await page(a, e)).tiers[0].wave.state, 'open');
  db.prepare('UPDATE tiers SET closes_at = ? WHERE id = ?').run(now() - 5, e.tiers[0].id);
  const p = await page(a, e);
  assert.equal(p.tiers[0].wave.state, 'closed');
  assert.equal((await buy(a, e, e.tiers[0], 1)).body.error.code, 'tier_closed');
});
await test('a wave can wait for the earlier one to sell out, and opens the moment it does', async () => {
  const e = await mk([{ name: 'Early bird', capacity: 2 }, { name: 'Regular' }]);
  const [early, reg] = [e.tiers.find((t) => t.name === 'Early bird'), e.tiers.find((t) => t.name === 'Regular')];
  const set = await org.patch(`/api/events/${e.event.id}/tiers/${reg.id}`, { opens_after_tier_id: early.id });
  assert.equal(set.status, 200);
  const a = await fan('a');
  let p = await page(a, e);
  assert.equal(p.tiers.find((t) => t.name === 'Regular').wave.state, 'waiting');
  assert.equal(p.tiers.find((t) => t.name === 'Regular').wave.opens_after, 'Early bird');
  assert.equal((await buy(a, e, reg, 1)).body.error.code, 'tier_not_open');
  assert.equal((await buy(a, e, early, 2)).status, 201);
  p = await page(a, e);
  assert.equal(p.tiers.find((t) => t.name === 'Early bird').sold_out, true);
  assert.equal(p.tiers.find((t) => t.name === 'Regular').wave.state, 'open');
  assert.equal((await buy(await fan('b'), e, reg, 1)).status, 201);
});
await test('wave rules are checked: ends after it starts, waits for a real limited type, no loops, removing the earlier type frees it', async () => {
  const e = await mk([{ name: 'A', capacity: 5 }, { name: 'B', capacity: 5 }, { name: 'C' }]);
  const [A, B, C] = ['A', 'B', 'C'].map((x) => e.tiers.find((t) => t.name === x));
  const url = (t) => `/api/events/${e.event.id}/tiers/${t.id}`;
  assert.equal((await org.patch(url(A), { opens_at: now() + 2 * HOUR, closes_at: now() + HOUR })).status, 400);
  assert.equal((await org.patch(url(A), { opens_after_tier_id: A.id })).status, 400);
  assert.equal((await org.patch(url(A), { opens_after_tier_id: 'nope' })).status, 400);
  assert.equal((await org.patch(url(B), { opens_after_tier_id: C.id })).status, 400, 'an unlimited type never sells out');
  assert.equal((await org.patch(url(B), { opens_after_tier_id: A.id })).status, 200);
  assert.equal((await org.patch(url(A), { opens_after_tier_id: B.id })).status, 400, 'a loop would never open');
  assert.equal((await org.patch(url(B), { opens_after_tier_id: null })).status, 200);
  assert.equal((await org.patch(url(B), { opens_after_tier_id: A.id })).status, 200);
  assert.equal((await org.call('DELETE', url(A))).status, 200);
  assert.equal(db.prepare('SELECT opens_after_tier_id AS x FROM tiers WHERE id = ?').get(B.id).x, null);
});
await test('only the organiser can change limits and waves', async () => {
  const e = await mk([{ name: 'General' }]);
  const other = await fan('x');
  assert.equal((await other.patch(`/api/events/${e.event.id}/tiers/${e.tiers[0].id}`, { max_per_buyer: 5 })).status, 404);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
