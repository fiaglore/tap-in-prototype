import { h, wordmarkText, mount } from '/js/dom.js';
import { get, post } from '/js/api.js';

const top = document.getElementById('top');
const main = document.getElementById('main');
const KEY = 'tapin-till';
let cfg = load(); // { key }
let vendor = null;
let recent = [];
let stream = null;
let looping = false;

function load() { try { return JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save() { try { sessionStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} }
const auth = () => ({ Authorization: 'Bearer ' + cfg.key });
const naira = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: kobo % 100 ? 2 : 0, maximumFractionDigits: 2 });

mount(top, h('a', { class: 'wordmark', href: '/' }, h('img', { src: '/logo/tap-in-app-icon.svg', alt: '' }), wordmarkText(), ' ', h('span', { class: 'muted', style: 'font-weight:600;font-size:14px' }, 'Till')), window.TapTheme.button());

function viewKey(err = '') {
  stopCamera();
  const input = h('input', { class: 'input code', id: 'tk', autocomplete: 'off', spellcheck: 'false', placeholder: 'TK-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' });
  mount(main, h('div', { class: 'narrow card', style: 'margin-top:4vh' },
    h('h2', {}, 'Tap In till'),
    h('p', { class: 'muted', style: 'margin-top:6px' }, 'Enter the till key from your vendor console. It stays on this device only until you close this tab.'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      cfg = { key: input.value.trim() };
      try { vendor = (await get('/till/info', auth())).vendor; save(); viewCharge(); } catch (ex) { viewKey(ex.message); }
    } },
      h('div', { class: 'field' }, h('label', { for: 'tk' }, 'Till key'), input),
      err && h('div', { class: 'error', role: 'alert' }, err),
      h('button', { class: 'btn primary block', style: 'margin-top:16px', type: 'submit' }, 'Continue'))));
  input.focus();
}

function viewCharge(result) {
  const input = h('input', { class: 'input scanin', id: 'pc', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Scan or type the pay code', 'aria-label': 'Pay code' });
  const resBox = h('div', { id: 'res' });
  paint(resBox, result);
  const video = h('video', { class: 'video', playsinline: true, muted: true, hidden: true });
  const camBtn = h('button', { class: 'btn ghost small', type: 'button' }, 'Use camera');
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) camBtn.hidden = true;
  camBtn.onclick = () => (stream ? stopCamera(video, camBtn) : startCamera(video, camBtn, submit));

  async function submit(code) {
    const c = String(code || '').trim();
    if (!c) return;
    input.disabled = true;
    try {
      const r = await post('/till/charge', { code: c }, auth());
      recent.unshift(r);
      recent = recent.slice(0, 8);
      paint(resBox, r);
      paintRecent();
      beep(r.result === 'paid');
    } catch (ex) {
      if (ex.status === 401) { cfg = {}; vendor = null; save(); return viewKey('The till key is no longer valid. Get the current one from your vendor console.'); }
      paint(resBox, { result: 'error', message: ex.message });
    }
    input.value = '';
    input.disabled = false;
    input.focus();
  }

  const recentBox = h('div', { class: 'recent' });
  function paintRecent() {
    mount(recentBox, recent.map((r) => h('div', { class: 'item' }, h('span', {}, (r.customer || 'Unknown') + (r.amount_kobo ? ' · ' + naira(r.amount_kobo) : '')), h('span', { class: r.result === 'paid' ? 'chip ok' : 'chip bad' }, r.result === 'paid' ? 'Paid' : 'Declined'))));
  }

  mount(main, h('div', { class: 'narrow' },
    h('div', { class: 'spread' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Taking payments'), h('h2', {}, vendor.name)),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { cfg = {}; vendor = null; save(); viewKey(); } }, 'Use a different key')),
    h('form', { style: 'margin-top:14px', onsubmit: (e) => { e.preventDefault(); submit(input.value); } }, input,
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Charge'), camBtn)),
    video, resBox,
    h('h3', { style: 'margin-top:18px' }, 'Recent'), recentBox));
  paintRecent();
  input.focus();
  main.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A') input.focus(); });
}

function paint(box, r) {
  if (!r) return mount(box, h('p', { class: 'muted', style: 'text-align:center;margin:28px 0' }, 'Ready. Ask the customer to show their pay code.'));
  if (r.result === 'error') return mount(box, h('div', { class: 'error', role: 'alert' }, r.message));
  const ok = r.result === 'paid';
  mount(box, h('div', { class: 'result ' + (ok ? 'granted' : 'denied'), role: 'status' },
    h('div', { class: 'big' }, ok ? naira(r.amount_kobo) + ' received' : 'Not paid'),
    r.customer && h('p', { style: 'font-size:22px;font-weight:700;margin-top:8px' }, r.customer),
    h('p', { style: 'margin-top:8px' }, r.message),
    !ok && r.amount_kobo && h('p', { class: 'hint' }, 'They were paying ' + naira(r.amount_kobo))));
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
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { btn.textContent = 'Camera blocked'; return; }
  video.srcObject = stream;
  video.hidden = false;
  await video.play().catch(() => {});
  btn.textContent = 'Stop camera';
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  looping = true;
  let last = '';
  let lastAt = 0;
  (async function tick() {
    while (looping && stream) {
      try {
        const codes = await det.detect(video);
        const v = codes[0] && codes[0].rawValue;
        // A pay code works once, so rescanning the same one (while it stays in view) is harmless.
        if (v && (v !== last || Date.now() - lastAt > 6000)) { last = v; lastAt = Date.now(); await submit(v); }
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
  if (!cfg.key) return viewKey();
  try { vendor = (await get('/till/info', auth())).vendor; viewCharge(); } catch { cfg = {}; save(); viewKey('That key no longer works.'); }
})();
