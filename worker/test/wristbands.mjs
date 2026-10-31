// Wristbands for confirmed guests: one per person, only for people who replied yes or hold a pass or imported
// ticket; the original code stops admitting once wristbands exist. Run with: node test/wristbands.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';
import { guestToken } from '../src/lib/codes.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const group = (t) => console.log('\n' + t);

const env = makeEnv();
let ipN = 1;
const freshIp = () => '10.91.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const anon = () => client(env, freshIp());
const org = await signIn(env, 'host@wristbands.test', '10.91.200.1', 'Hosting Person');
const other = await signIn(env, 'other@wristbands.test', '10.91.200.2', 'Other Host');
const fan = await signIn(env, 'fan@wristbands.test', '10.91.200.3', 'Fan Holder');

const ev = (await org.post('/api/events', { name: 'Tolu & Ada Wedding', zones: ['Entrance', 'Reception'], tiers: [{ name: 'Guest', zones: ['Entrance', 'Reception'] }, { name: 'Ceremony only', zones: ['Entrance'] }], listed: false })).body;
const id = ev.event.id;
const entrance = ev.zones.find((z) => z.name === 'Entrance').id;
const reception = ev.zones.find((z) => z.name === 'Reception').id;
const tier = (n) => ev.tiers.find((t) => t.name === n).id;
const scan = (token, zone = entrance) => anon().post('/api/gate/scan', { token, zone_id: zone }, { headers: { Authorization: 'Bearer ' + ev.gate_key } });
const tokenOf = (link) => link.split('#')[1];
const people = async () => (await org.get(`/api/events/${id}/wristbands`)).body.people;
const make = (list) => org.post(`/api/events/${id}/wristbands`, { people: list });
const find = (list, name) => list.find((p) => p.name === name);

// Guests: Adaeze says yes for 3, Bayo says no, Chidi has not replied; a fan holds a pass; one ticket was imported.
const inv = (await org.post(`/api/events/${id}/guests`, { tier_id: tier('Guest'), guests: [
  { name: 'Adaeze Okafor', contact: '0803 412 7790', party_size: 4, table: 'Table 4' },
  { name: 'Bayo Ade', contact: 'bayo@example.com' },
  { name: 'Chidi Nwosu' },
  { name: 'Ngozi Eze', party_size: 2 }
] })).body.added;
const g = (name) => inv.find((x) => x.name === name);
await anon().post('/api/invitation/rsvp', { token: tokenOf(g('Adaeze Okafor').link), response: 'yes', attending: 3 });
await anon().post('/api/invitation/rsvp', { token: tokenOf(g('Bayo Ade').link), response: 'no' });
await anon().post('/api/invitation/rsvp', { token: tokenOf(g('Ngozi Eze').link), response: 'yes', attending: 1 });
const passCode = (await org.post(`/api/events/${id}/invites`, { tier_id: tier('Guest'), count: 1 })).body.codes[0];
const pass = (await fan.post('/api/claim', { code: passCode })).body.pass;
await org.post(`/api/events/${id}/guests/import`, { tier_id: tier('Ceremony only'), rows: [{ code: 'TIX-88812-AB', name: 'Dayo Bello' }] });

group('Who can have wristbands');
await test('only confirmed people are listed: yes replies (with their party), pass holders and imported tickets', async () => {
  const list = await people();
  assert.deepEqual(list.map((p) => p.name).sort(), ['Adaeze Okafor', 'Dayo Bello', 'Fan Holder', 'Ngozi Eze']);
  assert.equal(find(list, 'Adaeze Okafor').seats, 3, 'the number who said they are coming, not the number invited');
  assert.equal(find(list, 'Adaeze Okafor').table, 'Table 4');
  assert.equal(find(list, 'Fan Holder').source, 'Tap In pass');
  assert.equal(find(list, 'Dayo Bello').source, 'Imported ticket');
  assert.ok(list.every((p) => p.made === 0 && !p.entered));
});
await test('people who said no or have not replied are refused, and nothing is made', async () => {
  for (const name of ['Bayo Ade', 'Chidi Nwosu']) {
    const r = await make([{ kind: 'guest', id: g(name).id }]);
    assert.equal(r.status, 400, name);
    assert.equal(r.body.error.code, 'not_confirmed');
  }
  assert.equal((await make([{ kind: 'guest', id: 'NOSUCHGUEST' }])).body.error.code, 'not_confirmed');
  assert.equal((await make([{ kind: 'pass', id: g('Adaeze Okafor').id }])).body.error.code, 'not_confirmed', 'wrong kind');
  assert.equal((await make([])).status, 400);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM guests WHERE wristband_of IS NOT NULL').get().n, 0);
});
await test('the old anonymous batch is gone: there is no way to make wristbands for nobody in particular', async () => {
  const r = await org.post(`/api/events/${id}/wristbands`, { tier_id: tier('Guest'), count: 50 });
  assert.equal(r.status, 400);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM guests WHERE wristband_of IS NOT NULL').get().n, 0);
});
await test('only the organiser of the event can see or make wristbands', async () => {
  assert.ok([403, 404].includes((await other.get(`/api/events/${id}/wristbands`)).status));
  assert.ok([403, 404].includes((await other.post(`/api/events/${id}/wristbands`, { people: [{ kind: 'guest', id: g('Adaeze Okafor').id }] })).status));
  assert.equal((await anon().post(`/api/events/${id}/wristbands`, { people: [] })).status, 401);
});

