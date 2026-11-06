// Ticket transfers, discount codes and discovery filters. Run with: node test/features.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';
import { hmacHex } from '../src/lib/util.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const SECRET = 'webhook-secret-0123456789';
const env = makeEnv({ TICKET_CHECKOUT: 'mock', PAYMENT_WEBHOOK_SECRET: SECRET, PLATFORM_COMMISSION_BPS: '500', PLATFORM_FLAT_KOBO: '0' });
const db = env.DB.raw;
const org = await signIn(env, 'o@example.com', '10.80.0.1', 'Org');
const anon = client(env, '10.80.0.99');
let n = 0;
const person = (who = 'p') => signIn(env, `${who}${++n}@example.com`, `10.81.${n % 250}.${(n * 7) % 250 + 1}`, 'Person ' + n);
const mk = async (extra = {}, tier = {}) => {
  const r = await org.post('/api/events', { name: 'Feature Fest', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 0, ...tier }], ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const freeTicket = async (e, who) => (await who.post(`/api/public/events/${e.event.id}/buy`, { tier_id: e.tiers[0].id })).status;
const myPasses = async (who) => (await who.get('/api/me')).body.passes || [];
const hook = async (body) => {
  const raw = JSON.stringify(body);
  return anon.call('POST', '/api/webhooks/payments/mock', { body: raw, raw: true, headers: { 'Content-Type': 'application/json', 'x-mock-signature': await hmacHex(SECRET, raw) } });
};
const pay = async (o) => { const r = db.prepare('SELECT provider_ref, total_kobo FROM orders WHERE id = ?').get(o.order.id); return hook({ id: 'e' + Math.random(), type: 'charge.success', ref: r.provider_ref, amount_kobo: r.total_kobo, currency: 'NGN' }); };

console.log('\nTransfers');
await test('a ticket moves to an existing user; the old pass is revoked and a new one issued', async () => {
  const e = await mk();
  const a = await person(), b = await person();
  assert.equal(await freeTicket(e, a), 201);
  const old = (await myPasses(a))[0];
  const r = await a.post(`/api/me/passes/${old.id}/transfer`, { to: 'p2@example.com' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.transfer.status, 'completed');
  assert.equal((await myPasses(a)).filter((p) => p.status === 'active').length, 0);
  const got = (await myPasses(b)).filter((p) => p.status === 'active');
  assert.equal(got.length, 1);
  assert.notEqual(got[0].id, old.id);
});
await test('transferring to someone without an account holds an invite for them until they sign in', async () => {
  const e = await mk();
  const a = await person();
  await freeTicket(e, a);
  const old = (await myPasses(a))[0];
  const r = await a.post(`/api/me/passes/${old.id}/transfer`, { to: 'newcomer@example.com' });
  assert.equal(r.body.transfer.status, 'waiting');
  const c = await signIn(env, 'newcomer@example.com', '10.82.0.1', 'New');
  const pend = (await c.get('/api/me')).body;
  assert.ok(JSON.stringify(pend).length > 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM invites WHERE bound_identifier = 'newcomer@example.com' AND status = 'unused'").get().n, 1);
});
await test('a ticket cannot be sent twice, to yourself, to a bad address, or after entry; others cannot send it', async () => {
  const e = await mk();
  const a = await person(), x = await person();
  await freeTicket(e, a);
  const old = (await myPasses(a))[0];
  assert.equal((await a.post(`/api/me/passes/${old.id}/transfer`, { to: 'nonsense' })).status, 400);
  assert.equal((await a.post(`/api/me/passes/${old.id}/transfer`, { to: db.prepare('SELECT email FROM users WHERE id = (SELECT user_id FROM passes WHERE id = ?)').get(old.id).email })).body.error.code, 'transfer_to_self');
  assert.equal((await x.post(`/api/me/passes/${old.id}/transfer`, { to: 'zzz@example.com' })).status, 404);
  assert.equal((await a.post(`/api/me/passes/${old.id}/transfer`, { to: 'first@example.com' })).status, 201);
  assert.equal((await a.post(`/api/me/passes/${old.id}/transfer`, { to: 'second@example.com' })).status, 404);
  const e2 = await mk();
  const c = await person(); await freeTicket(e2, c);
  const p2 = (await myPasses(c))[0];
  db.prepare("INSERT INTO scans (id, event_id, pass_id, zone_id, result, at) VALUES ('sx', ?, ?, (SELECT id FROM zones WHERE event_id = ? LIMIT 1), 'granted', 1)").run(e2.event.id, p2.id, e2.event.id);
  assert.equal((await c.post(`/api/me/passes/${p2.id}/transfer`, { to: 'late@example.com' })).body.error.code, 'already_used');
});
await test('the organiser can switch transfers off', async () => {
  const e = await mk();
  assert.equal((await org.call('PATCH', '/api/events/' + e.event.id, { body: { allow_transfers: false } })).body.event.allow_transfers, false);
  const a = await person(); await freeTicket(e, a);
  assert.equal((await a.post(`/api/me/passes/${(await myPasses(a))[0].id}/transfer`, { to: 'q@example.com' })).body.error.code, 'transfers_off');
});
await test('two simultaneous transfers of one ticket: exactly one succeeds', async () => {
  const e = await mk();
  const a = await person(); await freeTicket(e, a);
  const id = (await myPasses(a))[0].id;
  const rs = await Promise.all([a.post(`/api/me/passes/${id}/transfer`, { to: 'r1@example.com' }), a.post(`/api/me/passes/${id}/transfer`, { to: 'r2@example.com' })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 404]);
});
await test('the old pass code is refused at the gate after a transfer, and the new one is admitted', async () => {
  const e = await mk();
  const a = await person(); await freeTicket(e, a);
  const b = await person();
  const bEmail = db.prepare('SELECT email FROM users ORDER BY created_at DESC, rowid DESC LIMIT 1').get().email;
  const old = (await myPasses(a))[0];
  const r = await a.post(`/api/me/passes/${old.id}/transfer`, { to: bEmail });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(db.prepare('SELECT status FROM passes WHERE id = ?').get(old.id).status, 'revoked');
  const fresh = (await myPasses(b)).find((p) => p.status === 'active');
  assert.ok(fresh && fresh.id !== old.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM passes WHERE event_id = ?').get(e.event.id).n, 2);
});
await test('a refund of a paid order also revokes a ticket that was transferred on', async () => {
  const e = await mk({}, { price_kobo: 500000 });
  const a = await person(); const b = await person();
  const bEmail = db.prepare('SELECT email FROM users ORDER BY created_at DESC, rowid DESC LIMIT 1').get().email;
  const o = (await a.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id })).body;
  await pay(o);
  const mine = (await myPasses(a)).find((p) => p.status === 'active');
  assert.equal((await a.post(`/api/me/passes/${mine.id}/transfer`, { to: bEmail })).status, 201);
  assert.equal((await myPasses(b)).filter((p) => p.status === 'active').length, 1);
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM passes WHERE order_id = ? AND status = 'active'").get(o.order.id).n, 0);
  assert.equal((await myPasses(b)).filter((p) => p.status === 'active').length, 0);
});

console.log('\nDiscount codes');
const priced = (extra = {}) => mk(extra, { price_kobo: 1000000 });
await test('percent and fixed codes reduce the price; commission follows the reduced price', async () => {
  const e = await priced();
  assert.equal((await org.post(`/api/events/${e.event.id}/discounts`, { code: 'half', percent_off: 50 })).status, 201);
  assert.equal((await org.post(`/api/events/${e.event.id}/discounts`, { code: 'FLAT2K', amount_off_kobo: 200000 })).status, 201);
  const q1 = await anon.post(`/api/public/events/${e.event.id}/quote`, { tier_id: e.tiers[0].id, qty: 2, discount_code: ' Half ' });
  assert.equal(q1.status, 200, JSON.stringify(q1.body));
  assert.equal(q1.body.quote.discount_kobo, 1000000); assert.equal(q1.body.quote.fee_kobo, 50000); assert.equal(q1.body.quote.total_kobo, 1050000);
  const q2 = await anon.post(`/api/public/events/${e.event.id}/quote`, { tier_id: e.tiers[0].id, qty: 2, discount_code: 'flat2k' });
  assert.equal(q2.body.quote.discount_kobo, 400000);
  const q0 = await anon.post(`/api/public/events/${e.event.id}/quote`, { tier_id: e.tiers[0].id, qty: 2 });
  assert.equal(q0.body.quote.total_kobo, 2100000);
});
await test('a discounted order is charged, issued and booked at the reduced price', async () => {
  const e = await priced();
  await org.post(`/api/events/${e.event.id}/discounts`, { code: 'TENOFF', percent_off: 10 });
  const b = await person();
  const o = (await b.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id, discount_code: 'TENOFF' })).body;
  assert.equal(o.order.discount_kobo, 100000); assert.equal(o.order.subtotal_kobo, 900000); assert.equal(o.order.total_kobo, 945000);
  await pay(o);
  const f = (await org.get(`/api/events/${e.event.id}/finance`)).body;
  assert.equal(f.gross_kobo, 945000); assert.equal(f.organiser_payable_kobo, 900000); assert.equal(f.reconciled, true);
});
await test('codes can be limited by uses, ticket type, expiry and revocation; only the owner manages them', async () => {
  const e = await priced();
  await org.post(`/api/events/${e.event.id}/discounts`, { code: 'ONCE', percent_off: 20, max_uses: 1 });
  const b = await person(), c = await person();
  assert.equal((await b.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id, discount_code: 'ONCE' })).status, 201);
  assert.equal((await c.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id, discount_code: 'ONCE' })).body.error.code, 'discount_used_up');
  const old = (await org.post(`/api/events/${e.event.id}/discounts`, { code: 'OLD', percent_off: 20, expires_at: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(old.status, 201);
  assert.equal((await anon.post(`/api/public/events/${e.event.id}/quote`, { tier_id: e.tiers[0].id, discount_code: 'OLD' })).body.error.code, 'discount_expired');
  const r = (await org.post(`/api/events/${e.event.id}/discounts`, { code: 'GONE', percent_off: 5 })).body.discount;
  await org.post(`/api/events/${e.event.id}/discounts/${r.id}/revoke`);
  assert.equal((await anon.post(`/api/public/events/${e.event.id}/quote`, { tier_id: e.tiers[0].id, discount_code: 'GONE' })).body.error.code, 'invalid_discount');
  assert.equal((await anon.post(`/api/public/events/${e.event.id}/quote`, { tier_id: e.tiers[0].id, discount_code: 'NOPE' })).body.error.code, 'invalid_discount');
  assert.equal((await b.get(`/api/events/${e.event.id}/discounts`)).status, 404);
  assert.equal((await org.post(`/api/events/${e.event.id}/discounts`, { code: 'ONCE', percent_off: 5 })).status, 409);
  assert.equal((await org.post(`/api/events/${e.event.id}/discounts`, { code: 'BAD', percent_off: 5, amount_off_kobo: 100 })).status, 400);
  assert.equal((await org.post(`/api/events/${e.event.id}/discounts`, { code: 'BIG', percent_off: 100 })).status, 400);
  assert.equal((await org.get(`/api/events/${e.event.id}/discounts`)).body.discounts.find((d) => d.code === 'ONCE').uses, 1);
});
await test('a code cannot make an order free', async () => {
  const e = await priced();
  await org.post(`/api/events/${e.event.id}/discounts`, { code: 'ALL', amount_off_kobo: 5000000 });
  assert.equal((await anon.post(`/api/public/events/${e.event.id}/quote`, { tier_id: e.tiers[0].id, discount_code: 'ALL' })).body.error.code, 'discount_too_large');
});

console.log('\nDiscovery');
await test('events carry category, country and region; bad values are refused', async () => {
  const r = await org.post('/api/events', { name: 'Lagos Jazz', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'], price_kobo: 500000 }], city: 'Lagos', category: 'music', country: 'ng', region: 'Lagos State' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.event.category, 'music'); assert.equal(r.body.event.country, 'NG');
  assert.equal((await org.post('/api/events', { name: 'Bad Cat', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }], category: 'nope' })).status, 400);
  assert.equal((await org.post('/api/events', { name: 'Bad Cty', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }], country: 'NGA' })).status, 400);
});
await test('filters by category, city, country, date, price, free and availability, with facets', async () => {
  const day = (d) => new Date(Date.now() + d * 86400e3).toISOString();
  await org.post('/api/events', { name: 'Accra Fest', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'], price_kobo: 0 }], city: 'Accra', country: 'GH', category: 'festival', starts_at: day(10) });
  await org.post('/api/events', { name: 'Abuja Summit', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'], price_kobo: 2500000, capacity: 1 }], city: 'Abuja', category: 'conference', starts_at: day(40) });
  const list = async (qs) => (await anon.get('/api/public/events' + qs)).body;
  const names = async (qs) => (await list(qs)).events.map((e) => e.name).sort();
  assert.deepEqual(await names('?category=conference'), ['Abuja Summit']);
  assert.deepEqual(await names('?country=gh'), ['Accra Fest']);
  assert.deepEqual(await names('?city=lagos'), ['Lagos Jazz']);
  assert.ok((await names('?q=summit')).includes('Abuja Summit') && (await names('?q=summit')).length === 1);
  assert.deepEqual(await names('?free=1&country=GH'), ['Accra Fest']);
  assert.ok((await names('?min_price=20000')).includes('Abuja Summit') && !(await names('?min_price=20000')).includes('Lagos Jazz'));
  assert.ok(!(await names('?max_price=1000')).includes('Abuja Summit'));
  const from = new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10);
  assert.deepEqual(await names('?from=' + from), ['Abuja Summit']);
  const f = (await list('')).facets;
  assert.ok(f.cities.includes('Accra') && f.countries.includes('GH') && f.categories.includes('festival'));
  assert.deepEqual(await names("?q=%25"), []); // a lone % is matched literally, not as a wildcard
  assert.equal((await anon.get('/api/public/events?category=%27%3B%20DROP%20TABLE')).status, 200);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
