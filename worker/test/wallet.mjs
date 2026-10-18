// Apple Wallet and Google Wallet passes. Uses a throwaway certificate and key made with openssl, checks the .pkpass
// contents and verifies its signature with openssl, and checks the Google save link's signature.
// Run with: node test/wallet.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { client, makeEnv, signIn } from './harness.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'tapin-wallet-'));
const ossl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '7', '-subj', '/CN=Pass Type ID: pass.test.tapin');
ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'wkey.pem', '-out', 'wwdr.pem', '-days', '7', '-subj', '/CN=Test WWDR');
ossl('rsa', '-in', 'key.pem', '-traditional', '-out', 'key-pkcs1.pem');
ossl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', 'gkey.pem');
ossl('pkey', '-in', 'gkey.pem', '-pubout', '-out', 'gpub.pem');
const read = (f) => readFileSync(join(dir, f), 'utf8');

// Serve the real wallet images from public/.
const ASSETS = { fetch: async (req) => { const p = new URL(req.url).pathname; try { return new Response(readFileSync(join(root, 'public', p))); } catch { return new Response('nope', { status: 404 }); } } };
const WALLET = {
  APPLE_PASS_TYPE_ID: 'pass.test.tapin', APPLE_TEAM_ID: 'ABCDE12345', APPLE_PASS_CERT: read('cert.pem'), APPLE_PASS_KEY: read('key-pkcs1.pem'), APPLE_WWDR_CERT: read('wwdr.pem'),
  GOOGLE_WALLET_ISSUER_ID: '3388000000012345678', GOOGLE_WALLET_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'wallet@tapin-test.iam.gserviceaccount.com', private_key: read('gkey.pem') })
};
const env = makeEnv({ ...WALLET, ASSETS });
const bare = makeEnv();
let ipN = 1;
const freshIp = () => '10.99.' + Math.floor(ipN / 250) + '.' + (ipN++ % 250 + 1);
const raw = async (e, c, path) => {
  const headers = { 'CF-Connecting-IP': freshIp() };
  return worker.fetch(new Request('https://tapin.test' + path, { headers: c ? { ...headers, Cookie: c } : headers }), e, { waitUntil() {} });
};

const org = await signIn(env, 'org@wallet.test', '10.99.200.1', 'Wallet Org');
const fanC = client(env, '10.99.200.3');
const otp = await fanC.post('/api/auth/otp/request', { identifier: 'fan@wallet.test' });
const ver = await fanC.post('/api/auth/otp/verify', { identifier: 'fan@wallet.test', code: otp.body.dev_code });
const cookie = ver.setCookie.split(';')[0];
await fanC.patch('/api/me', { name: 'Ada Lovelace' });
const ev = (await org.post('/api/events', { name: 'Wallet Fest', venue: 'Eko', city: 'Lagos', starts_at: new Date(Date.now() + 5 * 86400e3).toISOString(), zones: ['Gate'], tiers: [{ name: 'VIP', zones: ['Gate'] }] })).body;
const code = (await org.post(`/api/events/${ev.event.id}/invites`, { tier_id: ev.tiers[0].id, count: 1 })).body.codes[0];
const pass = (await fanC.post('/api/claim', { code })).body.pass;