group('A party gets one wristband each');
let adaeze;
await test('a party of 3 gets 3 wristbands with their name and table, each its own code', async () => {
  const r = await make([{ kind: 'guest', id: g('Adaeze Okafor').id }]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  adaeze = r.body.wristbands;
  assert.equal(adaeze.length, 3);
  assert.deepEqual(adaeze.map((w) => w.seat), [1, 2, 3]);
  for (const w of adaeze) {
    assert.equal(w.name, 'Adaeze Okafor'); assert.equal(w.table, 'Table 4'); assert.equal(w.tier, 'Guest'); assert.equal(w.seats, 3);
    assert.match(w.code, /^WB[0-9A-HJKMNP-TV-Z]{10}$/);
  }
  assert.equal(new Set(adaeze.map((w) => w.code)).size, 3);
});
await test('reprinting gives the same codes and makes nothing new', async () => {
  const before = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
  const again = (await make([{ kind: 'guest', id: g('Adaeze Okafor').id }])).body.wristbands;
  assert.deepEqual(again.map((w) => w.code), adaeze.map((w) => w.code));
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM guests').get().n, before);
});
await test('no plain code is stored: only scrambled hashes', async () => {
  const dump = JSON.stringify(env.DB.raw.prepare('SELECT * FROM guests WHERE wristband_of IS NOT NULL').all());
  for (const w of adaeze) assert.ok(!dump.includes(w.code));
});
await test('each wristband lets one person in once per area; a copy of the same one is refused', async () => {
  const a = await scan(adaeze[0].code);
  assert.equal(a.body.result, 'granted', JSON.stringify(a.body));
  assert.equal(a.body.holder, 'Adaeze O.');
  assert.equal(a.body.party, 1, 'one person per wristband');
  assert.equal(a.body.table, 'Table 4');
  const copy = await scan(adaeze[0].code);
  assert.equal(copy.body.result, 'denied');
  assert.equal(copy.body.reason, 'already_used');
  assert.equal((await scan(adaeze[1].code)).body.result, 'granted');
  assert.equal((await scan(adaeze[2].code)).body.result, 'granted');
  assert.equal((await scan(adaeze[2].code, reception)).body.result, 'granted', 'the other area is a separate entry');
});
await test('the printed form works at the gate: any case, spaces or dashes', async () => {
  const c = adaeze[1].code;
  const printed = `${c.slice(0, 2)}-${c.slice(2, 7)}-${c.slice(7)}`.toLowerCase();
  assert.equal((await scan(printed, reception)).body.result, 'granted');
});

group('The original code stops admitting');
await test('the phone invitation of someone with wristbands is refused with a clear message', async () => {
  const tg = await guestToken(env.SECRET_PEPPER, g('Adaeze Okafor').id);
  const r = await scan(tg, reception);
  assert.equal(r.body.result, 'denied');
  assert.equal(r.body.reason, 'use_wristband');
  assert.match(r.body.message, /wristband/i);
});
await test('a pass holder gets one wristband, and their pass stops admitting', async () => {
  const r = await make([{ kind: 'pass', id: pass.id }]);
  assert.equal(r.status, 201);
  const [w] = r.body.wristbands;
  assert.equal(r.body.wristbands.length, 1);
  assert.equal(w.name, 'Fan Holder');
  const viaPass = await scan(pass.token);
  assert.equal(viaPass.body.reason, 'use_wristband');
  const viaBand = await scan(w.code);
  assert.equal(viaBand.body.result, 'granted');
  assert.equal(viaBand.body.holder, 'Fan H.');
});
await test('an imported ticket gets a wristband, and its old printed code stops admitting', async () => {
  const [w] = (await make([{ kind: 'guest', id: find(await people(), 'Dayo Bello').id }])).body.wristbands;
  assert.equal(w.tier, 'Ceremony only');
  assert.equal((await scan('TIX-88812-AB')).body.reason, 'use_wristband');
  assert.equal((await scan(w.code)).body.result, 'granted');
  assert.equal((await scan(w.code, reception)).body.reason, 'no_zone_access', 'the ticket type still decides the areas');
});
await test('people who have wristbands are not offered again unless they are missing some', async () => {
  const list = await people();
  assert.equal(find(list, 'Adaeze Okafor').made, 3);
  assert.equal(find(list, 'Ngozi Eze').made, 0);
});

group('Replacing a lost wristband');
let ngozi;
await test('a cancelled wristband stops working, and the next call gives that seat a new code', async () => {
  ngozi = (await make([{ kind: 'guest', id: g('Ngozi Eze').id }])).body.wristbands;
  assert.equal(ngozi.length, 1);
  const list = (await org.get(`/api/events/${id}/guests`)).body.guests;
  const band = list.find((x) => x.wristband_of === g('Ngozi Eze').id);
  assert.ok(band, 'the wristband shows in the guest list');
  assert.equal(band.name, 'Ngozi Eze');
  assert.equal((await org.post(`/api/events/${id}/guests/${band.id}/revoke`, {})).status, 200);
  assert.equal((await scan(ngozi[0].code)).body.reason, 'revoked');
  const fresh = (await make([{ kind: 'guest', id: g('Ngozi Eze').id }])).body.wristbands;
  assert.equal(fresh.length, 1);
  assert.notEqual(fresh[0].code, ngozi[0].code);
  assert.equal((await scan(fresh[0].code)).body.result, 'granted');
});

group('Counts, report and offline list');
await test('a party is counted once per person, never twice (the original ticket is not counted with its wristbands)', async () => {
  const rep = (await org.get(`/api/events/${id}/report`)).body;
  // Active people: Adaeze x3, Fan, Dayo, Ngozi (new wristband) + Bayo, Chidi (invitations, not wristbanded)
  assert.equal(rep.totals.issued, 3 + 1 + 1 + 1 + 2, JSON.stringify(rep.totals));
  assert.equal(rep.guest_list.wristbands, 6, 'active wristbands: 3 + 1 + 1 + 1 (the lost one is cancelled)');
  assert.equal(rep.guest_list.imported, 1, 'the original imported ticket is still one imported ticket; its wristband is not another');
  assert.equal(rep.totals.came, 6);
  const overview = (await org.get('/api/events/' + id)).body;
  assert.equal(overview.stats.registered, rep.totals.issued);
});
await test('the guest list counts wristbands separately from imported tickets', async () => {
  const r = (await org.get(`/api/events/${id}/guests`)).body;
  assert.equal(r.summary.imported, 1);
  assert.ok(r.summary.wristbands >= 6);
});
await test('the offline scanner list tells scanners which tickets are replaced by wristbands', async () => {
  const list = (await anon().get('/api/gate/list', { headers: { Authorization: 'Bearer ' + ev.gate_key } })).body;
  assert.equal(list.guests.find((x) => x.id === g('Adaeze Okafor').id).wristbanded, true);
  assert.equal(list.passes.find((x) => x.id === pass.id).wristbanded, true);
  assert.equal(list.guests.find((x) => x.id === g('Bayo Ade').id).wristbanded, false);
  assert.ok(list.guests.filter((x) => x.code_hash && x.wristbanded === false).length >= 6, 'wristband rows are in the list with their code hashes');
});

group('Edge cases');
await test('someone already inside cannot be given a wristband', async () => {
  const e2 = (await org.post('/api/events', { name: 'Second Night', zones: ['Door'], tiers: [{ name: 'Entry', zones: ['Door'] }], listed: false })).body;
  const c = (await org.post(`/api/events/${e2.event.id}/invites`, { tier_id: e2.tiers[0].id, count: 1 })).body.codes[0];
  const p = (await fan.post('/api/claim', { code: c })).body.pass;
  await anon().post('/api/gate/scan', { token: p.token, zone_id: e2.zones[0].id }, { headers: { Authorization: 'Bearer ' + e2.gate_key } });
  const r = await org.post(`/api/events/${e2.event.id}/wristbands`, { people: [{ kind: 'pass', id: p.id }] });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'already_entered');
});
await test('offices do not use wristbands', async () => {
  const off = (await org.post('/api/events', { kind: 'workplace', name: 'HQ Office', zones: ['Front door'], tiers: [{ name: 'Staff', zones: ['Front door'] }] })).body;
  assert.equal((await org.get(`/api/events/${off.event.id}/wristbands`)).status, 400);
  assert.equal((await org.post(`/api/events/${off.event.id}/wristbands`, { people: [{ kind: 'pass', id: 'X' }] })).status, 400);
});
await test('one person asked for twice in one call gets one set', async () => {
  const e3 = (await org.post('/api/events', { name: 'Third Night', zones: ['Door'], tiers: [{ name: 'Entry', zones: ['Door'] }], listed: false })).body;
  const [x] = (await org.post(`/api/events/${e3.event.id}/guests`, { tier_id: e3.tiers[0].id, guests: [{ name: 'Twice Asked', party_size: 2 }] })).body.added;
  await anon().post('/api/invitation/rsvp', { token: tokenOf(x.link), response: 'yes', attending: 2 });
  const r = await org.post(`/api/events/${e3.event.id}/wristbands`, { people: [{ kind: 'guest', id: x.id }, { kind: 'guest', id: x.id }] });
  assert.equal(r.body.wristbands.length, 2);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
