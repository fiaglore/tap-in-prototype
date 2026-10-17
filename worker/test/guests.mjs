// Guest lists: tickets imported from another ticketer, and private-event invitations (no account, RSVP,
// plus-ones). Run with: node test/guests.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const group = (t) => console.log('\n' + t);

const env = makeEnv();
let ipN = 1;
const freshIp = () => '10.90.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const anon = () => client(env, freshIp());
const org = await signIn(env, 'host@guests.test', '10.90.200.1', 'Hosting Person');
const other = await signIn(env, 'other@guests.test', '10.90.200.2', 'Other Host');

const ev = (await org.post('/api/events', { name: 'Tolu & Ada Wedding', zones: ['Entrance', 'Reception'], tiers: [{ name: 'Guest', zones: ['Entrance', 'Reception'] }, { name: 'Family', zones: ['Entrance', 'Reception'] }, { name: 'Ceremony only', zones: ['Entrance'] }], listed: false })).body;
const id = ev.event.id;
const entrance = ev.zones.find((z) => z.name === 'Entrance').id;
const reception = ev.zones.find((z) => z.name === 'Reception').id;
const tier = (n) => ev.tiers.find((t) => t.name === n).id;
const scan = (token, zone = entrance, key = ev.gate_key) => anon().post('/api/gate/scan', { token, zone_id: zone }, { headers: { Authorization: 'Bearer ' + key } });
const tokenOf = (link) => link.split('#')[1];

