// Two-step sign-in. Run with: node test/mfa.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';
import { currentStep, matchTotp, openSecret, totp } from '../src/lib/mfa.js';
import { hmacHex } from '../src/lib/util.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}

// Firebase stubbed, as in the admin tests, so staff sign-in counts as verified.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://identitytoolkit.googleapis.com/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  return /^CODE-/.test(body.oobCode || '') ? new Response(JSON.stringify({ email: body.email }), { status: 200 }) : new Response(JSON.stringify({ error: { message: 'INVALID_OOB_CODE' } }), { status: 400 });
};
const SECRET = 'webhook-secret-0123456789';
const env = makeEnv({ OTP_MODE: 'firebase', FIREBASE_API_KEY: 'k', STAFF_IDENTIFIERS: 'staff@tap-in.test', TICKET_CHECKOUT: 'mock', PAYMENT_WEBHOOK_SECRET: SECRET, PLATFORM_COMMISSION_BPS: '500' });
const db = env.DB.raw;
let n = 0;
const fb = async (email) => { const c = client(env, '10.90.0.' + (++n)); const r = await c.post('/api/auth/email-link/complete', { email, oobCode: 'CODE-x' }); assert.equal(r.status, 200, JSON.stringify(r.body)); return c; };
const codeFor = async (userEmail, offset = 0) => { const u = db.prepare('SELECT mfa_secret FROM users WHERE email = ?').get(userEmail); return totp(await openSecret(env, u.mfa_secret), currentStep() + offset); };
const enrol = async (c, email) => { const s = await c.post('/api/me/mfa/setup'); assert.equal(s.status, 200); const e = await c.post('/api/me/mfa/enable', { code: await codeFor(email) }); assert.equal(e.status, 201, JSON.stringify(e.body)); return { secret: s.body.secret, recovery: e.body.recovery_codes }; };

console.log('\nTOTP');
await test('matches the RFC 6238 test vector and tolerates one step of clock drift only', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(await totp(secret, Math.floor(59 / 30)), '287082');
  assert.equal(await matchTotp(secret, '287082', 59), 1);
  assert.equal(await matchTotp(secret, '287082', 59 + 30), 1);
  assert.equal(await matchTotp(secret, '287082', 59 + 120), null);
  assert.equal(await matchTotp(secret, 'abcdef', 59), null);
});

console.log('\nEnrolment');
await test('setup returns a scannable secret that is stored encrypted, not in the clear', async () => {
  const c = await fb('a@example.com');
  const s = await c.post('/api/me/mfa/setup');
  assert.match(s.body.secret, /^[A-Z2-7]{32}$/);
  assert.match(s.body.otpauth_uri, /^otpauth:\/\/totp\/.+secret=/);
  const stored = db.prepare('SELECT mfa_secret FROM users WHERE email = ?').get('a@example.com').mfa_secret;
  assert.ok(!stored.includes(s.body.secret));
  assert.equal((await c.get('/api/me/mfa')).body.enabled, false);
});
await test('enabling needs a correct code; it then returns 8 recovery codes once and stores only hashes', async () => {
  const c = await fb('b@example.com');
  await c.post('/api/me/mfa/setup');
  assert.equal((await c.post('/api/me/mfa/enable', { code: '000000' })).status, 400);
  const r = await enrol2(c, 'b@example.com');
  assert.equal(r.length, 8);
  const stored = db.prepare('SELECT mfa_recovery FROM users WHERE email = ?').get('b@example.com').mfa_recovery;
  for (const code of r) assert.ok(!stored.includes(code.replace('-', '')));
  assert.equal((await c.get('/api/me/mfa')).body.recovery_codes_left, 8);
});
async function enrol2(c, email) { const e = await c.post('/api/me/mfa/enable', { code: await codeFor(email) }); assert.equal(e.status, 201, JSON.stringify(e.body)); return e.body.recovery_codes; }

