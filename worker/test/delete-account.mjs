// Deleting your own account from the phone app. Run with: node test/delete-account.mjs
import assert from 'node:assert/strict';
import { makeEnv, client, signIn } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}

const env = makeEnv();
const q = (sql, ...a) => env.DB.raw.prepare(sql).get(...a);
const org = await signIn(env, 'host@example.com', '10.60.0.1', 'Hope Host');
const mkEvent = async (name) => {
  const r = await org.post('/api/events', { name, zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 0 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const ev = await mkEvent('Delete Fest');
const inviteFor = async (c) => {
  const code = (await org.post(`/api/events/${ev.event.id}/invites`, { tier_id: ev.tiers[0].id, count: 1 })).body.codes[0];
  const r = await c.post('/api/claim', { code });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.pass;
};
const gate = (token) => client(env, '10.60.9.1').post('/api/gate/scan', { token, zone_id: ev.zones[0].id }, { headers: { Authorization: 'Bearer ' + ev.gate_key } });

console.log('\nDeleting an account');
await test('it needs the word DELETE, and it needs a signed-in person', async () => {
  const c = await signIn(env, 'sam@example.com', '10.60.1.1', 'Sam Stone');
  for (const body of [{}, { confirm: 'delete' }, { confirm: 'yes' }]) {
    const r = await c.call('DELETE', '/api/me', { body });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'confirm_required');
  }
  assert.equal((await c.get('/api/me')).status, 200, 'still signed in');
  assert.equal((await client(env, '10.60.1.2').call('DELETE', '/api/me', { body: { confirm: 'DELETE' } })).status, 401);
});
await test('it removes who they are, cancels their passes and signs them out', async () => {
  const c = await signIn(env, 'ola@example.com', '10.60.2.1', 'Ola Obi');
  const pass = await inviteFor(c);
  const uid = (await c.get('/api/me')).body.user.id;
  assert.equal((await gate(pass.token)).body.result, 'granted', 'the pass works before');
  const r = await c.call('DELETE', '/api/me', { body: { confirm: 'DELETE' } });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true });
  assert.match(r.setCookie, /Max-Age=0/);
  assert.equal((await c.get('/api/me')).status, 401);
  const row = q('SELECT email, phone, name FROM users WHERE id = ?', uid);
  assert.equal(row.email, 'deleted-' + uid + '@deleted.invalid'); assert.equal(row.phone, null); assert.equal(row.name, null);
  assert.equal(q('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', uid).n, 0);
  assert.equal(q("SELECT status FROM passes WHERE user_id = ?", uid).status, 'revoked');
  const after = await gate(pass.token);
  assert.notEqual(after.body.result, 'granted', 'the pass no longer opens the gate');
});
await test('the same email can sign up again as a new, empty account', async () => {
  const again = await signIn(env, 'ola@example.com', '10.60.2.2', 'Ola Again');
  const me = (await again.get('/api/me')).body;
  assert.equal(me.user.name, 'Ola Again'); assert.equal(me.passes.length, 0);
});
await test('an invite made for their email does not become open to anyone holding the code', async () => {
  const c = await signIn(env, 'tee@example.com', '10.60.3.1', 'Tee Tade');
  const code = (await org.post(`/api/events/${ev.event.id}/invites`, { tier_id: ev.tiers[0].id, count: 1 })).body.codes[0];
  const uid = (await c.get('/api/me')).body.user.id;
  env.DB.raw.prepare("UPDATE invites SET bound_identifier = 'tee@example.com' WHERE status = 'unused' AND code_hint = ?").run(code.slice(-4));
  await c.call('DELETE', '/api/me', { body: { confirm: 'DELETE' } });
  assert.equal(q("SELECT bound_identifier AS b FROM invites WHERE code_hint = ?", code.slice(-4)).b, 'deleted:' + uid);
  const stranger = await signIn(env, 'stranger@example.com', '10.60.3.2', 'Stranger');
  assert.notEqual((await stranger.post('/api/claim', { code })).status, 200, 'a stranger cannot claim it');
});
await test('their sign-in codes and app notes go too', async () => {
  const c = await signIn(env, 'uri@example.com', '10.60.4.1', 'Uri Udo');
  const uid = (await c.get('/api/me')).body.user.id;
  env.DB.raw.prepare("INSERT INTO app_logins (challenge_hash, user_id, created_at, expires_at) VALUES ('h', ?, 1, 9999999999)").run(uid);
  await client(env, '10.60.4.2').post('/api/auth/otp/request', { identifier: 'uri@example.com' });
  await c.call('DELETE', '/api/me', { body: { confirm: 'DELETE' } });
  assert.equal(q('SELECT COUNT(*) AS n FROM app_logins WHERE user_id = ?', uid).n, 0);
  assert.equal(q("SELECT COUNT(*) AS n FROM otps WHERE identifier = 'uri@example.com'").n, 0);
});

console.log('\nWho must settle things first');
await test('someone who runs events is asked to settle that first, and nothing is changed', async () => {
  const uid = (await org.get('/api/me')).body.user.id;
  const r = await org.call('DELETE', '/api/me', { body: { confirm: 'DELETE' } });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'runs_events');
  assert.equal((await org.get('/api/me')).status, 200, 'still signed in');
  assert.equal(q('SELECT name FROM users WHERE id = ?', uid).name, 'Hope Host');
});
await test('someone whose wallet still holds money is asked to settle that first', async () => {
  const c = await signIn(env, 'wal@example.com', '10.60.5.1', 'Wal Wole');
  const uid = (await c.get('/api/me')).body.user.id;
  env.DB.raw.prepare('INSERT INTO wallets (user_id, balance_kobo, updated_at) VALUES (?, 5000, 1)').run(uid);
  const r = await c.call('DELETE', '/api/me', { body: { confirm: 'DELETE' } });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'wallet_balance');
  assert.equal((await c.get('/api/me')).status, 200);
  env.DB.raw.prepare('UPDATE wallets SET balance_kobo = 0 WHERE user_id = ?').run(uid);
  assert.equal((await c.call('DELETE', '/api/me', { body: { confirm: 'DELETE' } })).status, 200, 'with an empty wallet it goes through');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
