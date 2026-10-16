// Phase 3 tests: Tap In payments for customers and vendors.
// Run with: node test/payments.mjs
import assert from 'node:assert/strict';
import { PEPPER, client, makeEnv, signIn } from './harness.mjs';
import { makePayCode } from '../src/lib/codes.js';

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
const naira = (n) => n * 100;

const env = makeEnv();
const now = () => Math.floor(Date.now() / 1000);
let ada, bola, owner, stranger, adaId, vendor, tillKey;
const till = (key = tillKey, ip = '10.30.9.1') => ({ headers: { Authorization: 'Bearer ' + key, 'CF-Connecting-IP': ip } });
const charge = (code, key = tillKey, ip) => client(env, ip || '10.30.9.1').post('/api/till/charge', { code }, till(key, ip));
const balance = async (c) => (await c.get('/api/wallet')).body.balance_kobo;
const vendorBalance = async () => (await owner.get('/api/vendors/' + vendor.id)).body.vendor.balance_kobo;
const payCode = async (c, amount) => (await c.post('/api/wallet/pay-code', { amount_kobo: amount })).body.code;
const ledgerCount = (kind) => env.DB.raw.prepare('SELECT COUNT(*) AS n FROM ledger WHERE kind = ?').get(kind).n;

group('Wallet');
await test('a new wallet is empty, and demo top-ups add to it', async () => {
  ada = await signIn(env, 'ada@example.com', '10.30.0.1', 'Ada Okafor');
  adaId = (await ada.get('/api/me')).body.user.id;
  const w = await ada.get('/api/wallet');
  assert.equal(w.status, 200);
  assert.equal(w.body.balance_kobo, 0);
  assert.equal(w.body.mode, 'demo');
  const t = await ada.post('/api/wallet/topup', { amount_kobo: naira(5000) });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.balance_kobo, naira(5000));
  assert.equal(t.body.entries[0].kind, 'topup');
});
await test('the wallet needs a signed-in user', async () => {
  assert.equal((await client(env, '10.30.0.9').get('/api/wallet')).status, 401);
});
await test('bad amounts are refused: zero, negative, fractions, text, too large', async () => {
  for (const bad of [0, -5, 1.5, 'abc', null, naira(100_001), 1e15]) {
    const r = await ada.post('/api/wallet/topup', { amount_kobo: bad });
    assert.equal(r.status, 400, 'accepted ' + bad);
    assert.equal(r.body.error.code, 'invalid_amount');
  }
  assert.equal(await balance(ada), naira(5000));
});
await test('real top-ups are refused until a provider is connected (live mode)', async () => {
  const live = makeEnv({ PAYMENTS_MODE: 'live' });
  const c = await signIn(live, 'live@example.com', '10.30.0.2');
  const r = await c.post('/api/wallet/topup', { amount_kobo: 1000 });
  assert.equal(r.status, 501);
  assert.equal(r.body.error.code, 'payments_not_connected');
  assert.equal((await c.get('/api/wallet')).body.balance_kobo, 0);
});

