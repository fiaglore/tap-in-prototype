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

await test('the app keeps every file it now needs for working offline, and its saved copy is refreshed', () => {
  const sw = read('worker/public/app/sw.js');
  for (const f of ['/js/auth-ui.js', '/js/applogin.js', '/js/native.js', '/js/appnav.js', '/css/appshell.css']) assert.ok(sw.includes("'" + f + "'"), f + ' must be in the offline list');
  assert.match(sw, /tapin-app-v([3-9]|\d\d+)/, 'the saved copy must be renamed so phones fetch the new files');
});

console.log('\nnative.js (inside the phone app only)');
function run(window) {
  const ctx = vm.createContext({ window, location: window.location, URL, setTimeout, requestAnimationFrame: (fn) => fn(), document: window.document });
  vm.runInContext(read('worker/public/js/native.js'), ctx);
}
const fakeDoc = () => { const cls = new Set(); return { documentElement: { classList: { add: (...c) => c.forEach((x) => cls.add(x)), has: (c) => cls.has(c) } }, addEventListener() {}, readyState: 'complete' }; };
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
  assert.ok(calls.some((c) => c[0] === 'SplashScreen.hide'), 'the splash goes at first paint, not after every file has loaded');
  assert.equal(typeof listeners['app:appUrlOpen'], 'function');
  listeners['app:appUrlOpen']({ url: 'https://www.tap-in.world/signin/?oobCode=abc#x' });
  assert.equal(loc.href, '/signin/?oobCode=abc#x');
  loc.href = '';
  listeners['app:appUrlOpen']({ url: 'https://evil.example/signin/' });
  listeners['app:appUrlOpen']({ url: 'http://www.tap-in.world/signin/' });
  listeners['app:appUrlOpen']({ url: 'https://tap-in.world.evil.example/i/x' });
  assert.equal(loc.href, '', 'foreign and plain-http links must be ignored');
});

