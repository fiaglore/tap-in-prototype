// The phone app: the installable web app and the Capacitor shell in /mobile. Run with: node test/mobile.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pub = join(root, 'worker/public');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(err.stack || err).split('\n').slice(0, 4).join('\n       ')); }
}

console.log('\nThe installable web app');
await test('the app manifest makes /app/ installable and full screen', () => {
  const m = JSON.parse(read('worker/public/app/manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.id, '/app/');
  assert.ok(m.start_url.startsWith('/app/'));
  assert.equal(m.scope, '/');
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(existsSync(join(pub, i.src)), 'icon file missing: ' + i.src);
});
await test('the app page links its own manifest and the phone-app script', () => {
  const html = read('worker/public/app/index.html');
  assert.match(html, /<link rel="manifest" href="\/app\/manifest\.webmanifest">/);
  assert.match(html, /<script src="\/js\/native\.js(\?v=\d+)?" defer><\/script>/);
  assert.match(read('worker/public/gate/index.html'), /\/js\/native\.js/);
});

console.log('\nnative.js (inside the phone app only)');
function run(window) {
  const ctx = vm.createContext({ window, location: window.location, URL, setTimeout, document: window.document });
  vm.runInContext(read('worker/public/js/native.js'), ctx);
}
const fakeDoc = () => { const cls = new Set(); return { documentElement: { classList: { add: (...c) => c.forEach((x) => cls.add(x)), has: (c) => cls.has(c) } }, addEventListener() {} }; };
await test('in a browser it does nothing at all', () => {
  const doc = fakeDoc(), win = { document: doc, location: { href: '' }, addEventListener() {} };
  run(win);
  assert.equal(doc.documentElement.classList.has('is-native'), false);
});
await test('in the app it marks the page, hides the splash, and keeps tap-in.world links inside', () => {
  const doc = fakeDoc(), calls = [], listeners = {}, loc = { href: '' };
  const win = {
    document: doc, location: loc,
    addEventListener: (n, fn) => { listeners[n] = fn; },
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
      StatusBar: { setStyle: (a) => calls.push(['StatusBar.setStyle', a]), setBackgroundColor: (a) => calls.push(['StatusBar.setBackgroundColor', a]) },
      SplashScreen: { hide: (a) => calls.push(['SplashScreen.hide', a]) },
      App: { addListener: (n, fn) => { listeners['app:' + n] = fn; } }
    } }
  };
  run(win);
  assert.ok(doc.documentElement.classList.has('is-native') && doc.documentElement.classList.has('is-android'));
  assert.ok(calls.some((c) => c[0] === 'StatusBar.setStyle'));
  assert.equal(typeof listeners['app:appUrlOpen'], 'function');
  listeners['app:appUrlOpen']({ url: 'https://www.tap-in.world/signin/?oobCode=abc#x' });
  assert.equal(loc.href, '/signin/?oobCode=abc#x');
  loc.href = '';
  listeners['app:appUrlOpen']({ url: 'https://evil.example/signin/' });
  listeners['app:appUrlOpen']({ url: 'http://www.tap-in.world/signin/' });
  listeners['app:appUrlOpen']({ url: 'https://tap-in.world.evil.example/i/x' });
  assert.equal(loc.href, '', 'foreign and plain-http links must be ignored');
});

console.log('\nThe Capacitor shell (/mobile)');
await test('the app id is valid for both stores and the shell loads the live app over https', () => {
  const c = JSON.parse(read('mobile/capacitor.config.json'));
  assert.match(c.appId, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, 'no hyphens or capitals in an app id');
  assert.equal(c.appName, 'Tap In');
  const u = new URL(c.server.url);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.hostname, 'www.tap-in.world');
  assert.ok(u.pathname.startsWith('/app/'));
  assert.equal(c.server.cleartext, false);
  for (const h of ['www.tap-in.world', 'tap-in.world', 'business.tap-in.world']) assert.ok(c.server.allowNavigation.includes(h), h);
  assert.ok(existsSync(join(root, 'mobile', c.webDir, 'index.html')), 'webDir needs an index.html');
});
await test('Android opens tap-in.world links in the app, may use the camera, and does not back up its data', () => {
  const m = read('mobile/android/app/src/main/AndroidManifest.xml');
  assert.match(m, /android:autoVerify="true"/);
  for (const h of ['www.tap-in.world', 'tap-in.world']) assert.match(m, new RegExp(`android:host="${h.replace(/\./g, '\\.')}"`));
  for (const p of ['/app/', '/signin/', '/i/']) assert.match(m, new RegExp(`android:pathPrefix="${p}"`));
  assert.match(m, /android\.permission\.CAMERA/);
  assert.match(m, /android:allowBackup="false"/);
  assert.match(m, /android:required="false"/);
});
await test('iPhone explains why the camera is asked for', () => {
  assert.match(read('mobile/ios/App/App/Info.plist'), /NSCameraUsageDescription/);
});
await test('the deep-link files are templates with their placeholders still to fill in', () => {
  const a = JSON.parse(read('mobile/deeplinks/assetlinks.json.template'));
  assert.equal(a[0].target.package_name, 'world.tapin.app');
  assert.match(a[0].target.sha256_cert_fingerprints[0], /^REPLACE_/);
  const s = JSON.parse(read('mobile/deeplinks/apple-app-site-association.template'));
  assert.match(s.applinks.details[0].appIDs[0], /^REPLACE_WITH_APPLE_TEAM_ID\.world\.tapin\.app$/);
  // a template must never be served by the website by accident
  assert.equal(existsSync(join(pub, '.well-known/assetlinks.json')), false);
});
await test('icons and splash screens were generated for both platforms', () => {
  for (const f of ['mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 'mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 'mobile/ios/App/App/Assets.xcassets/Splash.imageset/Default@2x~universal~anyany.png']) assert.ok(existsSync(join(root, f)), f);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