group('Setting up a vendor');
await test('a business is created and gets a till key, shown once and never stored', async () => {
  owner = await signIn(env, 'mama@example.com', '10.30.0.3', 'Mama Put');
  const r = await owner.post('/api/vendors', { name: 'Mama Put Kitchen', category: 'Food' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  vendor = r.body.vendor;
  tillKey = r.body.till_key;
  assert.match(tillKey, /^TK-/);
  assert.equal(vendor.balance_kobo, 0);
  const dump = JSON.stringify(env.DB.raw.prepare('SELECT * FROM vendors').all());
  assert.ok(!dump.includes(tillKey), 'till key stored in the clear');
});
await test('the till rejects a wrong key', async () => {
  assert.equal((await client(env, '10.30.9.5').get('/api/till/info', till('TK-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA'))).status, 401);
  const ok = await client(env, '10.30.9.6').get('/api/till/info', till());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.vendor.name, 'Mama Put Kitchen');
});
await test('only the owner can see a business', async () => {
  stranger = await signIn(env, 'nosy@example.com', '10.30.0.4');
  assert.equal((await stranger.get('/api/vendors/' + vendor.id)).status, 404);
  assert.equal((await stranger.post(`/api/vendors/${vendor.id}/payout`, { amount_kobo: 100 })).status, 404);
  assert.equal((await stranger.get('/api/vendors')).body.vendors.length, 0);
});

group('Paying at the till');
let firstPayment;
await test('a pay code moves exactly the signed amount from the wallet to the vendor', async () => {
  const code = await payCode(ada, naira(1200));
  const r = await charge(code);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, 'paid');
  assert.equal(r.body.amount_kobo, naira(1200));
  assert.equal(r.body.customer, 'Ada O.');
  assert.ok(!('balance_kobo' in r.body), 'the till must not learn the wallet balance');
  firstPayment = r.body.payment_id;
  assert.equal(await balance(ada), naira(3800));
  assert.equal(await vendorBalance(), naira(1200));
});
await test('the same code cannot be charged twice', async () => {
  const code = await payCode(ada, naira(100));
  assert.equal((await charge(code)).body.result, 'paid');
  const again = await charge(code);
  assert.equal(again.body.result, 'declined');
  assert.equal(again.body.reason, 'already_used');
  assert.equal(await balance(ada), naira(3700));
});
await test('two codes for the same amount in the same minute are both good', async () => {
  const a = await payCode(ada, naira(50));
  const b = await payCode(ada, naira(50));
  assert.notEqual(a, b);
  assert.equal((await charge(a)).body.result, 'paid');
  assert.equal((await charge(b)).body.result, 'paid');
  assert.equal(await balance(ada), naira(3600));
});
await test('a tampered amount, a forged code and a mangled code are all rejected', async () => {
  const before = await balance(ada);
  const code = await payCode(ada, naira(10));
  const raw = code.replace(/-/g, ''); // TPAY + user(12) + amount(6) + window(6) + nonce(4) + mac(10)
  const amountAt = 4 + 12;
  const bigger = raw.slice(0, amountAt) + '0000ZZ' + raw.slice(amountAt + 6); // someone edits the amount
  const wrongUser = raw.slice(0, 4) + 'A'.repeat(12) + raw.slice(16);
  const flipped = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
  for (const c of ['TPAY-' + 'A'.repeat(38), 'TPAY-123', '', 'hello', flipped, bigger, wrongUser]) {
    assert.equal((await charge(c)).body.reason, 'invalid_code', 'accepted ' + c);
  }
  assert.equal(await balance(ada), before);
  assert.equal((await charge(code)).body.result, 'paid'); // the untouched code still works
  assert.equal(await balance(ada), before - naira(10));
});
await test('an old code has expired', async () => {
  const code = await makePayCode(PEPPER, adaId, naira(10), now() - 3600);
  assert.equal((await charge(code)).body.reason, 'expired');
});
await test('not enough money: declined, nothing moves, no payment is recorded', async () => {
  const before = { w: await balance(ada), v: await vendorBalance(), n: ledgerCount('payment') };
  const code = await payCode(ada, naira(4000)); // wallet holds 3600
  const r = await charge(code);
  assert.equal(r.body.result, 'declined');
  assert.equal(r.body.reason, 'insufficient_funds');
  assert.deepEqual({ w: await balance(ada), v: await vendorBalance(), n: ledgerCount('payment') }, before);
  // after topping up, the very same code works (it was never used up)
  await ada.post('/api/wallet/topup', { amount_kobo: naira(1000) });
  assert.equal((await charge(code)).body.result, 'paid');
});
await test('two payments racing for the last of the money: exactly one wins', async () => {
  bola = await signIn(env, 'bola@example.com', '10.30.0.5', 'Bola Ade');
  await bola.post('/api/wallet/topup', { amount_kobo: naira(1000) });
  const [c1, c2] = [await payCode(bola, naira(800)), await payCode(bola, naira(800))];
  const [r1, r2] = await Promise.all([charge(c1, tillKey, '10.30.9.2'), charge(c2, tillKey, '10.30.9.3')]);
  const results = [r1.body.result, r2.body.result].sort();
  assert.deepEqual(results, ['declined', 'paid']);
  assert.equal(await balance(bola), naira(200));
});
await test('a rotated till key locks out the old one at once', async () => {
  const rot = await owner.post(`/api/vendors/${vendor.id}/till-key`);
  assert.equal(rot.status, 200);
  const code = await payCode(ada, naira(5));
  assert.equal((await charge(code, tillKey, '10.30.9.7')).status, 401);
  tillKey = rot.body.till_key;
  assert.equal((await charge(code)).body.result, 'paid');
});
await test('money is conserved: wallets + vendor balances + payouts = top-ups', async () => {
  const q = (sql) => env.DB.raw.prepare(sql).get().n ?? 0;
  const wallets = q('SELECT COALESCE(SUM(balance_kobo),0) AS n FROM wallets');
  const vendors = q('SELECT COALESCE(SUM(balance_kobo),0) AS n FROM vendors');
  const topups = q("SELECT COALESCE(SUM(amount_kobo),0) AS n FROM ledger WHERE kind='topup'");
  const payouts = q("SELECT COALESCE(SUM(amount_kobo),0) AS n FROM ledger WHERE kind='payout'");
  assert.equal(wallets + vendors + payouts, topups);
});

