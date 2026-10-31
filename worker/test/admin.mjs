// The Tap In team's support console (/api/admin). Run with: node test/admin.mjs
import assert from 'node:assert/strict';
import { makeEnv, client, signIn } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const group = (t) => console.log('\n' + t);

// Google's sign-in endpoints are stubbed: any "CODE-*" confirms the email it is used with, and sent links are recorded.
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://identitytoolkit.googleapis.com/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  if (u.includes(':sendOobCode')) { sent.push(body); return new Response('{}', { status: 200 }); }
  if (/^CODE-/.test(body.oobCode || '')) return new Response(JSON.stringify({ email: body.email }), { status: 200 });
  return new Response(JSON.stringify({ error: { message: 'INVALID_OOB_CODE' } }), { status: 400 });
};

const env = makeEnv({ OTP_MODE: 'firebase', FIREBASE_API_KEY: 'k', STAFF_IDENTIFIERS: ' Support@Tap-In.test , lead@tap-in.test ' });
let ipn = 0;
const ip = () => '10.70.' + Math.floor(ipn / 250) + '.' + (ipn++ % 250 + 1);
const fbSignIn = async (e, email, name) => {
  const c = client(e, ip());
  const r = await c.post('/api/auth/email-link/complete', { email, oobCode: 'CODE-x' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (name) await c.patch('/api/me', { name });
  c.id = r.body.user.id;
  return c;
};
const q = (sql, ...a) => env.DB.raw.prepare(sql).get(...a);
const all = (sql, ...a) => env.DB.raw.prepare(sql).all(...a);
const act = (c, path, body = {}, method = 'POST') => c.call(method, '/api/admin' + path, { body });
const reason = 'Customer rang support, checked by the team';

// ---- the world: a team member, a second one, an organiser with an event, and two guests ----
const staff = await fbSignIn(env, 'support@tap-in.test', 'Sam Support');
let lead = await fbSignIn(env, 'lead@tap-in.test', 'Lee Lead');
const org = await fbSignIn(env, 'host@example.com', 'Hope Host');
const mk = async (name, extra = {}) => { const r = await org.post('/api/events', { name, venue: 'Eko Hall', city: 'Lagos', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 500000, capacity: 5 }], ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
const ev = await mk('Admin Fest');
const mint = async (e, n = 1) => (await org.post(`/api/events/${e.event.id}/invites`, { tier_id: e.tiers[0].id, count: n })).body.codes;
const gate = (token) => client(env, ip()).post('/api/gate/scan', { token, zone_id: ev.zones[0].id }, { headers: { Authorization: 'Bearer ' + ev.gate_key } });
const ada = await fbSignIn(env, 'ada.obi@example.com', 'Ada Obi');
const adaCode = (await mint(ev))[0];
const adaPass = (await ada.post('/api/claim', { code: adaCode })).body.pass;
const bola = await fbSignIn(env, 'bola@example.com', 'Bola Bello');

group('Who can get in');
await test('with no team list set, nobody is staff, whoever they are', async () => {
  const bare = makeEnv({ OTP_MODE: 'firebase', FIREBASE_API_KEY: 'k' });
  const c = await fbSignIn(bare, 'support@tap-in.test', 'Sam');
  for (const p of ['/me', '/overview', '/users?q=ab', '/audit']) { const r = await c.get('/api/admin' + p); assert.equal(r.status, 404, p); assert.equal(r.body.error.code, 'not_found'); }
});
await test('signed out, or signed in but not on the list: a plain "not found", for any method and any address', async () => {
  const out = client(env, ip());
  for (const c of [out, ada]) {
    for (const [m, p] of [['GET', '/me'], ['GET', '/overview'], ['GET', '/users?q=ab'], ['GET', '/users/' + ada.id], ['POST', '/users/' + ada.id + '/suspend'], ['PUT', '/users'], ['GET', '/nothing-here'], ['DELETE', '/users/' + ada.id]]) {
      const r = await c.call(m, '/api/admin' + p, m === 'GET' ? {} : { body: { reason } });
      assert.equal(r.status, 404, m + ' ' + p); assert.equal(r.body.error.code, 'not_found');
    }
  }
  assert.equal(q('SELECT COUNT(*) AS n FROM users WHERE suspended_at IS NOT NULL').n, 0, 'and nothing happened');
});
await test('team members get in (the list ignores case and spaces)', async () => {
  const r = await staff.get('/api/admin/me');
  assert.equal(r.status, 200); assert.equal(r.body.staff.identifier, 'support@tap-in.test'); assert.equal(r.body.team_size, 2);
  assert.equal((await lead.get('/api/admin/me')).status, 200);
});
await test('in demo mode (codes shown on screen) nobody can be staff, even if listed', async () => {
  const demo = makeEnv({ STAFF_IDENTIFIERS: 'support@tap-in.test' });
  const c = await signIn(demo, 'support@tap-in.test', '10.71.0.1', 'Sam');
  assert.equal((await c.get('/api/admin/me')).status, 404);
});
await test('a staff session older than 8 hours stops working until they sign in again', async () => {
  const c = await fbSignIn(env, 'lead@tap-in.test', 'Lee Lead');
  assert.equal((await c.get('/api/admin/me')).status, 200);
  env.DB.raw.prepare('UPDATE sessions SET created_at = ? WHERE user_id = ?').run(Math.floor(Date.now() / 1000) - 9 * 3600, c.id);
  assert.equal((await c.get('/api/admin/me')).status, 404, 'too old');
  assert.equal((await c.get('/api/me')).status, 200, 'but they are still signed in as a normal user');
  lead = await fbSignIn(env, 'lead@tap-in.test'); // (that aged every session this person had, so carry on with the fresh one)
  assert.equal((await lead.get('/api/admin/me')).status, 200, 'signing in again restores it');
});
await test('the public config says nothing about the team', async () => {
  const r = await client(env, ip()).get('/api/config');
  assert.ok(!JSON.stringify(r.body).toLowerCase().includes('staff') && !JSON.stringify(r.body).includes('tap-in.test'));
});

group('Finding people');
await test('search needs two characters and finds by email, name, id and phone', async () => {
  assert.equal((await staff.get('/api/admin/users?q=a')).status, 400);
  const byEmail = (await staff.get('/api/admin/users?q=ada.obi')).body.people; assert.equal(byEmail.length, 1); assert.equal(byEmail[0].id, ada.id); assert.equal(byEmail[0].passes, 1);
  assert.equal((await staff.get('/api/admin/users?q=BOLA%20BEL')).body.people[0].id, bola.id, 'by name, any case');
  assert.equal((await staff.get('/api/admin/users?q=' + ada.id)).body.people[0].id, ada.id, 'by id');
  env.DB.raw.prepare("INSERT INTO users (id, phone, name, created_at) VALUES ('phoneuser01', '+2348034127790', 'Phone Person', 1)").run();
  assert.equal((await staff.get('/api/admin/users?q=0803%20412%207790')).body.people[0].id, 'phoneuser01', 'by phone, however it is typed');
});
await test('the characters % and _ in a search are plain characters, not wildcards', async () => {
  assert.equal((await staff.get('/api/admin/users?q=' + encodeURIComponent('%%'))).body.people.length, 0);
  assert.equal((await staff.get('/api/admin/users?q=' + encodeURIComponent('_____'))).body.people.length, 0);
});
await test('a person\'s page shows who they are, passes with entries, invites, events they run, and is itself logged', async () => {
  await gate(adaPass.token);
  const r = await staff.get('/api/admin/users/' + ada.id);
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.user.identifier, 'ada.obi@example.com'); assert.equal(b.user.deleted, false); assert.equal(b.sessions.active, 1);
  assert.equal(b.passes.length, 1); assert.equal(b.passes[0].event_name, 'Admin Fest'); assert.equal(b.passes[0].granted, 1);
  assert.equal(b.recent_entries[0].result, 'granted'); assert.equal(b.recent_entries[0].zone, 'Gate');
  assert.equal(b.target_is_staff, false); assert.equal(b.has_photo, false); assert.equal(b.wallet, null);
  const owner = (await staff.get('/api/admin/users/' + org.id)).body; assert.equal(owner.events_owned[0].name, 'Admin Fest');
  assert.equal((await staff.get('/api/admin/users/nobody')).body.error.code, 'user_not_found');
  assert.ok(b.views_30d >= 1 && !b.audit.some((a) => a.action === 'user.view'), 'views are counted, and kept out of the list of changes');
  const log = all("SELECT staff_identifier, action, target_id FROM audit_log WHERE action = 'user.view' AND target_id = ?", ada.id);
  assert.ok(log.length >= 1 && log[0].staff_identifier === 'support@tap-in.test');
});
await test('the export holds what we know about them and no secrets', async () => {
  const r = await staff.get('/api/admin/users/' + ada.id + '/export');
  assert.equal(r.status, 200); assert.equal(r.body.user.email, 'ada.obi@example.com'); assert.equal(r.body.passes.length, 1);
  const text = JSON.stringify(r.body);
  for (const secret of ['token_hash', 'code_hash', 'jpeg_b64', 'test-pepper', adaCode, adaPass.token]) assert.ok(!text.includes(secret), 'must not contain ' + secret);
  assert.equal(r.body.audit, undefined);
  assert.equal(q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'user.export'").n, 1);
});

group('Fixing things for people');
await test('every change needs a written reason, and nothing changes without one', async () => {
  for (const body of [{}, { reason: '' }, { reason: 'no' }, { reason: 'x'.repeat(301) }]) {
    for (const path of ['/users/' + bola.id + '/sign-out', '/users/' + bola.id + '/send-link', '/users/' + bola.id + '/clear-limits', '/users/' + bola.id + '/suspend', '/users/' + bola.id + '/restore']) {
      const r = await act(staff, path, body); assert.equal(r.status, 400, path); assert.equal(r.body.error.code, 'reason_required');
    }
    assert.equal((await act(staff, '/users/' + bola.id, { name: 'Zed', ...body }, 'PATCH')).status, 400);
    assert.equal((await act(staff, '/passes/' + adaPass.id + '/revoke', body)).status, 400);
  }
  assert.equal((await bola.get('/api/me')).body.user.name, 'Bola Bello'); assert.equal((await bola.get('/api/me')).status, 200);
});
await test('sign out everywhere ends every session and is logged with the reason', async () => {
  const c = await fbSignIn(env, 'two.phones@example.com', 'Two Phones'); const second = client(env, ip()); await second.post('/api/auth/email-link/complete', { email: 'two.phones@example.com', oobCode: 'CODE-x' });
  assert.equal((await c.get('/api/me')).status, 200); assert.equal((await second.get('/api/me')).status, 200);
  const r = await act(staff, '/users/' + c.id + '/sign-out', { reason }); assert.equal(r.status, 200); assert.equal(r.body.sessions_ended, 2);
  assert.equal((await c.get('/api/me')).status, 401); assert.equal((await second.get('/api/me')).status, 401);
  const row = q("SELECT staff_identifier, reason, detail FROM audit_log WHERE action = 'user.sign_out' AND target_id = ?", c.id);
  assert.equal(row.staff_identifier, 'support@tap-in.test'); assert.equal(row.reason, reason); assert.equal(JSON.parse(row.detail).sessions_ended, 2);
});
await test('send a sign-in link goes to the person\'s own inbox, at most three an hour', async () => {
  const c = await fbSignIn(env, 'locked.out@example.com', 'Locked Out');
  const before = sent.length;
  assert.equal((await act(staff, '/users/' + c.id + '/send-link', { reason })).status, 200);
  assert.equal(sent.length, before + 1); assert.equal(sent.at(-1).email, 'locked.out@example.com'); assert.equal(sent.at(-1).continueUrl, 'https://tapin.test/signin/');
  await act(staff, '/users/' + c.id + '/send-link', { reason }); await act(staff, '/users/' + c.id + '/send-link', { reason });
  const fourth = await act(staff, '/users/' + c.id + '/send-link', { reason }); assert.equal(fourth.status, 429); assert.equal(sent.length, before + 3);
  assert.equal((await act(staff, '/users/phoneuser01/send-link', { reason })).body.error.code, 'no_email');
});
await test('clearing sign-in limits lets someone who was told "too many codes" ask again', async () => {
  const stuck = client(env, ip());
  for (let i = 0; i < 3; i++) assert.equal((await stuck.post('/api/auth/otp/request', { identifier: 'ada.obi@example.com' })).status, 200);
  assert.equal((await stuck.post('/api/auth/otp/request', { identifier: 'ada.obi@example.com' })).status, 429);
  const r = await act(staff, '/users/' + ada.id + '/clear-limits', { reason }); assert.equal(r.status, 200); assert.ok(r.body.cleared >= 3);
  assert.equal((await stuck.post('/api/auth/otp/request', { identifier: 'ada.obi@example.com' })).status, 200);
});
await test('fixing a name', async () => {
  const r = await act(staff, '/users/' + bola.id, { name: 'Bola Bello-Ade', reason }, 'PATCH');
  assert.equal(r.status, 200); assert.equal((await bola.get('/api/me')).body.user.name, 'Bola Bello-Ade');
  assert.equal((await act(staff, '/users/' + bola.id, { name: '', reason }, 'PATCH')).status, 400);
  assert.equal((await act(staff, '/users/nobody', { name: 'X', reason }, 'PATCH')).status, 404);
});

group('Suspending and restoring');
await test('a suspended person is signed out, cannot sign back in, and can be restored', async () => {
  const sus = await fbSignIn(env, 'trouble@example.com', 'Trouble Maker');
  assert.equal((await act(staff, '/users/' + sus.id + '/suspend', { reason })).status, 200);
  assert.equal((await sus.get('/api/me')).status, 401, 'their session is gone');
  const back = await client(env, ip()).post('/api/auth/email-link/complete', { email: 'trouble@example.com', oobCode: 'CODE-x' });
  assert.equal(back.status, 403); assert.equal(back.body.error.code, 'account_suspended');
  assert.equal((await act(staff, '/users/' + sus.id + '/suspend', { reason })).status, 409, 'already suspended');
  assert.equal((await staff.get('/api/admin/users/' + sus.id)).body.user.suspended_at > 0, true);
  assert.equal((await act(staff, '/users/' + sus.id + '/send-link', { reason })).body.error.code, 'suspended');
  assert.equal((await act(staff, '/users/' + sus.id + '/restore', { reason })).status, 200);
  assert.equal((await act(staff, '/users/' + sus.id + '/restore', { reason })).status, 409, 'not suspended any more');
  const again = await client(env, ip()).post('/api/auth/email-link/complete', { email: 'trouble@example.com', oobCode: 'CODE-x' });
  assert.equal(again.status, 200, 'signing in works again');
});
await test('a note waiting for the phone app cannot be collected by a suspended person', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const verifier = randomBytes(32).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url');
  const sus = await fbSignIn(env, 'app.trouble@example.com', 'App Trouble');
  await client(env, ip()).post('/api/auth/email-link/complete', { email: 'app.trouble@example.com', oobCode: 'CODE-x', app_challenge: challenge });
  await act(staff, '/users/' + sus.id + '/suspend', { reason });
  const r = await client(env, ip()).post('/api/auth/app/redeem', { verifier });
  assert.deepEqual(r.body, { pending: true }); assert.equal(r.setCookie, null);
});
await test('the team cannot suspend or delete each other, or themselves', async () => {
  for (const [who, code] of [[lead, 'is_staff'], [staff, 'is_you']]) {
    for (const path of ['/suspend', '/delete']) {
      const r = await act(staff, '/users/' + who.id + path, { reason, confirm: 'DELETE' }); assert.equal(r.status, 400, path); assert.equal(r.body.error.code, code);
    }
  }
  assert.equal((await lead.get('/api/admin/me')).status, 200);
  assert.equal((await staff.get('/api/admin/users/' + lead.id)).body.target_is_staff, true);
});

group('Deleting an account for someone');
await test('it needs the word DELETE and a reason, then does what the person\'s own deletion does', async () => {
  const gone = await fbSignIn(env, 'leaving@example.com', 'Leaving Soon');
  const pass = (await gone.post('/api/claim', { code: (await mint(ev))[0] })).body.pass;
  assert.equal((await gate(pass.token)).body.result, 'granted');
  assert.equal((await act(staff, '/users/' + gone.id + '/delete', { reason })).body.error.code, 'confirm_required');
  assert.equal((await act(staff, '/users/' + gone.id + '/delete', { confirm: 'DELETE' })).body.error.code, 'reason_required');
  const r = await act(staff, '/users/' + gone.id + '/delete', { confirm: 'DELETE', reason }); assert.equal(r.status, 200); assert.equal(r.body.passes_cancelled, 1);
  assert.equal((await gone.get('/api/me')).status, 401);
  assert.notEqual((await gate(pass.token)).body.result, 'granted');
  const p = (await staff.get('/api/admin/users/' + gone.id)).body; assert.equal(p.user.deleted, true); assert.equal(p.user.name, null); assert.equal(p.passes[0].status, 'revoked');
  assert.equal((await act(staff, '/users/' + gone.id + '/delete', { confirm: 'DELETE', reason })).body.error.code, 'deleted');
  assert.equal(q("SELECT detail FROM audit_log WHERE action = 'user.delete' AND target_id = ?", gone.id).detail.includes('leaving'), false, 'the log does not keep who they were');
});
await test('someone who runs events has to settle that first', async () => {
  const r = await act(staff, '/users/' + org.id + '/delete', { confirm: 'DELETE', reason });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'runs_events'); assert.ok(r.body.error.events >= 1);
  assert.equal((await org.get('/api/me')).status, 200);
});

group('Passes and invites');
await test('revoking a pass stops it at the gate, restoring it brings it back, and both show on the person\'s page', async () => {
  const code = (await mint(ev))[0]; const p = (await bola.post('/api/claim', { code })).body.pass;
  assert.equal((await gate(p.token)).body.result, 'granted');
  assert.equal((await act(staff, '/passes/' + p.id + '/revoke', { reason })).status, 200);
  assert.notEqual((await gate(p.token)).body.result, 'granted');
  assert.equal((await act(staff, '/passes/' + p.id + '/revoke', { reason })).status, 409);
  assert.equal((await act(staff, '/passes/' + p.id + '/restore', { reason })).status, 200);
  const scans = (await staff.get('/api/admin/passes/' + p.id + '/scans')).body.scans; assert.ok(scans.length >= 2);
  assert.ok(scans.some((s) => s.result === 'denied') && scans.some((s) => s.result === 'granted'));
  const trail = (await staff.get('/api/admin/users/' + bola.id)).body.audit.map((a) => a.action);
  assert.ok(trail.includes('pass.revoke') && trail.includes('pass.restore'), 'their audit trail: ' + trail.join(','));
  assert.equal((await act(staff, '/passes/nope/revoke', { reason })).status, 404);
});
await test('an invite can be found from the code someone reads out, without the code being kept', async () => {
  const hit = await act(staff, '/invites/lookup', { code: adaCode.toLowerCase() });
  assert.equal(hit.status, 200); assert.equal(hit.body.found, true);
  assert.equal(hit.body.invite.status, 'claimed'); assert.equal(hit.body.invite.event_name, 'Admin Fest'); assert.equal(hit.body.invite.claimed_by, ada.id); assert.equal(hit.body.invite.pass_id, adaPass.id);
  const miss = await act(staff, '/invites/lookup', { code: 'ZZZ-26-NOPE-0000' }); assert.equal(miss.body.found, false);
  assert.equal((await act(staff, '/invites/lookup', { code: 'x' })).status, 400);
  assert.ok(!JSON.stringify(all('SELECT * FROM audit_log')).includes(adaCode), 'the code must not be in the audit log');
});
await test('an unused invite can be revoked (and then cannot be claimed); a claimed one points to its pass', async () => {
  const code = (await mint(ev))[0];
  const inv = (await act(staff, '/invites/lookup', { code })).body.invite; assert.equal(inv.status, 'unused');
  assert.equal((await act(staff, '/invites/' + inv.id + '/revoke', { reason })).status, 200);
  assert.notEqual((await bola.post('/api/claim', { code })).status, 201);
  assert.equal((await act(staff, '/invites/' + inv.id + '/revoke', { reason })).body.error.code, 'no_change');
  const claimed = (await act(staff, '/invites/lookup', { code: adaCode })).body.invite;
  assert.equal((await act(staff, '/invites/' + claimed.id + '/revoke', { reason })).body.error.code, 'already_claimed');
});

group('Events');
await test('events can be found by name or by the organiser\'s email, and an event page shows its numbers', async () => {
  assert.equal((await staff.get('/api/admin/events?q=admin%20fest')).body.events[0].id, ev.event.id);
  assert.equal((await staff.get('/api/admin/events?q=host@example')).body.events.length >= 1, true);
  const r = (await staff.get('/api/admin/events/' + ev.event.id)).body;
  assert.equal(r.event.owner_email, 'host@example.com'); assert.equal(r.event.listed, true); assert.equal(r.tiers[0].capacity, 5); assert.ok(r.tiers[0].issued >= 3 && r.tiers[0].claimed >= 2);
  assert.ok(r.passes.active >= 2); assert.ok(r.entries.granted >= 2); assert.ok(Array.isArray(r.entries.denied_reasons));
  assert.equal((await staff.get('/api/admin/events/nope')).body.error.code, 'event_not_found');
});
await test('taking an event off the public list, and putting it back', async () => {
  const listed = async () => (await client(env, ip()).get('/api/public/events')).body.events.some((e) => e.id === ev.event.id);
  assert.equal(await listed(), true);
  assert.equal((await act(staff, '/events/' + ev.event.id + '/listed', { listed: false, reason })).status, 200);
  assert.equal(await listed(), false);
  assert.equal((await act(staff, '/events/' + ev.event.id + '/listed', { listed: false, reason })).body.error.code, 'no_change');
  assert.equal((await act(staff, '/events/' + ev.event.id + '/listed', { reason })).body.error.code, 'listed_required');
  assert.equal((await act(staff, '/events/' + ev.event.id + '/listed', { listed: true, reason })).status, 200);
  assert.equal(await listed(), true);
});

group('Overview and the audit log');
await test('the overview gives the numbers and how things are set up', async () => {
  const r = (await staff.get('/api/admin/overview')).body;
  assert.ok(r.people.total >= 8 && r.people.suspended >= 1); assert.ok(r.passes_active >= 2); assert.equal(r.events.upcoming >= 1, true);
  assert.ok(r.entries_24h.granted >= 3 && r.entries_24h.denied >= 1); assert.ok(r.entries_24h.denied_reasons.length >= 1);
  assert.equal(r.config.otp_mode, 'firebase'); assert.equal(r.config.team_size, 2); assert.equal(r.config.firebase_key_set, true);
  assert.ok(!JSON.stringify(r).includes('@tap-in.test'), 'the team\'s addresses are not listed');
});
await test('the audit log lists what happened, newest first, who did it and why, and can be filtered and paged', async () => {
  const r = (await staff.get('/api/admin/audit')).body;
  assert.ok(r.entries.length > 10); assert.ok(r.entries[0].seq > r.entries[1].seq);
  const del = r.entries.find((e) => e.action === 'user.suspend'); assert.equal(del.reason, reason); assert.equal(del.staff_identifier, 'support@tap-in.test'); assert.equal(del.target_type, 'user');
  const mine = (await staff.get('/api/admin/audit?target=' + bola.id)).body.entries; assert.ok(mine.length >= 2 && mine.every((e) => e.target_id === bola.id || (e.detail && e.detail.user_id === bola.id)));
  for (let i = 0; i < 40; i++) await staff.get('/api/admin/users/' + ada.id); // lots of views
  const page1 = (await staff.get('/api/admin/audit')).body; assert.equal(page1.entries.length, 50); assert.ok(page1.next);
  const page2 = (await staff.get('/api/admin/audit?before=' + page1.next)).body; assert.ok(page2.entries.length > 0 && page2.entries[0].seq < page1.next);
});
await test('the log can only be added to: no route changes or removes an entry', async () => {
  const before = q('SELECT COUNT(*) AS n FROM audit_log').n;
  for (const m of ['PUT', 'PATCH', 'DELETE', 'POST']) assert.notEqual((await staff.call(m, '/api/admin/audit', { body: {} })).status, 200);
  assert.ok(q('SELECT COUNT(*) AS n FROM audit_log').n >= before);
});
await test('ordinary sign-in and sessions are unchanged for everyone else', async () => {
  const c = await fbSignIn(env, 'normal@example.com', 'Normal Person');
  const me = await c.get('/api/me'); assert.equal(me.status, 200); assert.deepEqual(Object.keys(me.body.user).sort(), ['email', 'has_photo', 'id', 'identifier', 'name', 'phone']);
  assert.equal((await c.post('/api/auth/logout')).status, 200); assert.equal((await c.get('/api/me')).status, 401);
});

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
