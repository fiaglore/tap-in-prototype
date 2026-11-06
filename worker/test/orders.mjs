// Phase 1 tests: paid orders, verified webhooks, idempotent issuance, refunds, ledger. Run with: node test/orders.mjs
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
const env = makeEnv({ TICKET_CHECKOUT: 'mock', PAYMENT_WEBHOOK_SECRET: SECRET, PLATFORM_COMMISSION_BPS: '500', PLATFORM_FLAT_KOBO: '10000' });
const org = await signIn(env, 'o@example.com', '10.60.0.1', 'Org');
const fan = await signIn(env, 'f@example.com', '10.60.0.2', 'Fan');
const anon = client(env, '10.60.0.9');
const db = env.DB.raw;

const mk = async (extra = {}, tier = {}) => {
  const r = await org.post('/api/events', { name: 'Pay Fest', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 500000, ...tier }], ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const hook = async (body, { sign = true, sig } = {}) => {
  const raw = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (sign) headers['x-mock-signature'] = sig || (await hmacHex(SECRET, raw));
  return anon.call('POST', '/api/webhooks/payments/mock', { body: raw, raw: true, headers });
};
let buyerN = 0;
const freshBuyer = async () => signIn(env, `buyer${++buyerN}@example.com`, '10.70.0.' + (buyerN % 250 + 1));
const start = async (e, qty = 1, who = null) => {
  who = who || (await freshBuyer());
  const r = await who.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id, qty });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body, buyer: who };
};
const paidEvt = (o, id = 'evt_' + Math.random(), extra = {}) => {
  const row = db.prepare('SELECT provider_ref, total_kobo FROM orders WHERE id = ?').get(o.order.id);
  return { id, type: 'charge.success', ref: row.provider_ref, amount_kobo: row.total_kobo, currency: 'NGN', processor_fee_kobo: 7500, ...extra };
};
const passCount = (orderId) => db.prepare('SELECT COUNT(*) AS n FROM passes WHERE order_id = ?').get(orderId).n;

console.log('\nCheckout');
await test('1. checkout creates a pending order with the buyer-paid fee and issues no ticket', async () => {
  const e = await mk();
  const o = await start(e, 2);
  // subtotal 1,000,000; commission 5% = 50,000 + 2 x 10,000 = 70,000; buyer pays the fee by default
  assert.equal(o.order.subtotal_kobo, 1000000);
  assert.equal(o.order.fee_kobo, 70000);
  assert.equal(o.order.total_kobo, 1070000);
  assert.equal(o.order.status, 'pending');
  assert.match(o.checkout_url, /^https:\/\//);
  assert.equal(passCount(o.order.id), 0);
});
await test('checkout is closed when fees are not configured, or checkout is off/demo', async () => {
  const e = await mk();
  const bare = makeEnv({ TICKET_CHECKOUT: 'mock', PAYMENT_WEBHOOK_SECRET: SECRET });
  const o2 = await signIn(bare, 'o@example.com', '10.61.0.1', 'Org'); const f2 = await signIn(bare, 'f@example.com', '10.61.0.2', 'Fan');
  const e2 = (await o2.post('/api/events', { name: 'Test Fest', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 1000 }] })).body;
  assert.equal((await f2.post(`/api/public/events/${e2.event.id}/checkout`, { tier_id: e2.tiers[0].id })).body.error.code, 'fees_not_configured');
  const off = makeEnv({ TICKET_CHECKOUT: 'off' });
  const o3 = await signIn(off, 'o@example.com', '10.62.0.1', 'Org'); const f3 = await signIn(off, 'f@example.com', '10.62.0.2', 'Fan');
  const e3 = (await o3.post('/api/events', { name: 'Test Fest', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 1000 }] })).body;
  assert.equal((await f3.post(`/api/public/events/${e3.event.id}/checkout`, { tier_id: e3.tiers[0].id })).status, 503);
  assert.ok(e);
});
await test('the instant /buy route still refuses paid tiers in mock mode', async () => {
  const e = await mk();
  assert.equal((await fan.post(`/api/public/events/${e.event.id}/buy`, { tier_id: e.tiers[0].id })).status, 402);
});
await test('pending orders hold stock; a second buyer cannot take the held ticket', async () => {
  const e = await mk({}, { capacity: 1 });
  await start(e, 1);
  const other = await signIn(env, 'f2@example.com', '10.60.0.3');
  assert.equal((await other.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id })).body.error.code, 'sold_out');
});

