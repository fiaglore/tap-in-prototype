// The public Play page: upcoming events people can open the sales page for. Run with: node test/play.mjs
import assert from 'node:assert/strict';
import { client, makeEnv, signIn } from './harness.mjs';
import worker from '../src/index.js';
import { eventJsonLd } from '../src/routes/public.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const env = makeEnv();
const iso = (days) => new Date(Date.now() + days * 86400e3).toISOString();
const anon = () => client(env, '10.60.9.' + (1 + Math.floor(Math.random() * 200)));
const list = async () => (await anon().get('/api/public/events')).body.events;
let org, other;
const mk = async (extra = {}, tier = {}) => {
  const r = await org.post('/api/events', { name: 'Fest', zones: ['Gate'], tiers: [{ name: 'GA', zones: ['Gate'], price_kobo: 500000, ...tier }], ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
// Events cannot be created in the past, so "time passes" by moving the date in the database.
const past = (made, days) => env.DB.raw.prepare('UPDATE events SET starts_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000 + days * 86400), made.event.id);
org = await signIn(env, 'promoter@play.test', '10.60.0.1', 'Pat');
other = await signIn(env, 'other@play.test', '10.60.0.2', 'Other');

await test('anyone can read the list without signing in, and it starts empty', async () => {
  const r = await anon().get('/api/public/events');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.events, []);
});
await test('a new event is listed by default; an organiser can opt out; offices are never listed', async () => {
  const a = await mk({ name: 'Listed by default', starts_at: iso(10) });
  assert.equal(a.event.listed, true);
  await mk({ name: 'Private party', starts_at: iso(11), listed: false });
  const office = await org.post('/api/events', { kind: 'workplace', name: 'Acme HQ', listed: true, require_photo: false, zones: ['Door'], tiers: [{ name: 'Staff', zones: ['Door'] }] });
  assert.equal(office.body.event.listed, false);
  const names = (await list()).map((e) => e.name);
  assert.deepEqual(names, ['Listed by default']);
});
await test('only upcoming events show: past ones drop off, undated ones stay, soonest comes first', async () => {
  await past(await mk({ name: 'Last week', starts_at: iso(1) }), -7);
  await mk({ name: 'Tonight', starts_at: iso(0.2) });
  await mk({ name: 'Date to come' });
  await mk({ name: 'Next month', starts_at: iso(30) });
  const names = (await list()).map((e) => e.name);
  assert.ok(!names.includes('Last week'));
  assert.deepEqual(names, ['Tonight', 'Listed by default', 'Next month', 'Date to come']);
});
await test('an event that started a few hours ago is still listed', async () => {
  await past(await mk({ name: 'Doors opened an hour ago', starts_at: iso(1) }), -1 / 24);
  assert.ok((await list()).some((e) => e.name === 'Doors opened an hour ago'));
});
await test('each entry has just what a visitor needs to choose, and nothing private', async () => {
  const e = (await list()).find((x) => x.name === 'Next month');
  assert.deepEqual(Object.keys(e).sort(), ['city', 'from_kobo', 'id', 'name', 'sales', 'sold_out', 'starts_at', 'venue']);
  const raw = JSON.stringify(await list());
  for (const secret of ['gate_key', 'owner', 'prefix', 'hint', 'invite', 'capacity', 'issued']) assert.ok(!raw.includes(secret), secret + ' must not be public');
  assert.equal(e.from_kobo, 500000);
});
await test('"from" is the cheapest ticket type, and free shows as zero', async () => {
  const r = await org.post('/api/events', { name: 'Mixed prices', starts_at: iso(40), zones: ['G'], tiers: [{ name: 'VIP', zones: ['G'], price_kobo: 900000 }, { name: 'Free entry', zones: ['G'], price_kobo: 0 }] });
  const e = (await list()).find((x) => x.name === 'Mixed prices');
  assert.equal(e.from_kobo, 0);
  assert.equal(r.status, 201);
});
await test('sales state and sold-out are reported, without revealing counts', async () => {
  const soon = await mk({ name: 'Sales not open', starts_at: iso(50), sales_start: iso(5) });
  const shut = await mk({ name: 'Sales closed', starts_at: iso(51), sales_start: iso(-5), sales_end: iso(-1) });
  const full = await mk({ name: 'Sold out show', starts_at: iso(52) }, { capacity: 1 });
  const fan = await signIn(env, 'fan@play.test', '10.60.0.3', 'Fan');
  assert.equal((await fan.post(`/api/public/events/${full.event.id}/buy`, { tier_id: full.tiers[0].id })).status, 201);
  const byName = Object.fromEntries((await list()).map((e) => [e.name, e]));
  assert.equal(byName['Sales not open'].sales, 'upcoming');
  assert.equal(byName['Sales closed'].sales, 'closed');
  assert.equal(byName['Sold out show'].sold_out, true);
  assert.equal(byName['Next month'].sold_out, false);
  assert.ok(soon && shut);
});
await test('an event is only sold out when every ticket type is full', async () => {
  const e = await org.post('/api/events', { name: 'Two kinds', starts_at: iso(60), zones: ['G'], tiers: [{ name: 'A', zones: ['G'], capacity: 1 }, { name: 'B', zones: ['G'] }] });
  const fan = await signIn(env, 'fan2@play.test', '10.60.0.4', 'Fan Two');
  await fan.post(`/api/public/events/${e.body.event.id}/buy`, { tier_id: e.body.tiers.find((t) => t.name === 'A').id });
  assert.equal((await list()).find((x) => x.name === 'Two kinds').sold_out, false);
});
await test('opting out removes it from the list, opting back in restores it; only the owner can change it', async () => {
  const e = await mk({ name: 'Toggle me', starts_at: iso(70) });
  assert.equal((await other.call('PATCH', '/api/events/' + e.event.id, { body: { listed: false } })).status, 404);
  assert.ok((await list()).some((x) => x.name === 'Toggle me'));
  const off = await org.call('PATCH', '/api/events/' + e.event.id, { body: { listed: false } });
  assert.equal(off.body.event.listed, false);
  assert.ok(!(await list()).some((x) => x.name === 'Toggle me'));
  await org.call('PATCH', '/api/events/' + e.event.id, { body: { listed: true } });
  assert.ok((await list()).some((x) => x.name === 'Toggle me'));
});
await test('an office cannot be listed by changing the setting later', async () => {
  const o = await org.post('/api/events', { kind: 'workplace', name: 'Another office', require_photo: false, zones: ['Door'], tiers: [{ name: 'Staff', zones: ['Door'] }] });
  await org.call('PATCH', '/api/events/' + o.body.event.id, { body: { listed: true } });
  assert.ok(!(await list()).some((x) => x.name === 'Another office'));
});
await test('the list is capped, and the id in each entry opens that event’s sales page data', async () => {
  const e = (await list())[0];
  const sale = await anon().get('/api/public/events/' + e.id);
  assert.equal(sale.status, 200);
  assert.equal(sale.body.event.name, e.name);
  assert.ok((await list()).length <= 60);
});

await test('the sitemap lists the public pages and upcoming listed events, never private ones or offices', async () => {
  const listed = await mk({ name: 'Sitemap fest', starts_at: iso(20) });
  const hidden = await mk({ name: 'Secret party', starts_at: iso(21), listed: false });
  const res = await worker.fetch(new Request('https://tap-in.example.workers.dev/sitemap.xml'), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/xml/);
  const xml = await res.text();
  for (const p of ['/', '/business/', '/play/', '/privacy/', '/terms/']) assert.ok(xml.includes(`<loc>https://www.tap-in.world${p}</loc>`), p);
  assert.ok(xml.includes('https://www.tap-in.world/e/?id=' + listed.event.id));
  assert.ok(!xml.includes(hidden.event.id));
  assert.ok(!xml.includes('/organiser/') && !xml.includes('/app/'));
});
await test('event search data has the date in Lagos time, the place, prices in naira and availability', async () => {
  const start = Date.UTC(2026, 11, 5, 18, 0) / 1000;
  const ev = { name: 'Owambe </script> Live', venue: 'Eko Hotel', city: 'Lagos', starts_at: start, sales_start: null, sales_end: null };
  const tiers = [{ name: 'GA', price_kobo: 1500000, capacity: 10, issued: 10 }, { name: 'VIP', price_kobo: 5000000, capacity: null, issued: 3 }];
  const raw = eventJsonLd(ev, tiers, 'https://www.tap-in.world/e/?id=x', start - 86400);
  assert.ok(!raw.includes('</script>'), 'a name cannot close the script tag');
  const d = JSON.parse(raw);
  assert.equal(d['@type'], 'Event');
  assert.equal(d.startDate, '2026-12-05T19:00:00+01:00');
  assert.equal(d.location.name, 'Eko Hotel');
  assert.equal(d.location.address.addressCountry, 'NG');
  assert.deepEqual(d.offers.map((o) => [o.price, o.priceCurrency, o.availability.split('/').pop()]), [['15000.00', 'NGN', 'SoldOut'], ['50000.00', 'NGN', 'InStock']]);
  assert.equal(eventJsonLd({ ...ev, starts_at: null }, tiers, 'u', start), null, 'no date, no event data');
  assert.equal(eventJsonLd({ ...ev, venue: null, city: null }, tiers, 'u', start), null, 'no place, no event data');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
