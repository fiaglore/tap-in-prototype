// Signing in on the phone app: the emailed link opens in the browser, which leaves a note the app collects.
// Run with: node test/applogin.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { makeEnv, client } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}

// Google's endpoints are stubbed; nothing real is sent. Each code confirms the email it is named after.
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://identitytoolkit.googleapis.com/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  if (u.includes(':sendOobCode')) { sent.push(body); return new Response('{}', { status: 200 }); }
  const m = /^CODE-(.+)$/.exec(body.oobCode || '');
  if (m) return new Response(JSON.stringify({ email: m[1] + '@example.com' }), { status: 200 });
  return new Response(JSON.stringify({ error: { message: 'INVALID_OOB_CODE' } }), { status: 400 });
};

const env = makeEnv({ OTP_MODE: 'firebase', FIREBASE_API_KEY: 'test-key' });
const b64u = (buf) => Buffer.from(buf).toString('base64url');
// What the app does: a random secret, and its SHA-256 as the challenge.
const newPair = () => { const verifier = b64u(randomBytes(32)); return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }; };
let ipn = 0;
const fresh = () => client(env, '10.20.' + Math.floor(ipn / 250) + '.' + (ipn++ % 250 + 1));
const rows = async () => (await env.DB.prepare('SELECT * FROM app_logins').all()).results;