console.log('\nWebhook: payment and issuance');
await test('a signed success webhook issues exactly the tickets ordered, once', async () => {
  const e = await mk();
  const o = await start(e, 3);
  const r = await hook(paidEvt(o));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, 'paid');
  assert.equal(passCount(o.order.id), 3);
  const got = await o.buyer.get('/api/orders/' + o.order.id);
  assert.equal(got.body.order.status, 'fulfilled');
  assert.equal(got.body.passes.length, 3);
});
await test('3. a duplicate or replayed webhook does not issue a second set', async () => {
  const e = await mk();
  const o = await start(e, 2);
  const evt = paidEvt(o, 'evt_same');
  await hook(evt);
  assert.equal((await hook(evt)).body.outcome, 'duplicate');
  await hook(paidEvt(o, 'evt_other_id_same_payment')); // a different delivery for the same payment
  assert.equal(passCount(o.order.id), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_ledger WHERE order_id = ? AND kind = 'gross'").get(o.order.id).n, 1);
});
await test('two webhooks at the same instant still issue the tickets once', async () => {
  const e = await mk();
  const o = await start(e, 2);
  await Promise.all([hook(paidEvt(o, 'a1')), hook(paidEvt(o, 'a2')), o.buyer.get('/api/orders/' + o.order.id)]);
  assert.equal(passCount(o.order.id), 2);
});
await test('a webhook with a bad or missing signature is refused and changes nothing', async () => {
  const e = await mk();
  const o = await start(e);
  assert.equal((await hook(paidEvt(o), { sig: 'deadbeef' })).status, 401);
  assert.equal((await hook(paidEvt(o), { sign: false })).status, 401);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.order.id).status, 'pending');
  assert.equal(passCount(o.order.id), 0);
});
await test('2. a failed payment issues no ticket; and a success for the wrong amount is held for review', async () => {
  const e = await mk();
  const a = await start(e);
  await hook(paidEvt(a, 'f1', { type: 'charge.failed' }));
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(a.order.id).status, 'failed');
  assert.equal(passCount(a.order.id), 0);
  const b = await start(e);
  assert.equal((await hook(paidEvt(b, 'm1', { amount_kobo: 100 }))).body.outcome, 'amount_mismatch');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(b.order.id).status, 'review');
  assert.equal(passCount(b.order.id), 0);
});
await test('a redirect alone never issues a ticket: polling a pending order issues nothing', async () => {
  const e = await mk();
  const o = await start(e);
  const r = await o.buyer.get('/api/orders/' + o.order.id);
  assert.equal(r.body.order.status, 'pending');
  assert.equal(r.body.passes.length, 0);
});
await test("someone else's order cannot be read", async () => {
  const e = await mk();
  const o = await start(e);
  const other = await signIn(env, 'f3@example.com', '10.60.0.4');
  assert.equal((await other.get('/api/orders/' + o.order.id)).status, 404);
});
await test('paid but sold out by fulfilment: no tickets, order is marked refund_due', async () => {
  const e = await mk({}, { capacity: 1 });
  const o = await start(e, 1);
  await org.post(`/api/events/${e.event.id}/invites`, { tier_id: e.tiers[0].id, count: 1 }).catch(() => {}); // organiser takes the last place
  const r = await hook(paidEvt(o));
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.order.id).status, 'refund_due');
  assert.equal(passCount(o.order.id), 0);
});

console.log('\nLedger, finance, refunds');
await test('11. the ledger adds up (buyer-pays and organiser-absorbs modes) and finance reconciles', async () => {
  const e = await mk();
  const o = await start(e, 2);
  await hook(paidEvt(o));
  let f = (await org.get(`/api/events/${e.event.id}/finance`)).body;
  assert.equal(f.gross_kobo, 1070000); assert.equal(f.organiser_payable_kobo, 1000000); assert.equal(f.commission_kobo, 70000); assert.equal(f.processor_fees_kobo, 7500);
  assert.equal(f.reconciled, true);
  const e2 = await mk();
  db.prepare("UPDATE events SET fee_mode = 'absorb' WHERE id = ?").run(e2.event.id);
  const o2 = await start(e2, 1);
  assert.equal(o2.order.total_kobo, 500000);
  await hook(paidEvt(o2));
  f = (await org.get(`/api/events/${e2.event.id}/finance`)).body;
  assert.equal(f.gross_kobo, 500000); assert.equal(f.commission_kobo, 35000); assert.equal(f.organiser_payable_kobo, 465000); assert.equal(f.reconciled, true);
});
await test('only the organiser can see finance', async () => {
  const e = await mk();
  assert.equal((await fan.get(`/api/events/${e.event.id}/finance`)).status, 404);
});
await test('12. a refund revokes the tickets, frees the stock and reverses the ledger', async () => {
  const e = await mk({}, { capacity: 2 });
  const o = await start(e, 2);
  await hook(paidEvt(o));
  const r = await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM passes WHERE order_id = ? AND status = 'active'").get(o.order.id).n, 0);
  const f = (await org.get(`/api/events/${e.event.id}/finance`)).body;
  assert.equal(f.gross_kobo, 0); assert.equal(f.organiser_payable_kobo, 0); assert.equal(f.commission_kobo, 0); assert.equal(f.reconciled, true);
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`)).body.already, true); // a second click refunds nothing more
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_ledger WHERE order_id = ? AND reason = 'refund'").get(o.order.id).n, 4);
  const again = await start(e, 2); // the two places are free again
  assert.equal(again.order.status, 'pending');
});
await test('a refund the provider rejects changes nothing', async () => {
  const e = await mk();
  const o = await start(e);
  await hook(paidEvt(o));
  const bad = makeEnv({}); void bad;
  env.MOCK_REFUND_FAIL = '1';
  const r = await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`);
  delete env.MOCK_REFUND_FAIL;
  assert.equal(r.status, 502);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.order.id).status, 'fulfilled');
  assert.equal(passCount(o.order.id), 1);
});
await test('an order cannot be refunded after someone has entered, or by a different organiser', async () => {
  const e = await mk();
  const o = await start(e);
  await hook(paidEvt(o));
  const pass = db.prepare('SELECT id FROM passes WHERE order_id = ?').get(o.order.id);
  db.prepare("INSERT INTO scans (id, event_id, pass_id, zone_id, result, reason, at) VALUES ('s1', ?, ?, (SELECT id FROM zones WHERE event_id = ? LIMIT 1), 'granted', NULL, 1)").run(e.event.id, pass.id, e.event.id);
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`)).body.error.code, 'already_used');
  assert.equal((await fan.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`)).status, 404);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