console.log('\nThe app\'s front door and tabs');
function runScript(file, win) {
  const ctx = vm.createContext({ window: win, location: win.location, document: win.document, URL, setTimeout: (fn) => { win.timers.push(fn); return 0; } });
  vm.runInContext(read(file), ctx);
}
const lockDoc = (locked) => ({ documentElement: { classList: { contains: (c) => locked && c === 'intro-lock' } } });
const enterWin = (search, locked) => { const w = { search, replaced: [], timers: [] }; return { location: { search, replace: (u) => w.replaced.push(u) }, document: lockDoc(locked), timers: w.timers, replaced: w.replaced, __tapinIntro: false }; };
await test('/enter/ is the website\'s Tap to enter opening, and it moves on to the events home', () => {
  const html = read('worker/public/enter/index.html');
  assert.match(html, /id="introEnter"/); assert.match(html, /id="introSkip"/); assert.match(html, /id="rave"/);
  assert.match(html, /\/js\/enter\.js/); assert.match(html, /\/js\/intro\.js/);
  assert.doesNotMatch(html, /intro-photo|lp-stage|livephoto/, 'no photo on the opening screen');
  assert.match(read('worker/public/js/theme.js'), /path === '\/enter\/'/, 'theme.js must lock the page for the opening on /enter/');
  assert.match(read('worker/public/js/intro.js'), /__tapinNext\) \{ location\.replace\(window\.__tapinNext\)/, 'intro.js must carry on when the opening ends');
});
await test('enter.js: with the opening it waits and remembers where to go; without it, straight through', () => {
  const w = enterWin('?source=app', true); runScript('worker/public/js/enter.js', w);
  assert.equal(w.__tapinNext, '/play/'); assert.deepEqual(w.replaced, []); assert.equal(w.timers.length, 2, 'a safety timer in case the opening cannot run, and the quiet fetch of the home page');
  const skip = enterWin('?source=app', false); runScript('worker/public/js/enter.js', skip);
  assert.deepEqual(skip.replaced, ['/play/']);
  w.timers[0](); assert.deepEqual(w.replaced, ['/play/'], 'the safety timer moves on if the opening never started');
});
await test('the front door shows in the app: it loads native.js (which hides the splash), ignores the reduced-motion setting, and is light', () => {
  const html = read('worker/public/enter/index.html');
  assert.match(html, /\/js\/native\.js/, 'without native.js the splash never goes away');
  assert.ok(html.indexOf('native.js') < html.indexOf('/js/fx.js') && html.indexOf('native.js') < html.indexOf('/js/intro.js'), 'native.js first, so the others know they are in the app');
  assert.match(read('worker/public/js/theme.js'), /rm = path !== '\/enter\/'/, 'Android\'s remove-animations setting must not hide the front door');
  assert.match(read('worker/public/home.css'), /prefers-reduced-motion:reduce\)\{html:not\(\.intro-lock\) \.intro\{display:none/, 'reduced motion must not hide a locked opening');
  for (const f of ['fx', 'liquid', 'rave']) assert.match(read(`worker/public/js/${f}.js`), /is-native/, f + '.js must skip itself in the app');
  assert.match(read('worker/public/css/appshell.css'), /html\.is-native \*[^{]*\{[^}]*backdrop-filter:none/, 'no glass blur in the app');
});
await test('files pages load are kept on the phone for a few minutes, and pages themselves are not', () => {
  const h = read('worker/public/_headers');
  for (const p of ['/js/*', '/css/*', '/img/*']) assert.match(h, new RegExp('\\n' + p.replace('*', '\\*') + '\\n  Cache-Control: public, max-age=\\d+'), p);
  assert.doesNotMatch(h, /\n\/(play|app|e|gate|organiser|organisers|enter)\/\*\n  Cache-Control: public/, 'html pages must keep checking for a newer copy');
});
await test('enter.js only ever goes to our own app pages', () => {
  const ok = enterWin('?next=/app/', false); runScript('worker/public/js/enter.js', ok); assert.deepEqual(ok.replaced, ['/app/']);
  for (const bad of ['?next=//evil.example/', '?next=https://evil.example/', '?next=/privacy/', '?next=/play/x/../../evil']) {
    const w = enterWin(bad, false); runScript('worker/public/js/enter.js', w); assert.deepEqual(w.replaced, ['/play/'], bad);
  }
});
await test('the tabs and the app styles are on every app page, and nowhere on the website\'s own pages', () => {
  for (const f of ['play', 'e', 'organiser', 'app', 'gate']) {
    const html = read(`worker/public/${f}/index.html`);
    assert.match(html, /\/js\/native\.js\?v=3/, f); assert.match(html, /\/js\/appnav\.js/, f); assert.match(html, /\/css\/appshell\.css/, f);
  }
  for (const f of ['index.html', 'organisers/index.html', 'business/index.html']) assert.doesNotMatch(read('worker/public/' + f), /appnav|appshell/, f);
  const css = read('worker/public/css/appshell.css');
  for (const rule of css.split('}').map((r) => r.trim()).filter((r) => r && !r.startsWith('/*') && !r.startsWith('@'))) {
    assert.match(rule, /(\.apptabs|\.has-apptabs|\.is-native|\.evtools|\.evcount|\.sharebtn)/, 'every rule is for the app only: ' + rule.slice(0, 50));
  }
});
await test('appnav.js lists the five tabs, Events first, and does nothing in a browser', () => {
  const src = read('worker/public/js/appnav.js');
  const order = ['Events', 'Organiser', 'Gate', 'Passes', 'Account'].map((l) => src.indexOf("label: '" + l + "'"));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), 'tab order: Events, Organiser, Gate, Passes, Account');
  assert.match(src, /href: '\/gate\/'/); assert.match(src, /\^\\\/gate\\\//, 'the Gate page lights up its own tab');
  assert.match(src, /href: '\/play\/'/); assert.match(src, /href: '\/app\/#me'/);
  const doc = { documentElement: { classList: { contains: () => false } }, addEventListener() { throw new Error('touched the page in a browser'); } };
  runScript('worker/public/js/appnav.js', { document: doc, location: { pathname: '/play/', hash: '' }, addEventListener() { throw new Error('touched the window in a browser'); }, timers: [] });
});
await test('the share helper uses the phone\'s share sheet, and says so when it cannot', async () => {
  const calls = [];
  const mk = (Share) => { const w = { document: fakeDoc(), location: { href: '' }, addEventListener() {}, Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { Share, App: { addListener() {}, getInfo: async () => ({ version: '1.2.3', build: '45' }) } } }, timers: [] }; run(w); return w; };
  const withShare = mk({ share: async (o) => { calls.push(o); } });
  assert.equal(await withShare.TapInNative.share({ title: 'Fest', text: 'Tickets', url: 'https://www.tap-in.world/e/?id=1' }), true);
  assert.equal(calls[0].url, 'https://www.tap-in.world/e/?id=1');
  assert.equal(await mk(undefined).TapInNative.share({ title: 'x', url: 'y' }), false, 'no plugin: the page copies the link instead');
  assert.equal(await mk({ share: async () => { throw new Error('cancelled'); } }).TapInNative.share({ title: 'x', url: 'y' }), false);
  assert.equal(await withShare.TapInNative.version(), '1.2.3 (45)');
});

console.log('\nThe Capacitor shell (/mobile)');
await test('the app id is valid for both stores and the shell loads the live app over https', () => {
  const c = JSON.parse(read('mobile/capacitor.config.json'));
  assert.match(c.appId, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, 'no hyphens or capitals in an app id');
  assert.equal(c.appName, 'Tap In');
  const u = new URL(c.server.url);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.hostname, 'www.tap-in.world');
  assert.equal(u.pathname, '/enter/', 'the app opens on its front door, then the events home');
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