await test('wallet buttons only appear once the credentials are set', async () => {
  assert.deepEqual((await client(bare, '10.99.201.1').get('/api/config')).body.wallet, { apple: false, google: false });
  assert.deepEqual((await client(env, '10.99.201.2').get('/api/config')).body.wallet, { apple: true, google: true });
  const r = await raw(bare, null, '/api/invitation/wallet/apple?t=X');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'wallet_not_set_up');
});
let files;
await test('Apple: a .pkpass with pass.json, images, manifest and signature, carrying the same code as the Tap In pass', async () => {
  const r = await raw(env, cookie, `/api/me/passes/${pass.id}/wallet/apple`);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(r.headers.get('content-type'), 'application/vnd.apple.pkpass');
  const out = join(dir, 'pass');
  writeFileSync(join(dir, 'p.pkpass'), new Uint8Array(await r.arrayBuffer()));
  execFileSync('unzip', ['-q', '-o', 'p.pkpass', '-d', 'pass'], { cwd: dir });
  files = readdirSync(out).sort();
  assert.deepEqual(files, ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'manifest.json', 'pass.json', 'signature']);
  const pj = JSON.parse(readFileSync(join(out, 'pass.json'), 'utf8'));
  assert.equal(pj.passTypeIdentifier, 'pass.test.tapin');
  assert.equal(pj.teamIdentifier, 'ABCDE12345');
  assert.equal(pj.serialNumber, pass.id);
  assert.equal(pj.barcodes[0].message, pass.token, 'same code the gate already accepts');
  assert.equal(pj.eventTicket.primaryFields[0].value, 'Wallet Fest');
  assert.equal(pj.eventTicket.secondaryFields[0].value, 'Ada Lovelace');
  assert.ok(pj.relevantDate.endsWith('Z'));
});
await test('Apple: every file is in the manifest with the right SHA-1, and openssl verifies the signature', async () => {
  const out = join(dir, 'pass');
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  for (const f of files.filter((x) => x !== 'manifest.json' && x !== 'signature')) {
    const sha = execFileSync('openssl', ['dgst', '-sha1', '-r', join(out, f)]).toString().split(' ')[0];
    assert.equal(manifest[f], sha, f);
  }
  const res = execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', join(out, 'signature'), '-content', join(out, 'manifest.json'), '-noverify', '-purpose', 'any', '-out', '/dev/null'], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(res !== undefined); // throws if verification fails
  const certs = execFileSync('openssl', ['pkcs7', '-inform', 'DER', '-in', join(out, 'signature'), '-print_certs', '-noout']).toString();
  assert.match(certs, /Pass Type ID: pass\.test\.tapin/);
  assert.match(certs, /Test WWDR/, 'Apple’s intermediate certificate is included');
});
await test('Google: a Save to Google Wallet link whose token is signed by the service account and carries the code', async () => {
  const r = await raw(env, cookie, `/api/me/passes/${pass.id}/wallet/google`);
  assert.equal(r.status, 200);
  const { url } = await r.json();
  assert.match(url, /^https:\/\/pay\.google\.com\/gp\/v\/save\/[\w-]+\.[\w-]+\.[\w-]+$/);
  const [h, c, s] = url.split('/save/')[1].split('.');
  const dec = (x) => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(h), { alg: 'RS256', typ: 'JWT' });
  const claims = dec(c);
  assert.equal(claims.iss, 'wallet@tapin-test.iam.gserviceaccount.com');
  assert.equal(claims.typ, 'savetowallet');
  const obj = claims.payload.genericObjects[0];
  assert.equal(obj.barcode.value, pass.token);
  assert.equal(obj.id, `3388000000012345678.${pass.id}`);
  assert.equal(obj.header.defaultValue.value, 'Wallet Fest');
  const pubDer = Buffer.from(read('gpub.pem').replace(/-----[^-]+-----|\s/g, ''), 'base64');
  const pub = await crypto.subtle.importKey('spki', pubDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + c)), 'signature verifies');
});
await test('only the pass holder can get it; live passes and cancelled passes are refused', async () => {
  assert.equal((await raw(env, null, `/api/me/passes/${pass.id}/wallet/apple`)).status, 401);
  const live = (await org.post('/api/events', { name: 'Live Fest', secure_qr: true, zones: ['G'], tiers: [{ name: 'T', zones: ['G'] }] })).body;
  const lc = (await org.post(`/api/events/${live.event.id}/invites`, { tier_id: live.tiers[0].id, count: 1 })).body.codes[0];
  const lp = (await fanC.post('/api/claim', { code: lc })).body.pass;
  const r = await raw(env, cookie, `/api/me/passes/${lp.id}/wallet/apple`);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'live_pass');
  await org.post(`/api/events/${ev.event.id}/passes/${pass.id}/revoke`, {});
  assert.equal((await raw(env, cookie, `/api/me/passes/${pass.id}/wallet/apple`)).status, 409);
});
await test('invitations and visitor passes can be added to a wallet from their link, with party, table and host', async () => {
  const g = (await org.post(`/api/events/${ev.event.id}/guests`, { tier_id: ev.tiers[0].id, guests: [{ name: 'Adaeze Okafor', party_size: 3, table: 'Table 4' }] })).body.added[0];
  const t = g.link.split('#')[1];
  const r = await raw(env, null, `/api/invitation/wallet/apple?t=${t}`);
  assert.equal(r.status, 200);
  writeFileSync(join(dir, 'i.pkpass'), new Uint8Array(await r.arrayBuffer()));
  execFileSync('unzip', ['-q', '-o', 'i.pkpass', 'pass.json', '-d', 'inv'], { cwd: dir });
  const pj = JSON.parse(readFileSync(join(dir, 'inv', 'pass.json'), 'utf8'));
  assert.match(pj.barcodes[0].message, /^TG-/);
  const aux = Object.fromEntries(pj.eventTicket.auxiliaryFields.map((f) => [f.key, f.value]));
  assert.equal(aux.party, '3 people');
  assert.equal(aux.table, 'Table 4');
  const off = (await org.post('/api/events', { kind: 'workplace', name: 'Acme HQ', require_photo: false, zones: ['Door'], tiers: [{ name: 'Visitors', zones: ['Door'] }] })).body;
  const v = (await org.post(`/api/events/${off.event.id}/visitors`, { tier_id: off.tiers[0].id, name: 'Kunle Bello', host: 'Tolu' })).body.visitor;
  const gr = await raw(env, null, `/api/invitation/wallet/google?t=${v.link.split('#')[1]}`);
  const claims = JSON.parse(Buffer.from((await gr.json()).url.split('/save/')[1].split('.')[1], 'base64url').toString());
  const obj = claims.payload.genericObjects[0];
  assert.equal(obj.subheader.defaultValue.value, 'VISITOR PASS');
  assert.ok(obj.textModulesData.some((m) => m.id === 'host' && m.body === 'Tolu'));
  assert.ok(obj.validTimeInterval.end.date);
  assert.equal((await raw(env, null, '/api/invitation/wallet/apple?t=NOTREAL')).status, 404);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