group('Invitations');
let inv;
await test('the host adds guests with plus-ones and tables; each gets an invitation link; bad lines are skipped with a reason', async () => {
  const r = await org.post(`/api/events/${id}/guests`, { tier_id: tier('Guest'), guests: [
    { name: 'Adaeze Okafor', contact: '0803 412 7790', party_size: 3, table: 'Table 4' },
    { name: 'Bayo Ade', contact: 'bayo@example.com' },
    { name: '', contact: 'x@example.com' },
    { name: 'Too Many', party_size: 50 },
    { name: 'Bad Phone', contact: 'not a phone' }
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.added.length, 2);
  assert.equal(r.body.skipped.length, 3);
  assert.deepEqual(r.body.skipped.map((s) => s.line), [3, 4, 5]);
  inv = r.body.added;
  assert.match(inv[0].link, /\/i\/#[0-9A-Z]{22}$/);
  assert.equal(inv[0].contact, '+2348034127790');
  assert.equal(inv[0].party_size, 3);
  assert.equal(inv[1].party_size, 1);
});
await test('nothing secret is stored: no code or link in the database', async () => {
  const row = env.DB.raw.prepare('SELECT * FROM guests WHERE id = ?').get(inv[0].id);
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes(tokenOf(inv[0].link)));
  assert.equal(row.code_hash, null);
});
await test('the guest opens the invitation without an account and sees the event, their party and their entry code', async () => {
  const r = await anon().post('/api/invitation', { token: tokenOf(inv[0].link) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.event.name, 'Tolu & Ada Wedding');
  assert.equal(r.body.guest.name, 'Adaeze Okafor');
  assert.equal(r.body.guest.party_size, 3);
  assert.equal(r.body.guest.table, 'Table 4');
  assert.equal(r.body.guest.rsvp, 'pending');
  assert.match(r.body.code, /^TG-/);
  assert.equal(r.body.guest.contact, undefined, 'the invitation page never shows contact details');
});
await test('a tampered or made-up link is refused, and repeated guessing is slowed down', async () => {
  const t = tokenOf(inv[0].link);
  const bad = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  assert.equal((await anon().post('/api/invitation', { token: bad })).status, 404);
  assert.equal((await anon().post('/api/invitation', { token: 'nonsense' })).status, 404);
  const c = client(env, '10.90.250.250');
  let last;
  for (let i = 0; i < 31; i++) last = await c.post('/api/invitation', { token: 'AAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(last.status, 429);
});
await test('RSVP: yes with how many are coming (up to the party size), and it can be changed', async () => {
  const t = tokenOf(inv[0].link);
  assert.equal((await anon().post('/api/invitation/rsvp', { token: t, response: 'yes', attending: 4 })).status, 400);
  const r = await anon().post('/api/invitation/rsvp', { token: t, response: 'yes', attending: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.guest.rsvp, 'yes');
  assert.equal(r.body.guest.attending, 2);
  const no = await anon().post('/api/invitation/rsvp', { token: tokenOf(inv[1].link), response: 'no' });
  assert.equal(no.body.guest.rsvp, 'no');
  assert.equal((await anon().post('/api/invitation/rsvp', { token: t, response: 'maybe' })).status, 400);
});
await test('the host sees the list with links and an RSVP summary; other organisers cannot', async () => {
  const r = await org.get(`/api/events/${id}/guests`);
  assert.equal(r.status, 200);
  assert.equal(r.body.summary.invitations, 2);
  assert.equal(r.body.summary.invited_people, 4);
  assert.equal(r.body.summary.yes, 1);
  assert.equal(r.body.summary.yes_people, 2);
  assert.equal(r.body.summary.no, 1);
  assert.equal(r.body.guests[0].link, inv[0].link);
  assert.equal((await other.get(`/api/events/${id}/guests`)).status, 404);
  assert.equal((await other.post(`/api/events/${id}/guests`, { tier_id: tier('Guest'), guests: [{ name: 'X' }] })).status, 404);
});
await test('at the gate, one scan of the invitation code lets the whole party in, with their table, once per area', async () => {
  const code = (await anon().post('/api/invitation', { token: tokenOf(inv[0].link) })).body.code;
  const r = await scan(code);
  assert.equal(r.body.result, 'granted', JSON.stringify(r.body));
  assert.equal(r.body.holder, 'Adaeze O.');
  assert.equal(r.body.party, 2, 'RSVP said 2 of 3 are coming');
  assert.equal(r.body.table, 'Table 4');
  assert.equal(r.body.guest, 'invite');
  const again = await scan(code);
  assert.equal(again.body.reason, 'already_used');
  assert.ok(again.body.previous_at);
  assert.equal((await scan(code, reception)).body.result, 'granted', 'a different area is a separate entry');
});
await test('a cancelled invitation stops working at the gate and on the invitation page', async () => {
  assert.equal((await org.post(`/api/events/${id}/guests/${inv[1].id}/revoke`, {})).status, 200);
  const t = tokenOf(inv[1].link);
  assert.equal((await anon().post('/api/invitation', { token: t })).status, 410);
  // its code, if they had saved it, is refused
  const { guestToken } = await import('../src/lib/codes.js');
  const code = await guestToken(env.SECRET_PEPPER, inv[1].id);
  assert.equal((await scan(code)).body.reason, 'revoked');
});

group('Importing tickets sold elsewhere');
await test('a list from another ticketer is imported; ticket types map by name; repeats and blanks are skipped', async () => {
  const r = await org.post(`/api/events/${id}/guests/import`, { tier_id: tier('Guest'), rows: [
    { code: 'TIX-88812-AB', name: 'Chidi Nwosu', tier: 'family' },
    { code: 'tix-99001-cd', name: 'Ngozi Eze' },
    { code: 'TIX88812AB', name: 'Dup Of First' },
    { code: '', name: 'No Code' },
    { code: 'SYT 4455 7788', tier: 'Ceremony only' }
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.imported, 3);
  assert.deepEqual(r.body.skipped.map((s) => s.line), [3, 4]);
  const again = await org.post(`/api/events/${id}/guests/import`, { tier_id: tier('Guest'), rows: [{ code: 'TIX-88812-AB' }] });
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.skipped[0].reason, 'Already imported');
  const row = env.DB.raw.prepare("SELECT code_hash, code_hint, tier_id FROM guests WHERE kind = 'import' AND name = 'Chidi Nwosu'").get();
  assert.ok(!row.code_hash.includes('88812'), 'codes are stored scrambled');
  assert.equal(row.code_hint, '12AB');
  assert.equal(row.tier_id, tier('Family'));
});
await test('the printed code from the other ticketer is checked at the gate like a Tap In pass, whatever the spacing or case', async () => {
  const r = await scan('tix 88812 ab');
  assert.equal(r.body.result, 'granted', JSON.stringify(r.body));
  assert.equal(r.body.holder, 'Chidi N.');
  assert.equal(r.body.tier, 'Family');
  assert.equal(r.body.guest, 'import');
  assert.equal((await scan('TIX-88812-AB')).body.reason, 'already_used');
  assert.equal((await scan('SYT-4455-7788', reception)).body.reason, 'no_zone_access', 'ceremony-only ticket at the reception');
  assert.equal((await scan('TIX-00000-ZZ')).body.reason, 'invalid_token');
});
await test('imported codes belong to one event: the same code at another event is not valid', async () => {
  const ev2 = (await other.post('/api/events', { name: 'Other Party', zones: ['Door'], tiers: [{ name: 'GA', zones: ['Door'] }] })).body;
  const r = await anon().post('/api/gate/scan', { token: 'tix-99001-cd', zone_id: ev2.zones[0].id }, { headers: { Authorization: 'Bearer ' + ev2.gate_key } });
  assert.equal(r.body.reason, 'invalid_token');
});
await test('Tap In passes still work alongside the guest list', async () => {
  const fan = await signIn(env, 'fan@guests.test', freshIp(), 'Fan Person');
  const code = (await org.post(`/api/events/${id}/invites`, { tier_id: tier('Guest'), count: 1 })).body.codes[0];
  const pass = (await fan.post('/api/claim', { code })).body.pass;
  assert.equal((await scan(pass.token)).body.result, 'granted');
});
await test('the report, overview and CSV count guests', async () => {
  const rep = (await org.get(`/api/events/${id}/report`)).body;
  assert.equal(rep.guest_list.invitations, 1);
  assert.equal(rep.guest_list.imported, 3);
  assert.equal(rep.guest_list.arrived, 2);
  assert.equal(rep.totals.issued, 1 + 3 + 1, 'one active invitation, three imported tickets, one Tap In pass');
  assert.equal(rep.totals.came, 3);
  const overview = (await org.get('/api/events/' + id)).body;
  assert.equal(overview.stats.registered, 5);
  assert.equal(overview.stats.checked_in, 3);
  assert.ok(overview.recent.some((s) => s.holder === 'Chidi Nwosu'));
  const csv = (await org.call('GET', `/api/events/${id}/scans.csv`, { raw: true })).body;
  assert.ok(csv.includes('Adaeze Okafor'));
  assert.ok(!csv.includes('+234'), 'no phone numbers in the export');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
