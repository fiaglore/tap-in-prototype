// Selfie-on-the-pass tests. Run with: node test/photos.mjs
import assert from 'node:assert/strict';
import { PEPPER, client, makeEnv, signIn } from './harness.mjs';
import { purge } from '../src/index.js';
import { passToken } from '../src/lib/codes.js';

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

// A tiny structurally valid JPEG (headers only is all the server inspects): SOI, JFIF, SOF0 of w x h, SOS, EOI.
function jpeg({ w = 256, h = 256, exif = false, padding = 0 } = {}) {
  const b = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  if (exif) b.push(0xff, 0xe1, 0, 10, 0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2);
  b.push(0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0);
  b.push(0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0);
  for (let i = 0; i < padding; i++) b.push(i & 127);
  b.push(0xff, 0xd9);
  return Buffer.from(b).toString('base64');
}
const GOOD = jpeg();
const dataUrl = (b64) => 'data:image/jpeg;base64,' + b64;

const env = makeEnv();
let org, ada, bola, gk, ev, tierId, zoneId;
const G = () => ({ headers: { Authorization: 'Bearer ' + gk } });
const mkEvent = async (extra = {}) => {
  const r = await org.post('/api/events', { name: 'Photo Fest', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'] }], allow_reentry: false, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const invite = async (e, count = 1) => (await org.post(`/api/events/${e.event.id}/invites`, { tier_id: e.tiers[0].id, count })).body.codes;
const scan = (e, token, ip = '10.50.9.1') => client(env, ip).post('/api/gate/scan', { token, zone_id: e.zones[0].id }, { headers: { Authorization: 'Bearer ' + e.gate_key } });

org = await signIn(env, 'boss@photo.test', '10.50.0.1', 'Pat Boss');
ada = await signIn(env, 'ada@photo.test', '10.50.0.2', 'Ada Okafor');
bola = await signIn(env, 'bola@photo.test', '10.50.0.3', 'Bola Ade');

group('Storing a photo');
await test('a person can add, read, replace and delete their own photo', async () => {
  assert.equal((await ada.get('/api/me/photo')).body.photo, null);
  assert.equal((await ada.get('/api/me')).body.user.has_photo, false);
  const put = await ada.call('PUT', '/api/me/photo', { body: { image: dataUrl(GOOD) } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const got = (await ada.get('/api/me/photo')).body;
  assert.equal(got.photo, dataUrl(GOOD));
  assert.equal((await ada.get('/api/me')).body.user.has_photo, true);
  assert.equal((await ada.call('PUT', '/api/me/photo', { body: { image: GOOD } })).status, 200); // bare base64 works too
  assert.equal((await ada.call('DELETE', '/api/me/photo')).status, 200);
  assert.equal((await ada.get('/api/me/photo')).body.photo, null);
});
await test('the photo routes need a signed-in user', async () => {
  const anon = client(env, '10.50.0.9');
  assert.equal((await anon.get('/api/me/photo')).status, 401);
  assert.equal((await anon.call('PUT', '/api/me/photo', { body: { image: GOOD } })).status, 401);
});
await test('bad uploads are refused: not a JPEG, junk, too big, wrong size, hidden metadata', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]).toString('base64');
  const cases = [
    [png, 'invalid_photo'], ['not base64 at all!!', 'invalid_photo'], ['', 'invalid_photo'], [12345, 'invalid_photo'], [null, 'invalid_photo'],
    [jpeg({ padding: 70_000 }), 'photo_too_large'], [jpeg({ w: 40, h: 40 }), 'photo_size'], [jpeg({ w: 4000, h: 4000 }), 'photo_size'],
    [jpeg({ exif: true }), 'photo_has_metadata'], [Buffer.from([0xff, 0xd8, 0xff]).toString('base64'), 'invalid_photo']
  ];
  const user = await signIn(env, 'strict@photo.test', '10.50.0.4');
  for (const [img, code] of cases) {
    const r = await user.call('PUT', '/api/me/photo', { body: { image: img } });
    assert.equal(r.status, 400, 'accepted ' + String(img).slice(0, 30));
    assert.equal(r.body.error.code, code, String(img).slice(0, 30));
  }
  assert.equal((await user.get('/api/me/photo')).body.photo, null);
});
await test('changing the photo over and over is rate limited', async () => {
  const user = await signIn(env, 'fickle@photo.test', '10.50.0.5');
  for (let i = 0; i < 6; i++) assert.equal((await user.call('PUT', '/api/me/photo', { body: { image: GOOD } })).status, 200);
  const r = await user.call('PUT', '/api/me/photo', { body: { image: GOOD } });
  assert.equal(r.status, 429);
});

group('Claiming a pass');
await test('an event that does not ask for a photo works as before, and the scan shows none', async () => {
  const e = await mkEvent();
  assert.equal(e.event.require_photo, false);
  const code = (await invite(e))[0];
  const pass = (await bola.post('/api/claim', { code })).body.pass;
  const s = await scan(e, pass.token);
  assert.equal(s.body.result, 'granted');
  assert.ok(!('photo' in s.body) && !('photo_missing' in s.body));
});
await test('offices ask for a photo by default; events do not; both can be set', async () => {
  const off = await org.post('/api/events', { kind: 'workplace', name: 'HQ', zones: ['Door'], tiers: [{ name: 'Staff', zones: ['Door'] }] });
  assert.equal(off.body.event.require_photo, true);
  const off2 = await org.post('/api/events', { kind: 'workplace', name: 'HQ2', require_photo: false, zones: ['Door'], tiers: [{ name: 'Staff', zones: ['Door'] }] });
  assert.equal(off2.body.event.require_photo, false);
  const e = await mkEvent({ require_photo: true });
  assert.equal(e.event.require_photo, true);
});
await test('claiming without a photo is refused with 428 and does NOT use up the invite', async () => {
  ev = await mkEvent({ require_photo: true });
  gk = ev.gate_key; tierId = ev.tiers[0].id;
  const [code] = await invite(ev);
  const r = await ada.post('/api/claim', { code });
  assert.equal(r.status, 428);
  assert.equal(r.body.error.code, 'photo_required');
  assert.equal(env.DB.raw.prepare("SELECT status FROM invites WHERE event_id = ? ").get(ev.event.id).status, 'unused');
  assert.equal((await ada.call('PUT', '/api/me/photo', { body: { image: dataUrl(GOOD) } })).status, 200);
  assert.equal((await ada.post('/api/claim', { code })).status, 201); // same code, now accepted
});
await test('buying a ticket on the public page needs the photo too', async () => {
  const e = await mkEvent({ require_photo: true });
  const buyer = await signIn(env, 'buyer@photo.test', '10.50.0.6', 'Buyer One');
  const r = await buyer.post(`/api/public/events/${e.event.id}/buy`, { tier_id: e.tiers[0].id });
  assert.equal(r.status, 428);
  assert.equal(r.body.error.code, 'photo_required');
  assert.equal((await client(env, '10.50.1.1').get(`/api/public/events/${e.event.id}`)).body.event.require_photo, true);
  await buyer.call('PUT', '/api/me/photo', { body: { image: GOOD } });
  assert.equal((await buyer.post(`/api/public/events/${e.event.id}/buy`, { tier_id: e.tiers[0].id })).status, 201);
});
await test('the app learns which passes need a photo, and whether it has one', async () => {
  const me = (await ada.get('/api/me')).body;
  assert.equal(me.user.has_photo, true);
  assert.equal(me.passes.find((p) => p.event.id === ev.event.id).event.require_photo, true);
});

group('At the gate');
let adaPass;
await test('the scan shows the face on file next to the name, and flags a brand-new photo', async () => {
  adaPass = (await ada.get('/api/me')).body.passes.find((p) => p.event.id === ev.event.id);
  const s = await scan(ev, adaPass.token);
  assert.equal(s.body.result, 'granted');
  assert.equal(s.body.holder, 'Ada O.');
  assert.equal(s.body.photo, dataUrl(GOOD));
  assert.equal(s.body.photo_new, true);
});
await test('an older photo is not flagged as new', async () => {
  env.DB.raw.prepare('UPDATE user_photos SET updated_at = ? WHERE user_id = (SELECT user_id FROM passes WHERE id = ?)').run(Math.floor(Date.now() / 1000) - 3 * 86400, adaPass.id);
  const s = await scan(ev, adaPass.token, '10.50.9.2');
  assert.equal(s.body.photo_new, false);
});
await test('a refused scan still shows the face: a shared screenshot is caught by the picture', async () => {
  const again = await scan(ev, adaPass.token, '10.50.9.3'); // re-entry is off, so this is "already used"
  assert.equal(again.body.result, 'denied');
  assert.equal(again.body.reason, 'already_used');
  assert.equal(again.body.photo, dataUrl(GOOD));
});
await test('a person with no photo on file is flagged rather than hidden', async () => {
  const e = await mkEvent({ require_photo: false });
  const [code] = await invite(e);
  const pass = (await bola.post('/api/claim', { code })).body.pass; // claimed while no photo was required
  await org.call('PATCH', '/api/events/' + e.event.id, { body: { require_photo: true } });
  const s = await scan(e, pass.token);
  assert.equal(s.body.result, 'granted');
  assert.equal(s.body.photo, null);
  assert.equal(s.body.photo_missing, true);
});
await test('a photo is never shown for an unknown, forged or other-event pass', async () => {
  const forged = await scan(ev, 'TP-AAAAA-AAAAA-AAAAA-AAAAA', '10.50.9.4');
  assert.ok(!forged.body.photo && !forged.body.photo_missing);
  const other = await mkEvent({ require_photo: true });
  const wrong = await client(env, '10.50.9.5').post('/api/gate/scan', { token: adaPass.token, zone_id: other.zones[0].id }, { headers: { Authorization: 'Bearer ' + other.gate_key } });
  assert.equal(wrong.body.reason, 'wrong_event');
  assert.ok(!wrong.body.photo && !wrong.body.photo_missing, 'another event must not see this person’s face');
});
await test('turning the setting off stops the photo being shown', async () => {
  const e = await mkEvent({ require_photo: true });
  const [code] = await invite(e);
  const pass = (await ada.post('/api/claim', { code })).body.pass;
  assert.ok((await scan(e, pass.token, '10.50.9.6')).body.photo);
  await org.call('PATCH', '/api/events/' + e.event.id, { body: { require_photo: false, allow_reentry: true } });
  assert.ok(!('photo' in (await scan(e, pass.token, '10.50.9.7')).body));
});

group('Privacy');
await test('the organiser sees whether a photo exists, never the picture; nobody else can read it', async () => {
  const list = (await org.get(`/api/events/${ev.event.id}/attendees`)).body.attendees;
  assert.ok(list.some((a) => a.has_photo === true));
  assert.ok(!JSON.stringify(list).includes(GOOD.slice(0, 40)));
  for (const path of [`/api/events/${ev.event.id}`, `/api/events/${ev.event.id}/scans`, '/api/me/history']) assert.ok(!JSON.stringify((await org.get(path)).body).includes(GOOD.slice(0, 40)), path);
  assert.ok(!JSON.stringify((await ada.get('/api/me')).body).includes(GOOD.slice(0, 40)), '/api/me must not carry the picture');
  assert.equal((await bola.get('/api/me/photo')).body.photo, null); // bola's own, not ada's
});
await test('deleting the photo removes it, and later scans show it is missing', async () => {
  await ada.call('DELETE', '/api/me/photo');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM user_photos WHERE user_id = (SELECT user_id FROM passes WHERE id = ?)').get(adaPass.id).n, 0);
  const e = await mkEvent({ require_photo: true, allow_reentry: true });
  await ada.call('PUT', '/api/me/photo', { body: { image: GOOD } });
  const [code] = await invite(e);
  const pass = (await ada.post('/api/claim', { code })).body.pass;
  await ada.call('DELETE', '/api/me/photo');
  assert.equal((await scan(e, pass.token, '10.50.9.8')).body.photo_missing, true);
});
await test('the daily clean-up drops stale photos nobody needs, and keeps ones still in use', async () => {
  const old = Math.floor(Date.now() / 1000) - 60 * 86400;
  const stale = await signIn(env, 'stale@photo.test', '10.50.0.7');
  await stale.call('PUT', '/api/me/photo', { body: { image: GOOD } });
  const keep = await signIn(env, 'keep@photo.test', '10.50.0.8');
  await keep.call('PUT', '/api/me/photo', { body: { image: GOOD } });
  const office = await org.post('/api/events', { kind: 'workplace', name: 'Keep HQ', zones: ['Door'], tiers: [{ name: 'Staff', zones: ['Door'] }] });
  await org.post(`/api/events/${office.body.event.id}/people`, { tier_id: office.body.tiers[0].id, people: [{ contact: 'keep@photo.test' }] });
  const wait = (await keep.get('/api/me')).body.waiting[0];
  assert.equal((await keep.post('/api/claim', { invite_id: wait.id })).status, 201);
  env.DB.raw.prepare("UPDATE user_photos SET updated_at = ? WHERE user_id IN (SELECT id FROM users WHERE email IN ('stale@photo.test','keep@photo.test'))").run(old);
  await purge(env);
  assert.equal((await stale.get('/api/me/photo')).body.photo, null, 'stale photo should be gone');
  assert.ok((await keep.get('/api/me/photo')).body.photo, 'photo of someone with an active office pass must stay');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('Failed: ' + failures.join('; '));
  process.exit(1);
}
