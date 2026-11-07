// Tap In for Business: departments, employee IDs, visitor check-out, on-site list, incidents, team access.
// Run with: node test/business.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const env = makeEnv();
const db = env.DB.raw;
let ipN = 1;
const freshIp = () => '10.130.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const org = await signIn(env, 'owner@biz.test', freshIp(), 'Owner');
const off = (await org.post('/api/events', { kind: 'workplace', name: 'Biz HQ', require_photo: false, zones: ['Front', 'Lab'], tiers: [{ name: 'Staff', zones: ['Front', 'Lab'] }, { name: 'Visitors', zones: ['Front'] }] })).body;
const id = off.event.id;
const front = off.zones.find((z) => z.name === 'Front').id;
const staffTier = off.tiers.find((t) => t.name === 'Staff').id;
const visTier = off.tiers.find((t) => t.name === 'Visitors').id;
const desk = (await org.post(`/api/events/${id}/stewards`, { name: 'Desk' })).body;
const scanAs = (token) => client(env, freshIp()).post('/api/gate/scan', { token, zone_id: front }, { headers: { Authorization: 'Bearer ' + desk.key } });
const today = () => new Date().toISOString().slice(0, 10);

async function person(email, name, extra = {}) {
  const c = await signIn(env, email, freshIp(), name);
  const r = await org.post(`/api/events/${id}/people`, { tier_id: staffTier, people: [{ contact: email, name, ...extra }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const w = (await c.get('/api/me')).body.waiting[0];
  await c.post('/api/claim', { invite_id: w.id });
  return { c, passId: (await c.get('/api/me')).body.passes[0].id, r };
}

console.log('\nDepartments and employee IDs');
let eng, fin;
await test('the owner creates, renames and removes departments; names are unique; others cannot', async () => {
  eng = (await org.post(`/api/events/${id}/departments`, { name: 'Engineering' })).body.department;
  fin = (await org.post(`/api/events/${id}/departments`, { name: 'Finance' })).body.department;
  assert.equal((await org.post(`/api/events/${id}/departments`, { name: 'engineering' })).status, 409);
  assert.equal((await org.patch(`/api/events/${id}/departments/${fin.id}`, { name: 'Finance & Ops' })).status, 200);
  const stranger = await signIn(env, 'stranger@biz.test', freshIp(), 'S');
  assert.equal((await stranger.post(`/api/events/${id}/departments`, { name: 'X' })).status, 404);
  const tmp = (await org.post(`/api/events/${id}/departments`, { name: 'Temp' })).body.department;
  assert.equal((await org.call('DELETE', `/api/events/${id}/departments/${tmp.id}`)).status, 200);
  assert.equal((await org.get(`/api/events/${id}/departments`)).body.departments.length, 2);
});
let ada, bola;
await test('people are added with a department and employee ID, which show on the access list', async () => {
  ada = await person('ada@biz.test', 'Ada Obi', { department_id: eng.id, employee_ref: 'E-100' });
  bola = await person('bola@biz.test', 'Bola Ade', {});
  const list = (await org.get(`/api/events/${id}/attendees`)).body.attendees;
  const a = list.find((x) => x.name === 'Ada Obi');
  assert.equal(a.department, 'Engineering'); assert.equal(a.employee_ref, 'E-100');
  assert.equal(list.find((x) => x.name === 'Bola Ade').department, null);
  const bad = await org.post(`/api/events/${id}/people`, { tier_id: staffTier, people: [{ contact: 'cy@biz.test', department_id: 'nope' }] });
  assert.equal(bad.body.skipped[0].reason, 'That department does not exist.');
});
await test('a department and ID can be set or cleared later, for people with a pass or still waiting', async () => {
  assert.equal((await org.post(`/api/events/${id}/people/profile`, { pass_id: bola.passId, department_id: fin.id, employee_ref: 'E-200' })).status, 200);
  assert.equal((await org.get(`/api/events/${id}/attendees`)).body.attendees.find((x) => x.name === 'Bola Ade').department, 'Finance & Ops');
  assert.equal((await org.post(`/api/events/${id}/people/profile`, { pass_id: bola.passId, department_id: null })).status, 200);
  assert.equal((await org.get(`/api/events/${id}/attendees`)).body.attendees.find((x) => x.name === 'Bola Ade').department, null);
  assert.equal((await org.post(`/api/events/${id}/people/profile`, { pass_id: bola.passId, department_id: 'nope' })).status, 400);
  assert.equal((await org.post(`/api/events/${id}/people/profile`, { pass_id: 'nope' })).status, 404);
  await org.post(`/api/events/${id}/people`, { tier_id: staffTier, people: [{ contact: 'wait@biz.test', name: 'Waiting' }] });
  const inv = db.prepare("SELECT id FROM invites WHERE bound_identifier = 'wait@biz.test'").get();
  assert.equal((await org.post(`/api/events/${id}/people/profile`, { invite_id: inv.id, department_id: eng.id })).status, 200);
});
await test('deleting a department leaves its people with no department', async () => {
  const d = (await org.post(`/api/events/${id}/departments`, { name: 'Ops' })).body.department;
  await org.post(`/api/events/${id}/people/profile`, { pass_id: bola.passId, department_id: d.id });
  await org.call('DELETE', `/api/events/${id}/departments/${d.id}`);
  assert.equal((await org.get(`/api/events/${id}/attendees`)).body.attendees.find((x) => x.name === 'Bola Ade').department, null);
});
await test('attendance can be filtered and rolled up by department, and the CSV carries them', async () => {
  const at = Math.floor(Date.now() / 1000);
  for (const [p, n] of [[ada.passId, 1], [bola.passId, 1]]) db.prepare("INSERT INTO scans (id, event_id, pass_id, zone_id, result, once, at) VALUES (?, ?, ?, ?, 'granted', 0, ?)").run('S' + n + p, id, p, front, at);
  await org.post(`/api/events/${id}/people/profile`, { pass_id: bola.passId, department_id: fin.id });
  const all = (await org.get(`/api/events/${id}/attendance?from=${today()}&to=${today()}`)).body;
  assert.deepEqual(all.by_department.map((d) => d.department).sort(), ['Engineering', 'Finance & Ops']);
  const onlyEng = (await org.get(`/api/events/${id}/attendance?from=${today()}&to=${today()}&department=Engineering`)).body;
  assert.deepEqual(onlyEng.people.map((p) => p.name), ['Ada Obi']);
  assert.equal(onlyEng.people[0].employee_ref, 'E-100');
  const csv = await org.get(`/api/events/${id}/attendance.csv?type=summary&from=${today()}&to=${today()}`);
  assert.match(csv.body.split('\r\n')[0], /^Name,Phone or email,Group,.*,Access,Employee ID,Department$/); // new columns go last, so existing imports keep working
  assert.match(csv.body, /Ada Obi,ada@biz.test,Staff,.*,Active,E-100,Engineering/);
});

console.log('\nVisitors: check-out and who is on site');
let visitor;
await test('a visitor who arrived shows as on site until checked out; one who has not arrived cannot be checked out', async () => {
  const v = (await org.post(`/api/events/${id}/visitors`, { tier_id: visTier, name: 'Kunle Bello', host: 'Ada', purpose: 'Audit' })).body.visitor;
  const code = (await client(env, freshIp()).post('/api/invitation', { token: v.link.split('#')[1] })).body.code;
  assert.equal((await org.post(`/api/events/${id}/visitors/${v.id}/checkout`)).status, 409, 'not arrived yet');
  assert.equal((await scanAs(code)).body.result, 'granted');
  let site = (await org.get(`/api/events/${id}/on-site`)).body;
  assert.ok(site.visitors.some((x) => x.name === 'Kunle Bello' && x.host === 'Ada'));
  assert.ok(site.staff.some((x) => x.name === 'Ada Obi' && x.department === 'Engineering'));
  assert.match(site.note, /cannot show who has since left/);
  assert.equal((await org.post(`/api/events/${id}/visitors/${v.id}/checkout`)).status, 200);
  assert.equal((await org.post(`/api/events/${id}/visitors/${v.id}/checkout`)).status, 409, 'already out');
  site = (await org.get(`/api/events/${id}/on-site`)).body;
  assert.ok(!site.visitors.some((x) => x.name === 'Kunle Bello'));
  assert.ok((await org.get(`/api/events/${id}/visitors`)).body.visitors.find((x) => x.name === 'Kunle Bello').checked_out_at);
  visitor = v;
});

console.log('\nIncidents');
let inc;
await test('incidents are logged, listed, resolved once and exported (formula-safe)', async () => {
  const r = await org.post(`/api/events/${id}/incidents`, { kind: 'security', summary: '=HYPERLINK("x")', details: 'Tailgating at the front door' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  inc = r.body.incident;
  assert.equal(inc.status, 'open'); assert.equal(inc.reported_by, 'owner@biz.test');
  assert.equal((await org.post(`/api/events/${id}/incidents`, { kind: 'nope', summary: 'x' })).status, 400);
  assert.equal((await org.post(`/api/events/${id}/incidents`, { kind: 'access', summary: '' })).status, 400);
  assert.equal((await org.get(`/api/events/${id}/incidents`)).body.incidents.length, 1);
  assert.equal((await org.post(`/api/events/${id}/incidents/${inc.id}/resolve`, { resolution: 'Door closer fixed' })).status, 200);
  assert.equal((await org.post(`/api/events/${id}/incidents/${inc.id}/resolve`)).status, 409);
  const csv = (await org.get(`/api/events/${id}/incidents.csv`)).body;
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /Door closer fixed/);
});
await test('events that are not offices refuse these features', async () => {
  const ev = (await org.post('/api/events', { name: 'Gig', zones: ['G'], tiers: [{ name: 'GA', zones: ['G'] }] })).body;
  assert.equal((await org.post(`/api/events/${ev.event.id}/departments`, { name: 'X' })).status, 400);
  assert.equal((await org.get(`/api/events/${ev.event.id}/incidents`)).status, 400);
});

console.log('\nTeam access');
let viewer, guard;
await test('the owner adds a viewer and a security officer; each sees the office in their own list', async () => {
  viewer = await signIn(env, 'viewer@biz.test', freshIp(), 'Vera Viewer');
  guard = await signIn(env, 'guard@biz.test', freshIp(), 'Gus Guard');
  assert.equal((await org.post(`/api/events/${id}/members`, { identifier: 'viewer@biz.test', role: 'viewer' })).status, 201);
  assert.equal((await org.post(`/api/events/${id}/members`, { identifier: 'GUARD@biz.test', role: 'security' })).status, 201);
  assert.equal((await org.post(`/api/events/${id}/members`, { identifier: 'nonsense', role: 'viewer' })).status, 400);
  assert.equal((await org.post(`/api/events/${id}/members`, { identifier: 'x@biz.test', role: 'admin' })).status, 400);
  assert.equal((await org.post(`/api/events/${id}/members`, { identifier: 'owner@biz.test', role: 'viewer' })).body.error.code, 'is_owner');
  assert.equal((await org.get(`/api/events/${id}/members`)).body.members.length, 2);
  const mine = (await viewer.get('/api/events?kind=workplace')).body.events;
  assert.equal(mine.length, 1); assert.equal(mine[0].role, 'viewer');
  assert.equal((await org.get('/api/events?kind=workplace')).body.events.find((e) => e.id === id).role, 'owner');
  const d = (await viewer.get(`/api/events/${id}`)).body;
  assert.equal(d.role, 'viewer'); assert.equal(d.event.gate_key_hint, null, 'no gate key hint for members');
});
await test('a viewer can read reports but cannot change anything, check out visitors or log incidents', async () => {
  for (const path of ['attendance?from=' + today() + '&to=' + today(), 'attendees', 'visitors', 'incidents', 'departments', 'scans']) {
    assert.equal((await viewer.get(`/api/events/${id}/${path}`)).status, 200, path);
  }
  assert.equal((await viewer.get(`/api/events/${id}/attendance.csv?type=summary`)).status, 200);
  for (const [m, path, body] of [['POST', 'people', { tier_id: staffTier, people: [{ contact: 'v@x.test' }] }], ['POST', 'departments', { name: 'V' }], ['POST', 'members', { identifier: 'z@biz.test', role: 'viewer' }],
    ['POST', 'gate-key', {}], ['POST', 'stewards', { name: 'V' }], ['POST', `visitors/${visitor.id}/checkout`, {}], ['POST', 'incidents', { kind: 'other', summary: 'x' }], ['GET', 'on-site'], ['GET', 'members'], ['GET', 'finance']]) {
    const r = await viewer.call(m, `/api/events/${id}/${path}`, { body });
    assert.equal(r.status, 404, `${m} ${path} -> ${r.status}`);
  }
  assert.equal((await viewer.patch(`/api/events/${id}`, { listed: true })).status, 404);
});
await test('security can also log and resolve incidents, check visitors out and see who is on site, but not change people or the team', async () => {
  const r = await guard.post(`/api/events/${id}/incidents`, { kind: 'safety', summary: 'Wet floor in lobby' });
  assert.equal(r.status, 201); assert.equal(r.body.incident.reported_by, 'guard@biz.test');
  assert.equal((await guard.post(`/api/events/${id}/incidents/${r.body.incident.id}/resolve`, { resolution: 'Mopped' })).status, 200);
  assert.equal((await guard.get(`/api/events/${id}/on-site`)).status, 200);
  for (const [path, body] of [['people', { tier_id: staffTier, people: [{ contact: 'g@x.test' }] }], ['members', { identifier: 'z@biz.test', role: 'viewer' }], ['departments', { name: 'G' }]]) {
    assert.equal((await guard.post(`/api/events/${id}/${path}`, body)).status, 404, path);
  }
});
await test('removing a member ends their access; people who are not members see nothing; roles can change', async () => {
  const stranger = await signIn(env, 'nobody@biz.test', freshIp(), 'N');
  assert.equal((await stranger.get(`/api/events/${id}`)).status, 404);
  assert.equal((await stranger.get('/api/events?kind=workplace')).body.events.length, 0);
  const upg = await org.post(`/api/events/${id}/members`, { identifier: 'viewer@biz.test', role: 'security' });
  assert.equal(upg.body.updated, true);
  assert.equal((await viewer.get('/api/events?kind=workplace')).body.events[0].role, 'security');
  const mem = (await org.get(`/api/events/${id}/members`)).body.members.find((m) => m.identifier === 'viewer@biz.test');
  assert.equal((await org.post(`/api/events/${id}/members/${mem.id}/remove`)).status, 200);
  assert.equal((await viewer.get(`/api/events/${id}`)).status, 404);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
