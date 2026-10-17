import { h, wordmarkText, mount, when } from '/js/dom.js';
import { get, post } from '/js/api.js';

const top = document.getElementById('top');
const main = document.getElementById('main');
const KEY = 'tapin-gate';
let cfg = load(); // { key, zoneId }
let info = null;
let recent = [];
let stream = null;
let looping = false;

// The scanner stays signed in on this phone (a steward's own key can be switched off by the organiser at any time).
function load() { try { return JSON.parse(localStorage.getItem(KEY) || sessionStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); sessionStorage.removeItem(KEY); } catch {} }
function signOut(msg = '') { cfg = {}; info = null; recent = []; save(); viewKey(msg); }
// Who is scanning, with a way to hand the phone over.
const whoBar = () => h('p', { class: 'hint', style: 'margin-top:12px' },
  info && info.steward ? ['Signed in as ', h('strong', {}, info.steward.name), ' \u00b7 '] : ['Using the shared gate key \u00b7 '],
  h('button', { class: 'linkbtn', type: 'button', onclick: () => { if (confirm('Sign out of this scanner?')) signOut(); } }, 'Sign out'));
const auth = () => ({ Authorization: 'Bearer ' + cfg.key });

mount(top, h('a', { class: 'wordmark', href: '/' }, wordmarkText(), ' ', h('span', { class: 'muted', style: 'font-weight:600;font-size:14px' }, 'Gate')), window.TapTheme.button());

function viewKey(err = '') {
  stopCamera();
  const input = h('input', { class: 'input code', id: 'gk', autocomplete: 'off', spellcheck: 'false', placeholder: 'ST-XXXX-XXXX-\u2026 or GK-XXXX-XXXX-\u2026' });
  mount(main, h('div', { class: 'narrow card', style: 'margin-top:4vh' },
    h('h2', {}, 'Gate scanner'),
    h('p', { class: 'muted', style: 'margin-top:6px' }, 'Open the scanner link or QR code your organiser sent you and you are signed in. Or type your scanner key here. This phone stays signed in until you sign out.'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      cfg = { key: input.value.trim() };
      try { info = await get('/gate/info', auth()); save(); viewZone(); } catch (ex) { viewKey(ex.message); }
    } },
      h('div', { class: 'field' }, h('label', { for: 'gk' }, 'Scanner key'), input),
      err && h('div', { class: 'error', role: 'alert' }, err),
      h('button', { class: 'btn primary block', style: 'margin-top:16px', type: 'submit' }, 'Continue'))));
  input.focus();
}

async function ensureInfo() {
  if (!info) info = await get('/gate/info', auth());
  return info;
}

function viewZone() {
  mount(main, h('div', { class: 'narrow card', style: 'margin-top:4vh' },
    h('p', { class: 'eyebrow' }, info.event.name),
    h('h2', { style: 'margin:4px 0 8px' }, 'Which area is this scanner for?'),
    h('div', { class: 'stack' }, info.zones.map((z) => h('button', { class: 'btn ghost block', type: 'button', onclick: () => { cfg.zoneId = z.id; save(); viewScan(); } }, z.name))),
    whoBar()));
}