group('Refunds and payouts');
await test('the vendor can refund a payment once, and the customer gets the money back', async () => {
  const before = await balance(ada);
  const r = await owner.post(`/api/vendors/${vendor.id}/refunds`, { payment_id: firstPayment });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await balance(ada), before + naira(1200));
  const again = await owner.post(`/api/vendors/${vendor.id}/refunds`, { payment_id: firstPayment });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_refunded');
  assert.equal(await balance(ada), before + naira(1200));
});
await test('someone else cannot refund, and a refund needs a real payment', async () => {
  assert.equal((await stranger.post(`/api/vendors/${vendor.id}/refunds`, { payment_id: firstPayment })).status, 404);
  assert.equal((await owner.post(`/api/vendors/${vendor.id}/refunds`, { payment_id: 'nope' })).status, 404);
});
await test('a payout cannot exceed the balance, and a refund cannot overdraw the vendor', async () => {
  const bal = await vendorBalance();
  const tooMuch = await owner.post(`/api/vendors/${vendor.id}/payout`, { amount_kobo: bal + 1 });
  assert.equal(tooMuch.status, 409);
  assert.equal(await vendorBalance(), bal);
  const p = await owner.post(`/api/vendors/${vendor.id}/payout`, { amount_kobo: bal });
  assert.equal(p.status, 201);
  assert.equal(p.body.vendor.balance_kobo, 0);
  const pay = env.DB.raw.prepare("SELECT id FROM ledger WHERE kind='payment' AND vendor_id=? AND id NOT IN (SELECT refund_of FROM ledger WHERE refund_of IS NOT NULL) LIMIT 1").get(vendor.id);
  const r = await owner.post(`/api/vendors/${vendor.id}/refunds`, { payment_id: pay.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'balance_too_low');
});
await test('real payouts are refused in live mode', async () => {
  const live = makeEnv({ PAYMENTS_MODE: 'live' });
  const c = await signIn(live, 'v@example.com', '10.30.0.6');
  const v = (await c.post('/api/vendors', { name: 'Live Shop' })).body.vendor;
  const r = await c.post(`/api/vendors/${v.id}/payout`, { amount_kobo: 100 });
  assert.equal(r.status, 501);
});
await test('the business page shows sales, refunds and totals', async () => {
  const r = await owner.get('/api/vendors/' + vendor.id);
  assert.ok(r.body.totals.taken > 0 && r.body.totals.refunded === naira(1200) && r.body.totals.paid_out > 0);
  assert.ok(r.body.entries.some((e) => e.kind === 'payment' && e.refunded));
  assert.ok(r.body.entries.every((e) => !e.customer || !e.customer.includes(' ')), 'only first names reach the vendor');
});

group('Tap In enabled');
await test('businesses are listed publicly unless they opt out, and the list shows no money or keys', async () => {
  let list = (await client(env, '10.30.8.1').get('/api/public/vendors')).body.vendors;
  assert.deepEqual(list, [{ name: 'Mama Put Kitchen', category: 'Food' }]);
  assert.equal((await owner.call('PATCH', '/api/vendors/' + vendor.id, { body: { listed: false } })).status, 200);
  list = (await client(env, '10.30.8.1').get('/api/public/vendors')).body.vendors;
  assert.equal(list.length, 0);
});
await test('a user can run up to five businesses', async () => {
  const c = await signIn(env, 'many@example.com', '10.30.0.7');
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/vendors', { name: 'Shop ' + i })).status, 201);
  assert.equal((await c.post('/api/vendors', { name: 'One too many' })).status, 400);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed: ' + failures.join('; '));
  process.exit(1);
}
