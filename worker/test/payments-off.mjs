// PAYMENTS_MODE "off": the wallet, vendors and tills are withdrawn until a licensed partner is signed.
// Run with: node test/payments-off.mjs
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { client, makeEnv, signIn } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const fetched = [];
const env = makeEnv({
  PAYMENTS_MODE: 'off',
  ASSETS: { fetch: async (req) => { fetched.push(new URL(req.url).pathname); return new Response('asset', { status: 200 }); } }
});
const user = await signIn(env, 'guest@off.test', '10.70.0.1', 'Gee');
const page = async (path) => { fetched.length = 0; await worker.fetch(new Request('https://tapin.test' + path), env, {}); return fetched[0]; };

await test('config tells the app that payments are off', async () => {
  const r = await client(env, '10.70.0.2').get('/api/config');
  assert.equal(r.body.payments, false);
});
await test('every wallet, vendor and till route answers 404 payments_unavailable', async () => {
  for (const [m, p] of [['GET', '/api/wallet'], ['POST', '/api/wallet/topup'], ['POST', '/api/wallet/pay-code'], ['GET', '/api/vendors'], ['POST', '/api/vendors'], ['GET', '/api/till/info'], ['POST', '/api/till/charge'], ['GET', '/api/public/vendors']]) {
    const r = await user.call(m, p, m === 'POST' ? { body: {} } : {});
    assert.equal(r.status, 404, m + ' ' + p);
    assert.equal(r.body.error.code, 'payments_unavailable', m + ' ' + p);
  }
});
await test('ticketing still works: an organiser can create an event', async () => {
  const r = await user.post('/api/events', { name: 'Still on', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'] }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});
await test('the vendor and till pages are served as missing pages; other pages are untouched', async () => {
  for (const p of ['/vendor/', '/vendor', '/till/', '/till/index.html']) assert.equal(await page(p), '/__payments_off__', p);
  for (const p of ['/', '/play/', '/business/', '/js/vendor/qrcode.js', '/vendors-guide']) assert.equal(await page(p), p, p);
});
await test('with payments on (demo) the wallet still answers', async () => {
  const env2 = makeEnv();
  const u = await signIn(env2, 'guest@on.test', '10.70.0.9', 'On');
  assert.equal((await u.get('/api/wallet')).status, 200);
  assert.equal((await client(env2, '10.70.0.8').get('/api/config')).body.payments, true);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
