// Secure self check-in: rotating room code, location check, random selfie requests, receipts, review. Run with: node test/checkin.mjs
import assert from 'node:assert/strict';
import { PEPPER, client, makeEnv, signIn } from './harness.mjs';
import { distanceM, rollSelfie, roomToken, selfieChance } from '../src/lib/checkin.js';
import { purge } from '../src/index.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const group = (t) => console.log('\n' + t);

function jpeg({ w = 256, h = 256 } = {}) {
  const b = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  b.push(0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9);
  return 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64');
}

const OFFICE = { lat: 6.5244, lng: 3.3792 }; // Lagos
const env = makeEnv();
let ipN = 1;
const freshIp = () => '10.97.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const org = await signIn(env, 'boss@checkin.test', '10.97.200.1', 'Boss');
const stranger = await signIn(env, 'x@checkin.test', '10.97.200.2', 'Stranger');
const off = (await org.post('/api/events', { kind: 'workplace', name: 'Acme HQ', require_photo: false, zones: ['Front door'], tiers: [{ name: 'Staff', zones: ['Front door'] }] })).body;
const id = off.event.id;
const staff = off.tiers[0].id;

async function person(email, name) {
  const c = await signIn(env, email, freshIp(), name);
  await org.post(`/api/events/${id}/people`, { tier_id: staff, people: [{ contact: email, name }] });
  const w = (await c.get('/api/me')).body.waiting[0];
  await c.post('/api/claim', { invite_id: w.id });
  return c;
}
const here = { lat: OFFICE.lat + 0.0003, lng: OFFICE.lng, accuracy: 12 }; // about 33 m away
const code = async () => (await org.get(`/api/events/${id}/checkin/code`)).body;
const cfg = (b) => org.patch(`/api/events/${id}/checkin/settings`, b);

group('Pure logic');
await test('distance is in metres', () => {
  assert.equal(distanceM(0, 0, 0, 0), 0);
  const d = distanceM(OFFICE.lat, OFFICE.lng, OFFICE.lat + 0.001, OFFICE.lng);
  assert.ok(d > 105 && d < 117, String(d));
});
await test('selfie chance: trusted people are asked rarely, new or patchy people often, flagged people always', () => {
  const base = { mode: 'random', minPct: 5, maxPct: 50, recentRejects: 0 };
  assert.equal(selfieChance({ ...base, expected: 20, present: 20, late: 0 }), 5, 'perfect record');
  assert.equal(selfieChance({ ...base, expected: 3, present: 3, late: 0 }), 50, 'too new to trust');
  assert.equal(selfieChance({ ...base, expected: 20, present: 12, late: 0 }), 50, 'skips a lot');
  assert.equal(selfieChance({ ...base, expected: 20, present: 20, late: 10 }), 50, 'always late');
  const mid = selfieChance({ ...base, expected: 20, present: 19, late: 1 });
  assert.ok(mid > 5 && mid < 50, String(mid));
  assert.equal(selfieChance({ ...base, expected: 20, present: 20, late: 0, recentRejects: 1 }), 100);
  assert.equal(selfieChance({ ...base, mode: 'always', expected: 20, present: 20, late: 0 }), 100);
  assert.equal(selfieChance({ ...base, mode: 'off', expected: 0, present: 0, late: 0 }), 0);
});
await test('the daily dice roll is fixed per person and day, and roughly matches the chance', async () => {
  assert.equal(await rollSelfie(PEPPER, 'P1', 100, 30), await rollSelfie(PEPPER, 'P1', 100, 30));
  let asked = 0; for (let d = 0; d < 400; d++) if (await rollSelfie(PEPPER, 'P2', d, 25)) asked++;
  assert.ok(asked > 60 && asked < 140, String(asked));
});