console.log('\nUsing it');
await test('a used code cannot be replayed; a recovery code works once', async () => {
  const c = await fb('c@example.com');
  const { recovery } = await enrol(c, 'c@example.com');
  const c2 = await fb('c@example.com'); // a fresh sign-in is not second-step verified yet
  const next = await codeFor('c@example.com', 1);
  assert.equal((await c2.post('/api/me/mfa/verify', { code: next })).status, 200);
  assert.equal((await c2.post('/api/me/mfa/verify', { code: next })).body.error.code, 'code_used');
  const c3 = await fb('c@example.com');
  assert.equal((await c3.post('/api/me/mfa/verify', { code: recovery[0] })).body.used, 'recovery');
  const c4 = await fb('c@example.com');
  assert.equal((await c4.post('/api/me/mfa/verify', { code: recovery[0] })).status, 400);
  assert.equal((await c4.get('/api/me/mfa')).body.recovery_codes_left, 7);
});
await test('guessing is limited', async () => {
  const c = await fb('d@example.com');
  await enrol(c, 'd@example.com');
  const c2 = await fb('d@example.com');
  let last;
  for (let i = 0; i < 10; i++) last = await c2.post('/api/me/mfa/verify', { code: '1234' + String(i).padStart(2, '0') });
  assert.equal(last.status, 429);
});
await test('turning it off needs a valid code', async () => {
  const c = await fb('e@example.com');
  await enrol(c, 'e@example.com');
  assert.equal((await c.post('/api/me/mfa/disable', { code: '000000' })).status, 400);
  assert.equal((await c.post('/api/me/mfa/disable', { code: await codeFor('e@example.com', 1) })).body.enabled, false);
  assert.equal((await c.get('/api/me/mfa')).body.enabled, false);
});

console.log('\nStaff console');
await test('staff without two-step get a clear refusal; with it they get in; non-staff still see "not found"', async () => {
  const s = await fb('staff@tap-in.test');
  const r0 = await s.get('/api/admin/me');
  assert.equal(r0.status, 403); assert.equal(r0.body.error.code, 'mfa_setup_required');
  await enrol(s, 'staff@tap-in.test');
  assert.equal((await s.get('/api/admin/me')).status, 200);
  const s2 = await fb('staff@tap-in.test'); // new sign-in: must pass the second step again
  assert.equal((await s2.get('/api/admin/me')).body.error.code, 'mfa_required');
  assert.equal((await s2.post('/api/me/mfa/verify', { code: await codeFor('staff@tap-in.test', 1) })).status, 200);
  assert.equal((await s2.get('/api/admin/me')).status, 200);
  const other = await fb('nobody@example.com');
  assert.equal((await other.get('/api/admin/me')).status, 404);
});

console.log('\nOrganiser refunds');
await test('an organiser who turned it on must verify before refunding; one who did not can (unless it is mandatory)', async () => {
  const org = await fb('org@example.com');
  const e = (await org.post('/api/events', { name: 'Sec Fest', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'], price_kobo: 500000 }] })).body;
  const buyer = await fb('buyer@example.com');
  const o = (await buyer.post(`/api/public/events/${e.event.id}/checkout`, { tier_id: e.tiers[0].id })).body;
  const ref = db.prepare('SELECT provider_ref, total_kobo FROM orders WHERE id = ?').get(o.order.id);
  const raw = JSON.stringify({ id: 'x1', type: 'charge.success', ref: ref.provider_ref, amount_kobo: ref.total_kobo, currency: 'NGN' });
  await client(env, '10.99.0.1').call('POST', '/api/webhooks/payments/mock', { body: raw, raw: true, headers: { 'Content-Type': 'application/json', 'x-mock-signature': await hmacHex(SECRET, raw) } });
  await enrol(org, 'org@example.com');
  const later = await fb('org@example.com');
  assert.equal((await later.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`)).body.error.code, 'mfa_required');
  assert.equal((await later.post('/api/me/mfa/verify', { code: await codeFor('org@example.com', 1) })).status, 200);
  assert.equal((await later.post(`/api/events/${e.event.id}/orders/${o.order.id}/refund`)).status, 200);
});
await test('when mandatory, an organiser with no two-step cannot refund', async () => {
  const strict = makeEnv({ TICKET_CHECKOUT: 'mock', PAYMENT_WEBHOOK_SECRET: SECRET, PLATFORM_COMMISSION_BPS: '0', REQUIRE_ORGANISER_MFA: '1' });
  const org = await signIn(strict, 'o@example.com', '10.98.0.1', 'O');
  const e = (await org.post('/api/events', { name: 'Strict Fest', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'], price_kobo: 500000 }] })).body;
  assert.equal((await org.post(`/api/events/${e.event.id}/orders/nope/refund`)).body.error.code, 'mfa_setup_required');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
