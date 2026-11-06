// The app and the organiser console are separate sign-ins. Run with: node test/console-session.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const env = makeEnv();
const CON = { headers: { 'X-Tap-In-Area': 'console' } };
const meApp = (c) => c.get('/api/me');
const meCon = (c) => c.get('/api/me', CON);
// Sign in to the console as `identifier` on an existing browser (cookie jar).
async function consoleSignIn(c, identifier) {
  const r = await c.post('/api/auth/otp/request', { identifier }, CON);
  const v = await c.post('/api/auth/otp/verify', { identifier, code: r.body.dev_code }, CON);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body.user;
}

await test('signing in to the app does not sign you in to the console', async () => {
  const c = await signIn(env, 'a1@example.com', '10.120.0.1', 'App One');
  assert.equal((await meApp(c)).status, 200);
  assert.equal((await meCon(c)).status, 401);
  assert.equal((await c.get('/api/events', CON)).status, 401);
  assert.deepEqual(Object.keys(c.cookies()), ['tapin_session']);
});
await test('signing in to the console does not sign you in to the app', async () => {
  const c = client(env, '10.120.0.2');
  await consoleSignIn(c, 'a2@example.com');
  assert.equal((await meCon(c)).status, 200);
  assert.equal((await meApp(c)).status, 401);
  assert.deepEqual(Object.keys(c.cookies()), ['tapin_console']);
});
await test('an app user can choose to link the same account to the console, and only then', async () => {
  const c = await signIn(env, 'a3@example.com', '10.120.0.3', 'Linker');
  assert.equal((await meCon(c)).status, 401);
  const r = await c.post('/api/auth/console/link', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.email, 'a3@example.com');
  assert.equal((await meCon(c)).body.user.email, 'a3@example.com');
  assert.equal((await c.post('/api/events', { name: 'Linked Fest', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }] }, CON)).status, 201);
});
await test('linking needs an app sign-in; a console-only sign-in cannot link, and nobody can link someone else', async () => {
  const none = client(env, '10.120.0.4');
  assert.equal((await none.post('/api/auth/console/link', {})).status, 401);
  const consoleOnly = client(env, '10.120.0.5');
  await consoleSignIn(consoleOnly, 'a5@example.com');
  assert.equal((await consoleOnly.post('/api/auth/console/link', {})).status, 401);
  assert.equal((await consoleOnly.post('/api/auth/console/link', {}, CON)).status, 401); // the header does not change which session is read
});
await test('a different email can be used for the console while the app stays signed in as the first', async () => {
  const c = await signIn(env, 'person@example.com', '10.120.0.6', 'Pass Holder');
  const other = await consoleSignIn(c, 'work@example.com');
  assert.equal(other.email, 'work@example.com');
  assert.equal((await meApp(c)).body.user.email, 'person@example.com');
  assert.equal((await meCon(c)).body.user.email, 'work@example.com');
  assert.deepEqual(Object.keys(c.cookies()).sort(), ['tapin_console', 'tapin_session']);
  // the work account's events are not visible from the personal account and vice versa
  await c.post('/api/events', { name: 'Work Event', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }] }, CON);
  assert.equal((await c.get('/api/events', CON)).body.events.length, 1);
  assert.equal((await c.get('/api/events')).body.events.length, 0);
});
await test('signing out of one does not sign you out of the other', async () => {
  const c = await signIn(env, 'b1@example.com', '10.120.0.7', 'B One');
  await c.post('/api/auth/console/link', {});
  await c.post('/api/auth/logout', {}, CON);
  assert.equal((await meCon(c)).status, 401);
  assert.equal((await meApp(c)).status, 200);
  await c.post('/api/auth/console/link', {});
  await c.post('/api/auth/logout', {});
  assert.equal((await meApp(c)).status, 401);
  assert.equal((await meCon(c)).status, 200);
});
await test('a cookie from one area does not work as the other area\'s cookie', async () => {
  const c = await signIn(env, 'c1@example.com', '10.120.0.8', 'C One');
  const appToken = c.cookies().tapin_session;
  const sneaky = client(env, '10.120.0.9');
  const r = await sneaky.get('/api/me', { headers: { 'X-Tap-In-Area': 'console', Cookie: 'tapin_console=' + appToken } });
  assert.equal(r.status, 401);
  const r2 = await sneaky.get('/api/me', { headers: { Cookie: 'tapin_session=' + appToken } });
  assert.equal(r2.status, 200);
});
await test('linking makes a separate console session and leaves the app session alone', async () => {
  const c = await signIn(env, 'd1@example.com', '10.120.0.10', 'D One');
  await c.post('/api/auth/console/link', {});
  const rows = env.DB.raw.prepare("SELECT scope FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'd1@example.com' ORDER BY scope").all();
  assert.deepEqual(rows.map((r) => r.scope), ['app', 'console']);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