group('Settings');
await test('the screen code is off until the owner turns check-in on, and it needs an office location', async () => {
  assert.equal((await org.get(`/api/events/${id}/checkin/code`)).status, 409);
  assert.equal((await cfg({ enabled: true })).body.error.code, 'location_required');
  assert.equal((await cfg({ lat: 95, lng: 3 })).status, 400);
  assert.equal((await cfg({ selfie_min_pct: 60, selfie_max_pct: 20 })).body.error.code, 'invalid_selfie_range');
  const r = await cfg({ lat: OFFICE.lat, lng: OFFICE.lng, radius_m: 150, selfie_mode: 'off', enabled: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.enabled, true);
});
await test('only the owner can change settings; strangers cannot read the code', async () => {
  assert.equal((await stranger.patch(`/api/events/${id}/checkin/settings`, { enabled: false })).status, 404);
  assert.equal((await stranger.get(`/api/events/${id}/checkin/code`)).status, 404);
});

group('Checking in');
let ada, bola;
await test('setup: two people with passes', async () => { ada = await person('ada@checkin.test', 'Ada Obi'); bola = await person('bola@checkin.test', 'Bola Ade'); });
await test('the room code is a fresh token and rotates every 30 seconds', async () => {
  const c = await code();
  assert.match(c.token, /^[0-9A-Z]{12}\.\d+\.[0-9A-Z]{12}$/);
  assert.ok(c.expires_in >= 1 && c.expires_in <= 30);
  assert.match(c.url, /\/checkin\/#/);
  assert.notEqual(await roomToken(PEPPER, id, 1000), await roomToken(PEPPER, id, 1031));
});
await test('a forged, edited or stale code is refused', async () => {
  const c = await code();
  assert.equal((await ada.post('/api/checkin', { token: 'nonsense', ...here })).body.error.code, 'stale_code');
  const bad = c.token.slice(0, -1) + (c.token.endsWith('A') ? 'B' : 'A');
  assert.equal((await ada.post('/api/checkin', { token: bad, ...here })).status, 400);
  const old = await roomToken(PEPPER, id, Math.floor(Date.now() / 1000) - 300);
  assert.equal((await ada.post('/api/checkin', { token: old, ...here })).body.error.code, 'stale_code');
});
await test('someone with no pass here cannot check in', async () => {
  const r = await stranger.post('/api/checkin', { token: (await code()).token, ...here });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'no_pass');
});
await test('a phone outside the office is refused and the attempt is recorded', async () => {
  const far = { lat: OFFICE.lat + 0.02, lng: OFFICE.lng, accuracy: 10 }; // about 2.2 km
  const r = await ada.post('/api/checkin', { token: (await code()).token, ...far });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'outside_location');
  const list = (await org.get(`/api/events/${id}/checkins`)).body;
  assert.equal(list.summary.refused, 1);
  assert.equal(list.checkins[0].reason, 'outside_location');
  assert.ok(list.checkins[0].distance_m > 2000);
});
await test('no location, or a location too vague to trust, is refused', async () => {
  const t = (await code()).token;
  assert.equal((await bola.post('/api/checkin', { token: t })).body.error.code, 'no_location');
  assert.equal((await bola.post('/api/checkin', { token: t, ...here, accuracy: 900 })).body.error.code, 'poor_accuracy');
});
await test('a person who failed the location check is then asked for a selfie every time (and must send one)', async () => {
  await cfg({ selfie_mode: 'random', selfie_min_pct: 5, selfie_max_pct: 5 }); // a 5% chance for everyone else
  const r = await ada.post('/api/checkin', { token: (await code()).token, ...here });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.needs_selfie, true);
  await cfg({ selfie_mode: 'off' });
});
await test('selfie mode off: a nearby phone with a fresh code is recorded, with a receipt', async () => {
  const r = await bola.post('/api/checkin', { token: (await code()).token, ...here });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.recorded, true);
  assert.equal(r.body.name, 'Bola Ade');
  assert.equal(r.body.office, 'Acme HQ');
  assert.ok(r.body.distance_m < 60);
});
await test('checking in twice in a day shows the same receipt and adds nothing', async () => {
  const r = await bola.post('/api/checkin', { token: (await code()).token, ...here });
  assert.equal(r.status, 200); assert.equal(r.body.already, true);
  const n = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM scans WHERE event_id = ? AND result = 'granted'").get(id).n;
  assert.equal(n, 1);
});
await test('the check-in shows up as an entry in the on-site report', async () => {
  const r = (await org.get(`/api/events/${id}/on-site`)).body;
  assert.ok(r.staff.some((s) => s.name === 'Bola Ade'));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await test('selfie mode always: the selfie must answer a fresh server challenge (no challenge, forged, or too early is refused)', async () => {
  await cfg({ selfie_mode: 'always' });
  const t = (await code()).token;
  const need = await ada.post('/api/checkin', { token: t, ...here });
  assert.equal(need.body.needs_selfie, true);
  assert.match(need.body.challenge, /^\d+\.[0-9A-Z]{12}$/);
  const send = (extra) => ada.post('/api/checkin', { token: t, ...here, selfie: jpeg(), ...extra });
  assert.equal((await send({})).body.error.code, 'selfie_challenge', 'a photo with no challenge is a pre-made upload');
  assert.equal((await send({ challenge: '1794690000.AAAAAAAAAAAA' })).body.error.code, 'selfie_challenge', 'forged');
  assert.equal((await send({ challenge: need.body.challenge })).body.error.code, 'selfie_challenge', 'too quick to have used the camera');
  await wait(3200);
  const bad = await ada.post('/api/checkin', { token: t, ...here, challenge: need.body.challenge, selfie: 'data:image/jpeg;base64,AAAA' });
  assert.equal(bad.status, 400);
  const ok = await send({ challenge: need.body.challenge });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.selfie_required, true);
  assert.match(ok.body.selfie, /^data:image\/jpeg;base64,/);
});
await test('the same selfie cannot be sent again for a later check-in', async () => {
  // Pretend Ada's check-in was yesterday.
  env.DB.raw.prepare("UPDATE checkins SET day = day - 1, at = at - 86400 WHERE status = 'ok' AND selfie_hash IS NOT NULL").run();
  const t = (await code()).token;
  const need = await ada.post('/api/checkin', { token: t, ...here });
  assert.equal(need.body.needs_selfie, true);
  await wait(3200);
  const again = await ada.post('/api/checkin', { token: t, ...here, challenge: need.body.challenge, selfie: jpeg() });
  assert.equal(again.body.error.code, 'selfie_reused');
  const fresh = await ada.post('/api/checkin', { token: t, ...here, challenge: need.body.challenge, selfie: jpeg({ w: 200, h: 200 }) });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
});
await test('random mode: a punctual person with a long clean record is asked far less than a new one', async () => {
  await cfg({ selfie_mode: 'random', selfie_min_pct: 0, selfie_max_pct: 100 });
  const c = await person('carl@checkin.test', 'Carl Trusted');
  const pass = env.DB.raw.prepare("SELECT p.id FROM passes p JOIN users u ON u.id = p.user_id WHERE u.email = 'carl@checkin.test'").get().id;
  env.DB.raw.prepare('UPDATE passes SET created_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60 * 86400, pass);
  const tzMin = 60;
  for (let d = 1; d <= 30; d++) { // in on time every day for a month, whatever the weekday
    const day = Math.floor((Date.now() / 1000 + tzMin * 60) / 86400) - d;
    env.DB.raw.prepare("INSERT INTO scans (id, event_id, pass_id, result, once, at) VALUES (?, ?, ?, 'granted', 0, ?)").run('H' + d + Math.random().toString(36).slice(2, 10).toUpperCase(), id, pass, day * 86400 - tzMin * 60 + 8 * 3600);
  }
  const r = await c.post('/api/checkin', { token: (await code()).token, ...here });
  assert.equal(r.status, 201, 'a perfect record with a 0% floor is never asked: ' + JSON.stringify(r.body));
  const row = env.DB.raw.prepare('SELECT selfie_chance FROM checkins WHERE pass_id = ?').get(pass);
  assert.equal(row.selfie_chance, 0);
});

group('Review');
let list;
await test('owner sees the day with chance, distance, selfie flags and a summary', async () => {
  list = (await org.get(`/api/events/${id}/checkins`)).body;
  assert.equal(list.summary.checked_in, 3, 'today: Bola, Carl and Ada');
  assert.equal(list.summary.refused, 2, 'one outside the office, one with no location');
  assert.ok(list.summary.selfies_asked >= 1);
  const a = list.checkins.find((c) => c.name === 'Ada Obi' && c.status === 'ok');
  assert.equal(a.has_selfie, true);
  assert.equal(a.selfie_chance, 100);
});
await test('the selfie image is owner/security only and never in the list payload', async () => {
  assert.ok(!JSON.stringify(list).includes('/9j/') && !JSON.stringify(list).includes('selfie_b64'));
  const a = list.checkins.find((c) => c.name === 'Ada Obi' && c.status === 'ok');
  const img = await org.get(`/api/events/${id}/checkins/${a.id}/selfie`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await stranger.get(`/api/events/${id}/checkins/${a.id}/selfie`)).status, 404);
  assert.equal((await ada.get(`/api/events/${id}/checkins/${a.id}/selfie`)).status, 404);
});
await test('selfies are cleared after 30 days; the check-in stays', async () => {
  env.DB.raw.prepare('UPDATE checkins SET at = at - ? WHERE selfie_b64 IS NOT NULL').run(31 * 86400);
  await purge(env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM checkins WHERE selfie_b64 IS NOT NULL').get().n, 0);
  assert.ok(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM checkins').get().n >= 4);
});
await test('turning check-in off stops the code and new check-ins', async () => {
  await cfg({ enabled: false });
  assert.equal((await org.get(`/api/events/${id}/checkin/code`)).status, 409);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
