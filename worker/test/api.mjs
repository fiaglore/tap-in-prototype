// Public API, outbound webhooks, partial refunds and chargebacks. Run with: node test/api.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';
import { hmacHex } from '../src/lib/util.js';
import { flush, signBody, validateUrl } from '../src/lib/outbound.js';
import { openSecret } from '../src/lib/mfa.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const SECRET = 'webhook-secret-0123456789';
const env = makeEnv({ TICKET_CHECKOUT: 'mock', PAYMENT_WEBHOOK_SECRET: SECRET, PLATFORM_COMMISSION_BPS: '500', PLATFORM_FLAT_KOBO: '0' });
const db = env.DB.raw;
const org = await signIn(env, 'api-owner@example.com', '10.110.0.1', 'Owner');
const anon = client(env, '10.110.0.99');
let n = 0;
const person = () => signIn(env, `ap${++n}@example.com`, `10.111.${n % 250}.${(n * 3) % 250 + 1}`, 'P' + n);
const bearer = (k) => ({ headers: { Authorization: 'Bearer ' + k } });
const mkKey = async (mode = 'live', scopes = ['events:read', 'events:write', 'attendance:read', 'payments:read']) => {
  const r = await org.post('/api/me/api-keys', { name: 'k' + (++n), mode, scopes });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.secret;
};
const call = (key, method, path, body) => anon.call(method, '/api/v1' + path, { body, ...bearer(key) });
const hook = async (body) => { const raw = JSON.stringify(body); return anon.call('POST', '/api/webhooks/payments/mock', { body: raw, raw: true, headers: { 'Content-Type': 'application/json', 'x-mock-signature': await hmacHex(SECRET, raw) } }); };
const mkEvent = async (price = 500000, extra = {}) => { const r = await org.post('/api/events', { name: 'Api Fest', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'], price_kobo: price }], ...extra }); assert.equal(r.status, 201); return r.body; };
const buy = async (e, qty = 1) => { const b = await person(); const o = (await b.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id, qty })).body; return { ...o, buyer: b }; };
const pay = async (o, extra = {}) => { const r = db.prepare('SELECT provider_ref, total_kobo FROM orders WHERE id = ?').get(o.order.id); return hook({ id: 'e' + Math.random(), type: 'charge.success', ref: r.provider_ref, amount_kobo: r.total_kobo, currency: 'NGN', processor_fee_kobo: 1000, ...extra }); };
const dispute = (o, type) => hook({ id: 'd' + Math.random(), type, ref: db.prepare('SELECT provider_ref FROM orders WHERE id = ?').get(o.order.id).provider_ref, currency: 'NGN' });
const sumLedger = (orderId, kind) => db.prepare('SELECT COALESCE(SUM(amount_kobo),0) AS n FROM order_ledger WHERE order_id = ? AND kind = ?').get(orderId, kind).n;

console.log('\nAPI keys');
await test('a key is shown once, stored only as a hash, and listed with a hint', async () => {
  const k = await mkKey();
  assert.match(k, /^tk_live_[A-Z0-9]{32}$/);
  const row = db.prepare('SELECT key_hash FROM api_keys ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
  assert.ok(!row.key_hash.includes(k.slice(8)));
  const list = (await org.get('/api/me/api-keys')).body.keys;
  assert.ok(list.every((x) => !('secret' in x) && x.key_hint.startsWith('…')));
});
await test('bad key requests are refused; missing, malformed and revoked keys get 401', async () => {
  assert.equal((await org.post('/api/me/api-keys', { name: 'x', mode: 'nope', scopes: ['events:read'] })).status, 400);
  assert.equal((await org.post('/api/me/api-keys', { name: 'x', mode: 'live', scopes: ['admin'] })).status, 400);
  assert.equal((await anon.get('/api/v1/ping')).status, 401);
  assert.equal((await call('tk_live_' + 'A'.repeat(32), 'GET', '/ping')).status, 401);
  assert.equal((await call('garbage', 'GET', '/ping')).status, 401);
  const k = await mkKey();
  assert.equal((await call(k, 'GET', '/ping')).status, 200);
  const id = db.prepare('SELECT id FROM api_keys ORDER BY created_at DESC, rowid DESC LIMIT 1').get().id;
  assert.equal((await org.post(`/api/me/api-keys/${id}/revoke`)).status, 200);
  assert.equal((await call(k, 'GET', '/ping')).status, 401);
});
await test('keys are rate limited per key', async () => {
  const k = await mkKey();
  db.prepare("UPDATE api_keys SET rate_per_min = 3 WHERE key_hint = ?").run(k.slice(-4));
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push((await call(k, 'GET', '/ping')).status);
  assert.deepEqual(rs, [200, 200, 200, 429, 429]);
});
await test('a session cookie is not an API key, and a key is not a session', async () => {
  assert.equal((await org.get('/api/v1/ping')).status, 401);
  const k = await mkKey();
  assert.equal((await call(k, 'GET', '/me')).status, 404); // /api/v1/me does not exist
  assert.equal((await anon.call('GET', '/api/me', bearer(k))).status, 401);
});

console.log('\nAPI: events, scopes, sandbox');
await test('create, list and read events with a key; each route needs its scope', async () => {
  const k = await mkKey('live');
  const c = await call(k, 'POST', '/events', { name: 'Via Api', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 0 }] });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = c.body.event.id;
  assert.ok((await call(k, 'GET', '/events')).body.events.some((e) => e.id === id));
  assert.equal((await call(k, 'GET', '/events/' + id)).status, 200);
  assert.equal((await call(k, 'GET', `/events/${id}/attendees`)).status, 200);
  assert.equal((await call(k, 'GET', `/events/${id}/scans`)).status, 200);
  const ro = await mkKey('live', ['events:read']);
  assert.equal((await call(ro, 'POST', '/events', { name: 'No', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }] })).body.error.code, 'insufficient_scope');
  assert.equal((await call(ro, 'GET', `/events/${id}/attendees`)).status, 403);
  assert.equal((await call(ro, 'GET', `/events/${id}/finance`)).status, 403);
});
await test("a key reaches only its owner's events", async () => {
  const k = await mkKey();
  const other = await person();
  const e = (await other.post('/api/events', { name: 'Theirs', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }] })).body;
  assert.equal((await call(k, 'GET', '/events/' + e.event.id)).status, 404);
  assert.ok(!(await call(k, 'GET', '/events')).body.events.some((x) => x.id === e.event.id));
});
await test('sandbox keys and live keys cannot see each other\'s events; sandbox events are never public', async () => {
  const live = await mkKey('live'); const box = await mkKey('sandbox');
  const s = (await call(box, 'POST', '/events', { name: 'Sandbox Show', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'], price_kobo: 100000 }], listed: true })).body.event;
  assert.equal(db.prepare('SELECT sandbox, listed FROM events WHERE id = ?').get(s.id).sandbox, 1);
  assert.equal(db.prepare('SELECT listed FROM events WHERE id = ?').get(s.id).listed, 0);
  assert.equal((await call(live, 'GET', '/events/' + s.id)).status, 404);
  const real = (await call(live, 'POST', '/events', { name: 'Real Show', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }] })).body.event;
  assert.equal((await call(box, 'GET', '/events/' + real.id)).status, 404);
  assert.ok(!(await anon.get('/api/public/events')).body.events.some((e) => e.id === s.id));
  assert.ok((await call(box, 'GET', '/events')).body.events.every((e) => e.id !== real.id));
});
await test('payment status through the API', async () => {
  const k = await mkKey();
  const e = await mkEvent();
  const o = await buy(e); await pay(o);
  const r = await call(k, 'GET', '/orders/' + o.order.id);
  assert.equal(r.body.order.status, 'fulfilled');
  assert.equal((await call(k, 'GET', `/events/${e.event.id}/orders`)).body.orders.length, 1);
  assert.equal((await call(k, 'GET', `/events/${e.event.id}/finance`)).body.reconciled, true);
  assert.equal((await call(k, 'GET', '/orders/nope')).status, 404);
});

console.log('\nOutbound webhooks');
await test('addresses must be public https; the signing secret is shown once and stored encrypted', async () => {
  for (const bad of ['http://example.com/h', 'https://localhost/h', 'https://10.0.0.1/h', 'https://user:pw@example.com/h', 'https://example.com:8443/h', 'https://intranet/h', 'ftp://example.com', 'nonsense']) {
    assert.throws(() => validateUrl(bad), /public https|full web address/, bad);
  }
  const r = await org.post('/api/me/webhook-endpoints', { url: 'https://hooks.example.com/tapin', mode: 'live' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.signing_secret, /^whsec_/);
  const stored = db.prepare('SELECT secret FROM webhook_endpoints ORDER BY created_at DESC, rowid DESC LIMIT 1').get().secret;
  assert.ok(!stored.includes(r.body.signing_secret));
  assert.equal((await org.post('/api/me/webhook-endpoints', { url: 'https://x.example.com', mode: 'live', event_types: ['nope'] })).status, 400);
});
await test('a paid order is announced once, signed, and a refund is announced too', async () => {
  const o2 = await signIn(env, 'hooker@example.com', '10.112.0.1', 'Hooker');
  const ep = (await o2.post('/api/me/webhook-endpoints', { url: 'https://hooks.example.com/a', mode: 'live', event_types: ['order.fulfilled', 'order.refunded'] })).body;
  const e = (await o2.post('/api/events', { name: 'Hook Fest', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'], price_kobo: 500000 }] })).body;
  const b = await person();
  const ord = (await b.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id })).body;
  await pay(ord); await pay(ord, { id: 'dup' }); // a second payment confirmation must not announce twice
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ? AND type = 'order.fulfilled'").get(ep.endpoint.id).n, 1);
  const sent = [];
  const fetcher = async (url, init) => { sent.push({ url, init }); return new Response('ok', { status: 200 }); };
  await flush(env, { fetcher });
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.type, 'order.fulfilled'); assert.equal(body.data.order_id, ord.order.id); assert.equal(body.livemode, true);
  assert.ok(!JSON.stringify(body).includes('@'), 'no buyer contact in the payload');
  const sig = sent[0].init.headers['Tap-In-Signature'];
  const t = /t=(\d+)/.exec(sig)[1];
  const secret = await openSecret(env, db.prepare('SELECT secret FROM webhook_endpoints WHERE id = ?').get(ep.endpoint.id).secret);
  assert.equal(sig, await signBody(secret, t, sent[0].init.body));
  assert.equal((await o2.post(`/api/events/${e.event.id}/orders/${ord.order.id}/refund`)).status, 200);
  await flush(env, { fetcher });
  assert.equal(JSON.parse(sent[1].init.body).type, 'order.refunded');
});
await test('a failing endpoint is retried with a growing gap, then given up on', async () => {
  const o3 = await signIn(env, 'flaky@example.com', '10.113.0.1', 'Flaky');
  const ep = (await o3.post('/api/me/webhook-endpoints', { url: 'https://down.example.com/h', mode: 'live' })).body.endpoint;
  const e = (await o3.post('/api/events', { name: 'Flaky Fest', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'], price_kobo: 500000 }] })).body;
  const b = await person();
  await pay((await (async () => ({ ...(await b.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id })).body }))()));
  const bad = async () => new Response('no', { status: 500 });
  await flush(env, { fetcher: bad });
  let d = db.prepare('SELECT attempts, status, next_at FROM webhook_deliveries WHERE endpoint_id = ?').get(ep.id);
  assert.equal(d.attempts, 1); assert.equal(d.status, 'pending');
  assert.equal(await flush(env, { fetcher: bad }), 0); // not due yet
  for (let i = 0; i < 6; i++) { db.prepare('UPDATE webhook_deliveries SET next_at = 0 WHERE endpoint_id = ?').run(ep.id); await flush(env, { fetcher: bad }); }
  d = db.prepare('SELECT attempts, status FROM webhook_deliveries WHERE endpoint_id = ?').get(ep.id);
  assert.equal(d.status, 'failed'); assert.equal(d.attempts, 6);
});

console.log('\nPartial refunds');
await test('refunding some tickets refunds their share, revokes only those, and keeps the books balanced', async () => {
  const e = await mkEvent(1000000);
  const o = await buy(e, 3); // 3,000,000 + 5% fee = 3,150,000
  await pay(o);
  const ids = db.prepare("SELECT id FROM passes WHERE order_id = ? ORDER BY order_seq").all(o.order.id).map((r) => r.id);
  const r = await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`, { pass_ids: [ids[0]] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.refunded_kobo, 1050000);
  assert.equal(r.body.order.status, 'fulfilled'); assert.equal(r.body.order.refunded_qty, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM passes WHERE order_id = ? AND status = 'active'").get(o.order.id).n, 2);
  assert.equal(sumLedger(o.order.id, 'gross'), 2100000);
  assert.equal(sumLedger(o.order.id, 'gross'), sumLedger(o.order.id, 'organiser_payable') + sumLedger(o.order.id, 'commission'));
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`, { pass_ids: [ids[0]] })).status, 400); // already refunded
  const rest = await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`); // the remainder
  assert.equal(rest.body.refunded_kobo, 2100000); assert.equal(rest.body.order.status, 'refunded');
  for (const k of ['gross', 'organiser_payable', 'commission', 'processor_fee']) assert.equal(sumLedger(o.order.id, k), 0, k);
});
await test('uneven amounts still add up to exactly what was paid', async () => {
  const e = await mkEvent(333333);
  const o = await buy(e, 3);
  await pay(o, { processor_fee_kobo: 1001 });
  const total = o.order.total_kobo;
  const ids = db.prepare('SELECT id FROM passes WHERE order_id = ? ORDER BY order_seq').all(o.order.id).map((r) => r.id);
  const a = await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`, { pass_ids: [ids[0]] });
  const b = await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`, { pass_ids: [ids[1]] });
  const c = await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`);
  assert.equal(a.body.refunded_kobo + b.body.refunded_kobo + c.body.refunded_kobo, total);
  for (const k of ['gross', 'organiser_payable', 'commission', 'processor_fee']) assert.equal(sumLedger(o.order.id, k), 0, k);
});
await test('a used ticket cannot be refunded, but the unused ones can; bad ticket choices are refused', async () => {
  const e = await mkEvent();
  const o = await buy(e, 2); await pay(o);
  const ids = db.prepare('SELECT id FROM passes WHERE order_id = ? ORDER BY order_seq').all(o.order.id).map((r) => r.id);
  db.prepare("INSERT INTO scans (id, event_id, pass_id, zone_id, result, at) VALUES ('sp1', ?, ?, (SELECT id FROM zones WHERE event_id = ? LIMIT 1), 'granted', 1)").run(e.event.id, ids[0], e.event.id);
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`, { pass_ids: [ids[0]] })).body.error.code, 'already_used');
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`)).body.error.code, 'already_used');
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`, { pass_ids: ['nope'] })).status, 400);
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`, { pass_ids: [] })).status, 400);
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`, { pass_ids: [ids[1]] })).status, 200);
});

console.log('\nChargebacks');
await test('an open dispute blocks refunds; winning it frees the order', async () => {
  const e = await mkEvent();
  const o = await buy(e); await pay(o);
  assert.equal((await dispute(o, 'dispute.opened')).body.outcome, 'dispute_opened');
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`)).body.error.code, 'disputed');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM passes WHERE order_id = ? AND status = 'active'").get(o.order.id).n, 1); // tickets still work while open
  assert.equal((await dispute(o, 'dispute.won')).body.outcome, 'dispute_won');
  assert.equal(db.prepare('SELECT dispute_status FROM orders WHERE id = ?').get(o.order.id).dispute_status, 'won');
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`)).status, 200);
});
await test('losing a dispute cancels the tickets and reverses the books without asking the provider to refund', async () => {
  const e = await mkEvent();
  const o = await buy(e, 2); await pay(o);
  env.MOCK_REFUND_FAIL = '1'; // proves the provider refund is not called
  await dispute(o, 'dispute.opened');
  assert.equal((await dispute(o, 'dispute.lost')).body.outcome, 'dispute_lost');
  delete env.MOCK_REFUND_FAIL;
  const row = db.prepare('SELECT status, dispute_status, refunded_kobo, total_kobo FROM orders WHERE id = ?').get(o.order.id);
  assert.equal(row.status, 'refunded'); assert.equal(row.dispute_status, 'lost'); assert.equal(row.refunded_kobo, row.total_kobo);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM passes WHERE order_id = ? AND status = 'active'").get(o.order.id).n, 0);
  for (const k of ['gross', 'organiser_payable', 'commission']) assert.equal(sumLedger(o.order.id, k), 0, k);
  assert.equal((await dispute(o, 'dispute.lost')).status, 200); // a replay does nothing more
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_ledger WHERE order_id = ? AND reason = 'refund'").get(o.order.id).n, 4);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
