// Full-loop test: register, sign in, create an event, issue codes, claim, scan at the gate, read stats.
// Run with: node test/smoke.mjs
import assert from 'node:assert/strict';
import { PEPPER, client, makeEnv, signIn } from './harness.mjs';
import { makeInviteCode, makeOtp, parsePassToken, passToken } from '../src/lib/codes.js';

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

const env = makeEnv();
const dump = () => {
  // every text column of every table, to prove no secret is stored in the clear
  const out = [];
  for (const { name } of env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    out.push(JSON.stringify(env.DB.raw.prepare(`SELECT * FROM ${name}`).all()));
  }
  return out.join('\n');
};

let org, alice, bob, carol, eventId, tiers, zones, gateKey, vipCodes;

group('Sign-in codes');
await test('config reports demo mode and a configured server', async () => {
  const r = await client(env).get('/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { otp_mode: 'demo', configured: true });
});
await test('without SECRET_PEPPER every real route fails closed with 503', async () => {
  const bare = makeEnv({ SECRET_PEPPER: '' });
  const c = client(bare);
  assert.equal((await c.post('/api/auth/otp/request', { identifier: '08034127790' })).status, 503);
  assert.equal((await c.get('/api/config')).body.configured, false);
});
await test('rejects a malformed identifier', async () => {
  const r = await client(env, '10.1.0.1').post('/api/auth/otp/request', { identifier: '12' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_identifier');
});
await test('phone numbers are normalised: 0803..., 803..., +234... all reach the same account', async () => {
  const ids = ['0803 412 7790', '803-412-7790', '+234 803 412 7790'];
  const seen = new Set();
  for (const [i, id] of ids.entries()) {
    const c = client(env, '10.2.0.' + i);
    const r = await c.post('/api/auth/otp/request', { identifier: id });
    const v = await c.post('/api/auth/otp/verify', { identifier: id, code: r.body.dev_code });
    assert.equal(v.status, 200);
    seen.add(v.body.user.id);
    assert.equal(v.body.user.phone, '+2348034127790');
    assert.equal(v.body.is_new, i === 0);
  }
  assert.equal(seen.size, 1);
});
await test('a wrong code fails, the right code works once, and cannot be replayed', async () => {
  const c = client(env, '10.3.0.1');
  const id = 'replay@example.com';
  const r = await c.post('/api/auth/otp/request', { identifier: id });
  const wrong = r.body.dev_code === '000000' ? '111111' : '000000';
  assert.equal((await c.post('/api/auth/otp/verify', { identifier: id, code: wrong })).body.error.code, 'code_invalid');
  assert.equal((await c.post('/api/auth/otp/verify', { identifier: id, code: r.body.dev_code })).status, 200);
  const again = await client(env, '10.3.0.2').post('/api/auth/otp/verify', { identifier: id, code: r.body.dev_code });
  assert.equal(again.status, 400);
});
await test('five wrong guesses lock that code, even for the correct digits', async () => {
  const c = client(env, '10.3.1.1');
  const id = 'lock@example.com';
  const r = await c.post('/api/auth/otp/request', { identifier: id });
  const wrong = r.body.dev_code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/otp/verify', { identifier: id, code: wrong })).status, 400);
  const locked = await c.post('/api/auth/otp/verify', { identifier: id, code: r.body.dev_code });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'too_many_attempts');
});
await test('requesting a new code cancels the old one', async () => {
  const c = client(env, '10.3.2.1');
  const id = 'newer@example.com';
  const first = await c.post('/api/auth/otp/request', { identifier: id });
  const second = await c.post('/api/auth/otp/request', { identifier: id });
  if (first.body.dev_code !== second.body.dev_code) {
    assert.equal((await c.post('/api/auth/otp/verify', { identifier: id, code: first.body.dev_code })).status, 400);
  }
  assert.equal((await c.post('/api/auth/otp/verify', { identifier: id, code: second.body.dev_code })).status, 200);
});
await test('code requests are rate limited per identifier (3 per 15 minutes)', async () => {
  const id = 'spam@example.com';
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await client(env, '10.4.0.' + i).post('/api/auth/otp/request', { identifier: id })).status);
  assert.deepEqual(codes, [200, 200, 200]);
  const r = await client(env, '10.4.0.9').post('/api/auth/otp/request', { identifier: id });
  assert.equal(r.status, 429);
});
await test('in live mode with no provider, it refuses to send instead of falling back to demo', async () => {
  const live = makeEnv({ OTP_MODE: 'live' });
  const r = await client(live).post('/api/auth/otp/request', { identifier: '08034127790' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'otp_provider_not_configured');
  assert.equal(r.body.dev_code, undefined);
});
await test('OTP values are uniformly distributed and always six digits', async () => {
  const counts = new Array(10).fill(0);
  const n = 40000;
  for (let i = 0; i < n; i++) {
    const c = makeOtp();
    assert.match(c, /^\d{6}$/);
    for (const ch of c) counts[+ch]++;
  }
  for (const k of counts) assert.ok(Math.abs(k / (n * 6) - 0.1) < 0.006, 'digit frequency off: ' + counts);
});

group('Accounts and sessions');
await test('registration creates an account and a HttpOnly session cookie', async () => {
  org = client(env, '10.5.0.1');
  const r = await org.post('/api/auth/otp/request', { identifier: 'organiser@palmgrove.ng' });
  const v = await org.post('/api/auth/otp/verify', { identifier: 'organiser@palmgrove.ng', code: r.body.dev_code });
  assert.equal(v.status, 200);
  assert.equal(v.body.is_new, true);
  assert.match(v.setCookie, /tapin_session=[A-Za-z0-9_-]{40,}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000/);
  await org.patch('/api/me', { name: 'Ngozi Palmgrove' });
});
await test('the session token is not stored in the database', async () => {
  const token = /tapin_session=([^;]+)/.exec((await signIn(env, 'tok@example.com', '10.5.0.2')).get && '') ;
  const c = client(env, '10.5.0.3');
  const r = await c.post('/api/auth/otp/request', { identifier: 'tok2@example.com' });
  const v = await c.post('/api/auth/otp/verify', { identifier: 'tok2@example.com', code: r.body.dev_code });
  const raw = /tapin_session=([^;]+)/.exec(v.setCookie)[1];
  assert.ok(!dump().includes(raw));
});
await test('protected routes need a session', async () => {
  assert.equal((await client(env, '10.5.0.4').get('/api/me')).status, 401);
  assert.equal((await client(env, '10.5.0.4').get('/api/events')).status, 401);
});
await test('cross-site writes are refused', async () => {
  const r = await org.post('/api/events', {}, { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'bad_origin');
});
await test('non-JSON bodies are refused', async () => {
  const r = await client(env, '10.5.0.5').call('POST', '/api/auth/otp/request', { body: 'identifier=x', raw: true, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
});

group('Organiser: events and invite codes');
const eventBody = {
  name: 'Palm Grove Festival',
  venue: 'Eko Atlantic Grounds',
  city: 'Lagos',
  starts_at: '2026-12-12T16:00:00.000Z',
  zones: ['Main Grounds', 'VIP Lounge', 'Backstage'],
  tiers: [
    { name: 'General Admission', zones: ['Main Grounds'] },
    { name: 'VIP Access', zones: ['Main Grounds', 'VIP Lounge'] },
    { name: 'Artist', zones: ['Main Grounds', 'VIP Lounge', 'Backstage'] }
  ]
};
await test('creating an event validates its structure', async () => {
  const bad = (patch) => org.post('/api/events', { ...eventBody, ...patch });
  assert.equal((await bad({ name: 'x' })).status, 400);
  assert.equal((await bad({ zones: [] })).status, 400);
  assert.equal((await bad({ zones: ['A', 'a'] })).body.error.code, 'duplicate_zone');
  assert.equal((await bad({ tiers: [{ name: 'T', zones: ['Nowhere'] }] })).body.error.code, 'invalid_tier_zones');
  assert.equal((await bad({ tiers: [{ name: 'T', zones: [] }] })).body.error.code, 'invalid_tier_zones');
  assert.equal((await bad({ starts_at: 'not a date' })).status, 400);
});
await test('creating an event returns the structure and a gate key (shown once)', async () => {
  const r = await org.post('/api/events', eventBody);
  assert.equal(r.status, 201);
  eventId = r.body.event.id;
  tiers = Object.fromEntries(r.body.tiers.map((t) => [t.name, t]));
  zones = Object.fromEntries(r.body.zones.map((z) => [z.name, z]));
  gateKey = r.body.gate_key;
  assert.equal(r.body.event.prefix, 'PGF');
  assert.match(gateKey, /^GK-([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/);
  assert.equal(tiers['VIP Access'].zone_ids.length, 2);
  assert.ok(!dump().includes(gateKey), 'gate key must not be stored in the clear');
  assert.equal((await org.get('/api/events/' + eventId)).body.event.gate_key_hint, gateKey.slice(-4));
});
await test('another signed-in user cannot see or change that event', async () => {
  carol = await signIn(env, 'carol@example.com', '10.6.0.1', 'Carol Okafor');
  for (const [m, p] of [['GET', ''], ['GET', '/invites'], ['GET', '/attendees'], ['POST', '/gate-key']]) {
    const r = await carol.call(m, '/api/events/' + eventId + p, m === 'POST' ? { body: {} } : {});
    assert.equal(r.status, 404, m + ' ' + p);
  }
  assert.equal((await carol.post('/api/events/' + eventId + '/invites', { tier_id: tiers['VIP Access'].id, count: 1 })).status, 404);
});
await test('invite codes have the expected shape, are unique, and never appear in the database', async () => {
  const r = await org.post('/api/events/' + eventId + '/invites', { tier_id: tiers['VIP Access'].id, count: 40, label: 'Sponsors' });
  assert.equal(r.status, 201);
  vipCodes = r.body.codes;
  assert.equal(vipCodes.length, 40);
  assert.equal(new Set(vipCodes).size, 40);
  for (const c of vipCodes) assert.match(c, /^PGF-26-VIP-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const db = dump();
  for (const c of vipCodes) {
    assert.ok(!db.includes(c), 'plain code found in database');
    assert.ok(!db.includes(c.replace(/-/g, '')), 'plain code (no dashes) found in database');
  }
  const list = await org.get('/api/events/' + eventId + '/invites');
  assert.equal(list.body.invites.length, 40);
  assert.ok(!JSON.stringify(list.body).includes(vipCodes[0]));
  assert.match(list.body.invites[0].code_hint, /^[0-9A-Z]{4}$/);
});
await test('batch limits and bad input are rejected', async () => {
  const u = '/api/events/' + eventId + '/invites';
  assert.equal((await org.post(u, { tier_id: tiers['VIP Access'].id, count: 501 })).status, 400);
  assert.equal((await org.post(u, { tier_id: tiers['VIP Access'].id, count: 0 })).status, 400);
  assert.equal((await org.post(u, { tier_id: 'nope', count: 1 })).status, 400);
  assert.equal((await org.post(u, { tier_id: tiers['VIP Access'].id, count: 2, bound_to: '08034127790' })).status, 400);
  assert.equal((await org.post(u, { tier_id: tiers['VIP Access'].id, count: 1, expires_at: '2020-01-01T00:00:00Z' })).status, 400);
});
await test('a 500-code batch is created in one statement', async () => {
  const r = await org.post('/api/events/' + eventId + '/invites', { tier_id: tiers['General Admission'].id, count: 500 });
  assert.equal(r.status, 201);
  assert.equal(new Set(r.body.codes).size, 500);
  assert.match(r.body.codes[0], /^PGF-26-GA-/);
});
await test('code generation: 5,000 codes, no repeats, all 40 random bits in play', async () => {
  const seen = new Set();
  const chars = new Set();
  for (let i = 0; i < 5000; i++) {
    const c = makeInviteCode({ prefix: 'PGF', year2: '26', tier: 'VIP' });
    assert.ok(!seen.has(c));
    seen.add(c);
    for (const ch of c.split('-').slice(3).join('')) chars.add(ch);
  }
  assert.equal(chars.size, 32);
});

group('Attendee: claiming a pass');
await test('claiming accepts sloppy typing (case, spaces, O for 0, I for 1)', async () => {
  alice = await signIn(env, '+2348055500001', '10.7.0.1', 'Alice Bello');
  const messy = vipCodes[0].toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  const r = await alice.post('/api/claim', { code: messy });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p = r.body.pass;
  assert.match(p.token, /^TP-([0-9A-Z]{5}-){3}[0-9A-Z]{5}$/);
  assert.equal(p.event.name, 'Palm Grove Festival');
  assert.equal(p.tier, 'VIP Access');
  assert.deepEqual(p.zones.sort(), ['Main Grounds', 'VIP Lounge']);
});
await test('the same code cannot be used twice, by the same person or someone else', async () => {
  const again = await alice.post('/api/claim', { code: vipCodes[0] });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_yours');
  bob = await signIn(env, 'bob@example.com', '10.7.0.2', 'Bob Adeyemi');
  const other = await bob.post('/api/claim', { code: vipCodes[0] });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'used');
});
await test('two people claiming the same fresh code at the same instant: exactly one wins', async () => {
  const [a, b] = await Promise.all([alice.post('/api/claim', { code: vipCodes[1] }), bob.post('/api/claim', { code: vipCodes[1] })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const rows = env.DB.raw.prepare('SELECT COUNT(*) n FROM passes WHERE invite_id = (SELECT id FROM invites WHERE status = ? AND claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 1)').get('claimed');
  assert.ok(rows.n >= 1);
  const dupes = env.DB.raw.prepare('SELECT invite_id, COUNT(*) n FROM passes GROUP BY invite_id HAVING n > 1').all();
  assert.equal(dupes.length, 0);
});
await test('wrong codes are rate limited per person (8 per hour)', async () => {
  const dave = await signIn(env, 'dave@example.com', '10.7.0.3');
  for (let i = 0; i < 8; i++) assert.equal((await dave.post('/api/claim', { code: 'PGF-26-VIP-ZZZZ-ZZZ' + (i % 9) })).status, 404);
  const r = await dave.post('/api/claim', { code: vipCodes[2] });
  assert.equal(r.status, 429);
});
await test('an invite tied to a phone number can only be claimed by that phone', async () => {
  const r = await org.post('/api/events/' + eventId + '/invites', { tier_id: tiers['Artist'].id, count: 1, bound_to: '0805 550 0002', label: 'Headliner' });
  assert.equal(r.status, 201);
  const code = r.body.codes[0];
  const stranger = await signIn(env, 'stranger@example.com', '10.7.0.4');
  const denied = await stranger.post('/api/claim', { code });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'wrong_holder');
  const holder = await signIn(env, '+2348055500002', '10.7.0.5', 'Headline Act');
  const me = await holder.get('/api/me');
  assert.equal(me.body.waiting.length, 1);
  assert.equal(me.body.waiting[0].tier, 'Artist');
  const got = await holder.post('/api/claim', { invite_id: me.body.waiting[0].id });
  assert.equal(got.status, 201);
  assert.equal((await holder.get('/api/me')).body.waiting.length, 0);
  const strangerById = await stranger.post('/api/claim', { invite_id: me.body.waiting[0].id });
  assert.notEqual(strangerById.status, 201);
});
await test('an unbound invite cannot be claimed by guessing its id', async () => {
  const list = await org.get('/api/events/' + eventId + '/invites?status=unused&limit=1');
  const r = await bob.post('/api/claim', { invite_id: list.body.invites[0].id });
  assert.equal(r.status, 404);
});
await test('cancelled invites cannot be claimed; claimed ones cannot be cancelled as invites', async () => {
  const list = (await org.get('/api/events/' + eventId + '/invites?status=unused&limit=200')).body.invites;
  const rev = await org.post('/api/events/' + eventId + '/invites/' + list[0].id + '/revoke', {});
  assert.equal(rev.status, 200);
  const claimed = (await org.get('/api/events/' + eventId + '/invites?status=claimed&limit=5')).body.invites[0];
  assert.equal((await org.post('/api/events/' + eventId + '/invites/' + claimed.id + '/revoke', {})).status, 409);
});
await test('expired invites are refused', async () => {
  const r = await org.post('/api/events/' + eventId + '/invites', { tier_id: tiers['VIP Access'].id, count: 1, expires_at: new Date(Date.now() + 3600e3).toISOString() });
  env.DB.raw.prepare('UPDATE invites SET expires_at = 1000000000 WHERE code_hint = ?').run(r.body.codes[0].slice(-4));
  const eve = await signIn(env, 'eve@example.com', '10.7.0.6');
  assert.equal((await eve.post('/api/claim', { code: r.body.codes[0] })).body.error.code, 'expired');
});

group('Gate: scanning passes');
let alicePass, bobPass, gaPass, artistPass;
await test('gate key is required, and a wrong one is refused', async () => {
  const g = client(env, '10.8.0.1');
  assert.equal((await g.get('/api/gate/info')).status, 401);
  assert.equal((await g.get('/api/gate/info', { headers: { Authorization: 'Bearer GK-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' } })).status, 401);
  const ok = await g.get('/api/gate/info', { headers: { Authorization: 'Bearer ' + gateKey } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.event.name, 'Palm Grove Festival');
  assert.equal(ok.body.zones.length, 3);
  const loose = await g.get('/api/gate/info', { headers: { Authorization: 'Bearer ' + gateKey.toLowerCase().replace(/-/g, ' ') } });
  assert.equal(loose.status, 200);
});
await test('failed gate-key attempts are limited', async () => {
  const g = client(env, '10.8.0.99');
  for (let i = 0; i < 20; i++) await g.get('/api/gate/info', { headers: { Authorization: 'Bearer GK-WRONG' + i } });
  const r = await g.get('/api/gate/info', { headers: { Authorization: 'Bearer ' + gateKey } });
  assert.equal(r.status, 429);
});

const G = () => ({ headers: { Authorization: 'Bearer ' + gateKey } });
const scan = (token, zoneName, ip = '10.8.1.1') => client(env, ip).post('/api/gate/scan', { token, zone_id: zones[zoneName].id }, G());

await test('a VIP pass is admitted to the main grounds, with the holder shown as first name + initial', async () => {
  alicePass = (await alice.get('/api/me')).body.passes[0];
  const r = await scan(alicePass.token, 'Main Grounds');
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'granted');
  assert.equal(r.body.holder, 'Alice B.');
  assert.equal(r.body.tier, 'VIP Access');
  assert.equal(r.body.zone, 'Main Grounds');
});
await test('scanning the same pass again at the same zone is declined (one entry per zone)', async () => {
  const r = await scan(alicePass.token, 'Main Grounds');
  assert.equal(r.body.result, 'denied');
  assert.equal(r.body.reason, 'already_used');
  assert.ok(r.body.previous_at);
});
await test('the same pass can still enter a different zone it is allowed into', async () => {
  assert.equal((await scan(alicePass.token, 'VIP Lounge')).body.result, 'granted');
});
await test('a pass is refused in a zone its ticket type does not include', async () => {
  assert.equal((await scan(alicePass.token, 'Backstage')).body.reason, 'no_zone_access');
  const g = await signIn(env, 'ga@example.com', '10.8.2.1', 'Gift Adewale');
  const gaCode = (await org.post('/api/events/' + eventId + '/invites', { tier_id: tiers['General Admission'].id, count: 1 })).body.codes[0];
  gaPass = (await g.post('/api/claim', { code: gaCode })).body.pass;
  assert.equal((await scan(gaPass.token, 'VIP Lounge')).body.reason, 'no_zone_access');
  assert.equal((await scan(gaPass.token, 'Main Grounds')).body.result, 'granted');
});
await test('tampered, truncated and made-up tokens are refused without touching a pass', async () => {
  const t = alicePass.token;
  const flipped = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  for (const bad of [flipped, t.slice(0, -5), 'TP-AAAAA-AAAAA-AAAAA-AAAAA', 'hello', '', t.replace('TP', 'XX')]) {
    const r = await scan(bad, 'Main Grounds', '10.8.3.' + Math.floor(Math.random() * 200));
    assert.equal(r.body.result, 'denied', bad);
    assert.equal(r.body.reason, 'invalid_token', bad);
    assert.equal(r.body.holder, null);
  }
});
await test("a different event's pass is refused and the answer reveals nothing about its holder", async () => {
  const other = await signIn(env, 'other-org@example.com', '10.8.4.1');
  const ev2 = (await other.post('/api/events', { name: 'Eko Night Market', zones: ['Gate'], tiers: [{ name: 'Entry', zones: ['Gate'] }] })).body;
  const code = (await other.post('/api/events/' + ev2.event.id + '/invites', { tier_id: ev2.tiers[0].id, count: 1 })).body.codes[0];
  const holder = await signIn(env, 'market@example.com', '10.8.4.2', 'Market Goer');
  const pass2 = (await holder.post('/api/claim', { code })).body.pass;
  const r = await scan(pass2.token, 'Main Grounds');
  assert.equal(r.body.reason, 'wrong_event');
  assert.equal(r.body.holder, null);
  assert.equal(r.body.tier, null);
});
await test('a cancelled pass is refused', async () => {
  bobPass = (await bob.post('/api/claim', { code: vipCodes[3] })).body.pass;
  assert.equal((await scan(bobPass.token, 'Main Grounds')).body.result, 'granted');
  const att = (await org.get('/api/events/' + eventId + '/attendees')).body.attendees.find((a) => a.id === bobPass.id);
  assert.equal((await org.post('/api/events/' + eventId + '/passes/' + bobPass.id + '/revoke', {})).status, 200);
  assert.equal((await scan(bobPass.token, 'VIP Lounge')).body.reason, 'revoked');
  assert.ok(att.first_entry);
});
await test('two gates scanning one fresh pass at the same instant: exactly one admits it', async () => {
  const p = await signIn(env, 'race@example.com', '10.8.5.1', 'Race Condition');
  const code = (await org.post('/api/events/' + eventId + '/invites', { tier_id: tiers['VIP Access'].id, count: 1 })).body.codes[0];
  const pass = (await p.post('/api/claim', { code })).body.pass;
  const results = await Promise.all([scan(pass.token, 'Main Grounds', '10.8.5.2'), scan(pass.token, 'Main Grounds', '10.8.5.3'), scan(pass.token, 'Main Grounds', '10.8.5.4')]);
  const granted = results.filter((r) => r.body.result === 'granted').length;
  assert.equal(granted, 1, JSON.stringify(results.map((r) => r.body.result)));
});
await test('events that allow re-entry admit the same pass repeatedly', async () => {
  const o2 = await signIn(env, 're@example.com', '10.8.6.1');
  const e = (await o2.post('/api/events', { name: 'Open Day', zones: ['Hall'], tiers: [{ name: 'Visitor', zones: ['Hall'] }], allow_reentry: true })).body;
  const code = (await o2.post('/api/events/' + e.event.id + '/invites', { tier_id: e.tiers[0].id, count: 1 })).body.codes[0];
  const v = await signIn(env, 'visitor@example.com', '10.8.6.2', 'Vi Sitor');
  const pass = (await v.post('/api/claim', { code })).body.pass;
  const s = () => client(env, '10.8.6.3').post('/api/gate/scan', { token: pass.token, zone_id: e.zones[0].id }, { headers: { Authorization: 'Bearer ' + e.gate_key } });
  assert.equal((await s()).body.result, 'granted');
  assert.equal((await s()).body.result, 'granted');
});
await test('scan requests need a valid zone', async () => {
  const r = await client(env, '10.8.7.1').post('/api/gate/scan', { token: alicePass.token, zone_id: 'nope' }, G());
  assert.equal(r.status, 400);
});
await test('rotating the gate key retires the old one at once', async () => {
  const r = await org.post('/api/events/' + eventId + '/gate-key', {});
  assert.equal(r.status, 200);
  assert.equal((await client(env, '10.8.8.1').get('/api/gate/info', G())).status, 401);
  gateKey = r.body.gate_key;
  assert.equal((await client(env, '10.8.8.2').get('/api/gate/info', G())).status, 200);
});

group('Organiser: live numbers');
await test('stats add up and the activity feed lists the latest scans', async () => {
  const r = await org.get('/api/events/' + eventId);
  const s = r.body.stats;
  const granted = env.DB.raw.prepare("SELECT COUNT(*) n FROM scans WHERE event_id = ? AND result = 'granted'").get(eventId).n;
  const denied = env.DB.raw.prepare("SELECT COUNT(*) n FROM scans WHERE event_id = ? AND result = 'denied'").get(eventId).n;
  assert.equal(s.denied, denied);
  assert.equal(s.scans, granted + denied);
  assert.ok(s.registered >= 5);
  assert.ok(s.checked_in >= 3 && s.checked_in <= s.registered);
  assert.equal(s.by_zone.reduce((a, z) => a + z.granted, 0), granted);
  assert.equal(s.by_tier.reduce((a, t) => a + t.registered, 0), s.registered);
  assert.ok(s.entry_volume.length >= 1 && s.entry_volume[0].hour % 3600 === 0);
  assert.equal(s.invites.unused + s.invites.claimed + s.invites.revoked, env.DB.raw.prepare('SELECT COUNT(*) n FROM invites WHERE event_id = ?').get(eventId).n, 'invite total');
  assert.ok(r.body.recent.length >= 5);
  assert.ok(r.body.recent.some((x) => x.result === 'denied' && x.reason));
});
await test('events list shows my events with their counts', async () => {
  const r = await org.get('/api/events');
  assert.equal(r.body.events.length, 1);
  assert.ok(r.body.events[0].registered >= 5);
});
await test('an attendee sees every scan of their own pass in their history', async () => {
  const h = (await alice.get('/api/me/history')).body.scans;
  assert.ok(h.length >= 3);
  assert.ok(h.some((x) => x.result === 'granted' && x.zone === 'Main Grounds'));
  assert.ok(h.some((x) => x.reason === 'already_used'));
});

group('Pass tokens and sign-out');
await test('pass tokens are recomputed, not stored, and survive a round trip', async () => {
  const tok = await passToken(PEPPER, 'ABCDEFGHJK');
  assert.deepEqual(parsePassToken(tok.toLowerCase()), parsePassToken(tok));
  assert.equal(parsePassToken(tok).id, 'ABCDEFGHJK');
  const db = dump();
  assert.ok(!db.includes(alicePass.token) && !db.includes(alicePass.token.replace(/-/g, '')));
  assert.ok(!db.includes(alicePass.token.slice(-10)), 'the MAC half must not be stored');
});
await test('signing out ends the session', async () => {
  const c = await signIn(env, 'bye@example.com', '10.9.0.1');
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await c.post('/api/auth/logout', {})).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
});
await test('an organiser allow-list limits who can create events', async () => {
  const locked = makeEnv({ ORGANISER_IDENTIFIERS: 'boss@example.com, +2348000000000' });
  const nope = await signIn(locked, 'rando@example.com', '10.9.1.1');
  assert.equal((await nope.post('/api/events', eventBody)).status, 403);
  const boss = await signIn(locked, 'Boss@Example.com', '10.9.1.2');
  assert.equal((await boss.post('/api/events', eventBody)).status, 201);
});
await test('unknown routes and methods answer cleanly', async () => {
  assert.equal((await org.get('/api/nope')).status, 404);
  assert.equal((await org.call('DELETE', '/api/events')).status, 405);
  const root = await worker_fetch('/index.html');
  assert.equal(root, 'asset');
});
async function worker_fetch(path) {
  const mod = await import('../src/index.js');
  return (await mod.default.fetch(new Request('https://tapin.test' + path), env)).text();
}


// ---- Firebase email-link mode (Google's endpoints are stubbed; nothing real is sent) ----
{
  const realFetch = globalThis.fetch;
  const sent = [];
  let nextError = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.startsWith('https://identitytoolkit.googleapis.com/')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    if (nextError) return new Response(JSON.stringify({ error: { message: nextError } }), { status: 400 });
    if (u.includes(':sendOobCode')) { sent.push({ u, body }); return new Response('{}', { status: 200 }); }
    if (body.oobCode === 'GOODCODE') return new Response(JSON.stringify({ email: body.email }), { status: 200 });
    if (body.oobCode === 'OTHERCODE') return new Response(JSON.stringify({ email: 'someone.else@example.com' }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'INVALID_OOB_CODE' } }), { status: 400 });
  };
  const fenv = makeEnv({ OTP_MODE: 'firebase', FIREBASE_API_KEY: 'test-key' });
  await test('firebase mode: config reports it and asks for the key if missing', async () => {
    const c = client(fenv, '10.7.0.1');
    assert.equal((await c.get('/api/config')).body.otp_mode, 'firebase');
    const bare = client(makeEnv({ OTP_MODE: 'firebase' }), '10.7.0.2');
    assert.ok((await bare.get('/api/config')).body.delivery_problem);
    const r = await bare.post('/api/auth/otp/request', { identifier: 'a@example.com' });
    assert.equal(r.status, 503);
  });
  await test('firebase mode: phone numbers are refused, email gets a link, no code is leaked', async () => {
    const c = client(fenv, '10.7.1.1');
    const ph = await c.post('/api/auth/otp/request', { identifier: '08034127790' });
    assert.equal(ph.status, 400); assert.equal(ph.body.error.code, 'email_only');
    const r = await c.post('/api/auth/otp/request', { identifier: 'Fire@Example.com' });
    assert.equal(r.status, 200); assert.equal(r.body.channel, 'email-link'); assert.equal(r.body.dev_code, undefined);
    const last = sent.at(-1);
    assert.equal(last.body.email, 'fire@example.com'); assert.equal(last.body.requestType, 'EMAIL_SIGNIN');
    assert.equal(last.body.continueUrl, 'https://tapin.test/signin/'); assert.equal(last.body.canHandleCodeInApp, true);
    assert.ok(last.u.includes('key=test-key'));
  });
  await test('firebase mode: a good link signs in; wrong, reused or mismatched links do not', async () => {
    const c = client(fenv, '10.7.2.1');
    const bad = await c.post('/api/auth/email-link/complete', { email: 'fire@example.com', oobCode: 'NOPE' });
    assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'link_invalid');
    const mism = await c.post('/api/auth/email-link/complete', { email: 'fire@example.com', oobCode: 'OTHERCODE' });
    assert.equal(mism.status, 400); assert.equal(mism.body.error.code, 'email_mismatch');
    assert.equal((await c.get('/api/me')).status, 401);
    const ok = await c.post('/api/auth/email-link/complete', { email: 'fire@example.com', oobCode: 'GOODCODE' });
    assert.equal(ok.status, 200); assert.equal(ok.body.is_new, true);
    assert.equal((await c.get('/api/me')).status, 200);
    assert.equal((await c.post('/api/auth/email-link/complete', { email: '08034127790', oobCode: 'GOODCODE' })).status, 400);
  });
  await test('firebase mode: Google configuration errors become clear messages', async () => {
    const c = client(fenv, '10.7.3.1');
    nextError = 'OPERATION_NOT_ALLOWED';
    assert.equal((await c.post('/api/auth/otp/request', { identifier: 'x1@example.com' })).body.error.code, 'email_not_enabled');
    nextError = 'UNAUTHORIZED_DOMAIN : Domain not whitelisted by project';
    assert.equal((await c.post('/api/auth/otp/request', { identifier: 'x2@example.com' })).body.error.code, 'domain_not_authorised');
    nextError = null;
  });
  await test('demo mode does not expose the email-link route', async () => {
    const c = client(env, '10.7.4.1');
    assert.equal((await c.post('/api/auth/email-link/complete', { email: 'a@example.com', oobCode: 'GOODCODE' })).status, 404);
  });
  globalThis.fetch = realFetch;
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed: ' + failures.join('; '));
  process.exit(1);
}