function viewScan(result) {
  const zone = info.zones.find((z) => z.id === cfg.zoneId);
  if (!zone) return viewZone();
  const input = h('input', { class: 'input scanin', id: 'tok', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Scan or type the pass code', 'aria-label': 'Pass code' });
  const resBox = h('div', { id: 'res' });
  paintResult(resBox, result);
  const video = h('video', { class: 'video', playsinline: true, muted: true, hidden: true });
  const camBtn = h('button', { class: 'btn ghost small', type: 'button' }, 'Use camera');
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) camBtn.hidden = true;
  camBtn.onclick = () => (stream ? stopCamera(video, camBtn) : startCamera(video, camBtn, submit));

  async function submit(token) {
    const t = String(token || '').trim();
    if (!t) return;
    input.disabled = true;
    try {
      const r = await post('/gate/scan', { token: t, zone_id: zone.id }, auth());
      recent.unshift(r);
      recent = recent.slice(0, 8);
      paintResult(resBox, r);
      paintRecent();
      beep(r.result === 'granted');
    } catch (ex) {
      if (ex.status === 401) return signOut('This scanner is no longer signed in. Ask the organiser for a new scanner link.');
      paintResult(resBox, { result: 'error', message: ex.message });
    }
    input.value = '';
    input.disabled = false;
    input.focus();
  }

  const recentBox = h('div', { class: 'recent' });
  function paintRecent() {
    mount(recentBox, recent.map((r) => h('div', { class: 'item' }, h('span', {}, r.holder || 'Unknown pass'), h('span', { class: r.result === 'granted' ? 'chip ok' : 'chip bad' }, r.result === 'granted' ? 'Entered' : 'Declined'))));
  }

  mount(main, h('div', { class: 'narrow' },
    h('div', { class: 'spread' }, h('div', {}, h('p', { class: 'eyebrow' }, info.event.name), h('h2', {}, zone.name)),
      h('button', { class: 'btn ghost small', type: 'button', onclick: viewZone }, 'Change area')),
    h('form', { style: 'margin-top:14px', onsubmit: (e) => { e.preventDefault(); submit(input.value); } }, input,
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Check pass'), camBtn)),
    video, resBox,
    h('h3', { style: 'margin-top:18px' }, 'Recent'), recentBox, whoBar()));
  paintRecent();
  input.focus();
  // USB / bluetooth scanners type the code and press Enter; keep focus on the box.
  main.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A') input.focus(); });
}

function paintResult(box, r) {
  if (!r) return mount(box, h('p', { class: 'muted', style: 'text-align:center;margin:28px 0' }, 'Ready. Waiting for a pass.'));
  if (r.result === 'error') return mount(box, h('div', { class: 'error', role: 'alert' }, r.message));
  const ok = r.result === 'granted';
  mount(box, h('div', { class: 'result ' + r.result, role: 'status' },
    h('div', { class: 'big' }, ok ? 'Let them in' : 'Do not admit'),
    // The face on file, next to the name, so staff match the person in front of them, not just a name.
    r.photo && h('img', { class: 'who ' + r.result, src: r.photo, alt: 'Photo on file for ' + (r.holder || 'this pass') }),
    r.photo_missing && h('div', { class: 'notice warn', style: 'margin:10px auto;max-width:340px' }, 'No photo on file for this pass. Check ID.'),
    r.photo_new && h('div', { class: 'notice warn', style: 'margin:10px auto;max-width:340px' }, 'This photo was added or changed in the last 24 hours. Look closely.'),
    r.holder && h('p', { style: 'font-size:22px;font-weight:700;margin-top:8px' }, r.holder),
    // Guests: one code can bring a party in. Say how many, and where they sit.
    ok && r.party > 1 && h('p', { class: 'party' }, `Party of ${r.party}: let ${r.party} people in`),
    r.table && h('p', { style: 'font-weight:700' }, r.table),
    r.tier && h('p', { class: 'muted' }, r.tier + (r.zone ? ' · ' + r.zone : '') + (r.guest === 'import' ? ' · imported ticket' : r.guest === 'invite' ? ' · guest list' : '')),
    ok && r.rsvp === 'no' && h('div', { class: 'notice warn', style: 'margin:10px auto;max-width:340px' }, 'They told the host they could not come. Check with the host if unsure.'),
    h('p', { style: 'margin-top:8px' }, r.message),
    r.previous_at && h('p', { class: 'hint' }, 'First used at ' + when(r.previous_at, { timeStyle: 'short' }))));
}

let audio;
function beep(ok) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.05;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.12 : 0.35));
  } catch {}
  if (!ok && navigator.vibrate) navigator.vibrate(200);
}

async function startCamera(video, btn, submit) {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    btn.textContent = 'Camera blocked';
    return;
  }
  video.srcObject = stream;
  video.hidden = false;
  await video.play().catch(() => {});
  btn.textContent = 'Stop camera';
  // QR for Tap In codes, plus the barcodes other ticketers print, where this phone can read them.
  const wanted = ['qr_code', 'code_128', 'code_39', 'ean_13', 'pdf417', 'aztec', 'data_matrix'];
  let formats = ['qr_code'];
  try { const ok = await BarcodeDetector.getSupportedFormats(); formats = wanted.filter((f) => ok.includes(f)); if (!formats.length) formats = ['qr_code']; } catch {}
  const det = new BarcodeDetector({ formats });
  looping = true;
  let last = '';
  let lastAt = 0;
  (async function tick() {
    while (looping && stream) {
      try {
        const codes = await det.detect(video);
        const v = codes[0] && codes[0].rawValue;
        if (v && (v !== last || Date.now() - lastAt > 4000)) { last = v; lastAt = Date.now(); await submit(v); }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
}
function stopCamera(video, btn) {
  looping = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) { video.hidden = true; video.srcObject = null; }
  if (btn) btn.textContent = 'Use camera';
}

(async function start() {
  // A scanner link carries the key after the # (never sent to the server). Take it, then drop it from the address bar.
  const m = /^#k=([^&]+)/.exec(location.hash);
  if (m) {
    cfg = { key: decodeURIComponent(m[1]) };
    info = null;
    save();
    history.replaceState(null, '', location.pathname);
  }
  if (!cfg.key) return viewKey();
  try { await ensureInfo(); cfg.zoneId ? viewScan() : viewZone(); } catch { signOut('That scanner link or key no longer works. Ask the organiser for a new one.'); }
})();
