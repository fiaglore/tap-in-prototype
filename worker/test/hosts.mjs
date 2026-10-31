// Tap In for Business on its own hostname. Run with: node test/hosts.mjs
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}

const seen = [];
const assets = { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('asset:' + new URL(req.url).pathname, { status: 200 }); } };
const env = makeEnv({ BUSINESS_HOST: 'business.tap-in.world', MAIN_HOST: 'www.tap-in.world', ASSETS: assets });
const get = (url, e = env, method = 'GET') => worker.fetch(new Request(url, { method, redirect: 'manual' }), e, {});
const where = (r) => r.headers.get('Location');

console.log('\nOn the business host');
await test('the root serves the Business landing page in place', async () => {
  seen.length = 0;
  const r = await get('https://business.tap-in.world/');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'asset:/business/');
});
await test('/business/ redirects to the root; the office console and shared pages are served here', async () => {
  assert.equal(where(await get('https://business.tap-in.world/business/')), 'https://business.tap-in.world/');
  assert.equal((await get('https://business.tap-in.world/business')).status, 301);
  for (const p of ['/offices/', '/gate/', '/i/', '/signin/', '/privacy/', '/terms/', '/app/', '/business/business.css', '/css/tapin.css']) {
    const r = await get('https://business.tap-in.world' + p);
    assert.equal(r.status, 200, p);
  }
});
await test('event pages send people to the main site, keeping the query string', async () => {
  assert.equal(where(await get('https://business.tap-in.world/organiser/')), 'https://www.tap-in.world/organiser/');
  assert.equal(where(await get('https://business.tap-in.world/play/')), 'https://www.tap-in.world/play/');
  assert.equal(where(await get('https://business.tap-in.world/e/?id=ABC123')), 'https://www.tap-in.world/e/?id=ABC123');
});
await test('the API answers on the business host', async () => {
  const r = await get('https://business.tap-in.world/api/config');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).configured, true);
});

console.log('\nOn the main site');
await test('/business/ and /offices/ move to the business host', async () => {
  const a = await get('https://www.tap-in.world/business/');
  assert.equal(a.status, 301);
  assert.equal(where(a), 'https://business.tap-in.world/');
  assert.equal(where(await get('https://www.tap-in.world/offices/')), 'https://business.tap-in.world/offices/');
  assert.equal(where(await get('https://www.tap-in.world/offices/?x=1')), 'https://business.tap-in.world/offices/?x=1');
  assert.equal(where(await get('https://tap-in.world/business/')), 'https://business.tap-in.world/', 'the bare domain too');
});
await test('the main site is otherwise untouched: its root is the events home, and the business CSS is still served', async () => {
  seen.length = 0;
  const r = await get('https://www.tap-in.world/');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'asset:/');
  assert.equal((await get('https://www.tap-in.world/business/business.css')).status, 200);
  assert.equal((await get('https://www.tap-in.world/organiser/')).status, 200);
});
await test('only page loads are redirected: writes to the API and other methods pass straight through', async () => {
  const r = await worker.fetch(new Request('https://www.tap-in.world/offices/', { method: 'POST', redirect: 'manual' }), env, {});
  assert.notEqual(r.status, 301);
});

console.log('\nWhere the hostnames are not set up');
await test('with the settings unset, nothing is redirected or rewritten (local, tests)', async () => {
  const plain = makeEnv({ ASSETS: assets });
  assert.equal((await get('https://tapin.test/business/', plain)).status, 200);
  assert.equal((await get('https://tapin.test/offices/', plain)).status, 200);
  assert.equal(await (await get('https://tapin.test/', plain)).text(), 'asset:/');
});
await test('on other hosts (workers.dev) every page answers where it is, so there is always a way in', async () => {
  const r = await get('https://tap-in.example.workers.dev/offices/');
  assert.equal(r.status, 200);
  assert.equal((await get('https://tap-in.example.workers.dev/business/')).status, 200);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