console.log('\nAsking for the link from the app');
await test('the challenge rides in the emailed link, and a link asked for from a browser is unchanged', async () => {
  const { challenge } = newPair();
  const app = fresh();
  assert.equal((await app.post('/api/auth/otp/request', { identifier: 'ada@example.com', app_challenge: challenge })).status, 200);
  assert.equal(sent.at(-1).continueUrl, 'https://tapin.test/signin/?ac=' + challenge);
  assert.equal((await fresh().post('/api/auth/otp/request', { identifier: 'ada@example.com' })).status, 200);
  assert.equal(sent.at(-1).continueUrl, 'https://tapin.test/signin/');
});
await test('a malformed challenge is refused, not ignored', async () => {
  for (const bad of ['short', 'x'.repeat(44), 'has spaces and symbols !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!', 12345, {}]) {
    const r = await fresh().post('/api/auth/otp/request', { identifier: 'ada@example.com', app_challenge: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.error.code, 'invalid_app_challenge');
  }
});

console.log('\nThe browser completes the link');
await test('with a challenge it signs the browser in and leaves one note; the note holds only a hash', async () => {
  const { challenge } = newPair();
  const browser = fresh();
  const r = await browser.post('/api/auth/email-link/complete', { email: 'bola@example.com', oobCode: 'CODE-bola', app_challenge: challenge });
  assert.equal(r.status, 200); assert.equal(r.body.app_handoff, true);
  assert.equal((await browser.get('/api/me')).status, 200);
  const all = await rows();
  assert.equal(all.length, 1);
  assert.notEqual(all[0].challenge_hash, challenge);
  assert.ok(!JSON.stringify(all).includes(challenge), 'the challenge itself must not be stored');
  assert.equal(all[0].expires_at - all[0].created_at, 600);
});
await test('without a challenge there is no note and no hand-off flag', async () => {
  const before = (await rows()).length;
  const r = await fresh().post('/api/auth/email-link/complete', { email: 'chi@example.com', oobCode: 'CODE-chi' });
  assert.equal(r.status, 200); assert.equal(r.body.app_handoff, undefined);
  assert.equal((await rows()).length, before);
});
await test('a link for a different email, or a bad code, leaves no note', async () => {
  const before = (await rows()).length;
  const { challenge } = newPair();
  const a = await fresh().post('/api/auth/email-link/complete', { email: 'dee@example.com', oobCode: 'CODE-someone', app_challenge: challenge });
  assert.equal(a.status, 400); assert.equal(a.body.error.code, 'email_mismatch');
  const b = await fresh().post('/api/auth/email-link/complete', { email: 'dee@example.com', oobCode: 'NOPE', app_challenge: challenge });
  assert.equal(b.status, 400);
  assert.equal((await rows()).length, before);
});

console.log('\nThe app collects it');
await test('the whole trip: not yet, then signed in as the same person with its own session, once only', async () => {
  const { verifier, challenge } = newPair();
  const app = fresh(), browser = fresh();
  await app.post('/api/auth/otp/request', { identifier: 'eze@example.com', app_challenge: challenge });
  const early = await app.post('/api/auth/app/redeem', { verifier });
  assert.equal(early.status, 200); assert.deepEqual(early.body, { pending: true }); assert.equal(early.setCookie, null);
  assert.equal((await app.get('/api/me')).status, 401);
  const done = await browser.post('/api/auth/email-link/complete', { email: 'eze@example.com', oobCode: 'CODE-eze', app_challenge: challenge });
  const got = await app.post('/api/auth/app/redeem', { verifier });
  assert.equal(got.status, 200);
  assert.equal(got.body.user.id, done.body.user.id);
  assert.equal(got.body.is_new, true, 'a first-time person still needs to give a name');
  assert.match(got.setCookie, /tapin_session=/);
  assert.equal((await app.get('/api/me')).body.user.id, done.body.user.id);
  const sessions = (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1').bind(done.body.user.id).first()).n;
  assert.equal(sessions, 2, 'the browser and the app each have their own session');
  assert.deepEqual((await app.post('/api/auth/app/redeem', { verifier })).body, { pending: true }, 'works once');
  assert.deepEqual((await fresh().post('/api/auth/app/redeem', { verifier })).body, { pending: true }, 'and not for anyone else afterwards');
  // signing out in the app does not sign the browser out
  await app.post('/api/auth/logout');
  assert.equal((await app.get('/api/me')).status, 401);
  assert.equal((await browser.get('/api/me')).status, 200);
});
await test('someone who saw the challenge (it is in the emailed link) cannot collect the note without the secret', async () => {
  const { verifier, challenge } = newPair();
  await fresh().post('/api/auth/email-link/complete', { email: 'fay@example.com', oobCode: 'CODE-fay', app_challenge: challenge });
  const thief = fresh();
  assert.deepEqual((await thief.post('/api/auth/app/redeem', { verifier: challenge })).body, { pending: true });
  assert.deepEqual((await thief.post('/api/auth/app/redeem', { verifier: newPair().verifier })).body, { pending: true });
  assert.equal((await thief.get('/api/me')).status, 401);
  assert.equal((await fresh().post('/api/auth/app/redeem', { verifier })).status, 200, 'the real app still can');
});
await test('an expired note cannot be collected', async () => {
  const { verifier, challenge } = newPair();
  await fresh().post('/api/auth/email-link/complete', { email: 'gus@example.com', oobCode: 'CODE-gus', app_challenge: challenge });
  await env.DB.prepare('UPDATE app_logins SET expires_at = ?1 WHERE user_id = (SELECT id FROM users WHERE email = ?2)').bind(Math.floor(Date.now() / 1000) - 1, 'gus@example.com').run();
  assert.deepEqual((await fresh().post('/api/auth/app/redeem', { verifier })).body, { pending: true });
});
await test('a malformed verifier is refused', async () => {
  for (const bad of [undefined, '', 'short', 'x'.repeat(44), 7]) {
    const r = await fresh().post('/api/auth/app/redeem', { verifier: bad });
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.body.error.code, 'invalid_verifier');
  }
});
await test('two collectors at once: only one gets in', async () => {
  const { verifier, challenge } = newPair();
  await fresh().post('/api/auth/email-link/complete', { email: 'hal@example.com', oobCode: 'CODE-hal', app_challenge: challenge });
  const results = await Promise.all([fresh(), fresh(), fresh()].map((c) => c.post('/api/auth/app/redeem', { verifier })));
  assert.equal(results.filter((r) => r.body.user).length, 1);
});

console.log('\nNobody can take over a note');
await test('while a note is valid, a second sign-in with the same challenge does not replace it', async () => {
  const { verifier, challenge } = newPair();
  const first = await fresh().post('/api/auth/email-link/complete', { email: 'ida@example.com', oobCode: 'CODE-ida', app_challenge: challenge });
  const other = await fresh().post('/api/auth/email-link/complete', { email: 'jon@example.com', oobCode: 'CODE-jon', app_challenge: challenge });
  assert.equal(other.status, 200);
  const got = await fresh().post('/api/auth/app/redeem', { verifier });
  assert.equal(got.body.user.id, first.body.user.id, 'the app signs in as whoever asked first');
});
await test('once a note has expired, a retry with the same challenge works', async () => {
  const { verifier, challenge } = newPair();
  await fresh().post('/api/auth/email-link/complete', { email: 'kim@example.com', oobCode: 'CODE-kim', app_challenge: challenge });
  await env.DB.prepare('UPDATE app_logins SET expires_at = ?1').bind(Math.floor(Date.now() / 1000) - 5).run();
  await fresh().post('/api/auth/email-link/complete', { email: 'kim@example.com', oobCode: 'CODE-kim', app_challenge: challenge });
  assert.equal((await fresh().post('/api/auth/app/redeem', { verifier })).status, 200);
});
await test('the daily clean-up removes old notes', async () => {
  const { purge } = await import('../src/index.js');
  await env.DB.prepare('UPDATE app_logins SET expires_at = ?1').bind(Math.floor(Date.now() / 1000) - 2 * 86400).run();
  await purge(env);
  assert.equal((await rows()).length, 0);
});
await test('demo mode is untouched: the code flow still works and the challenge is ignored by it', async () => {
  const demo = makeEnv();
  const c = client(demo, '10.99.0.1');
  const { challenge } = newPair();
  const r = await c.post('/api/auth/otp/request', { identifier: 'zed@example.com', app_challenge: challenge });
  assert.equal(r.status, 200); assert.ok(r.body.dev_code);
  assert.equal((await c.post('/api/auth/otp/verify', { identifier: 'zed@example.com', code: r.body.dev_code })).status, 200);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
