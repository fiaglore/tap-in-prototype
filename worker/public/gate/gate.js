import { h, wordmarkText, mount, when } from '/js/dom.js';
import { ApiError, get, post } from '/js/api.js';
import { identify, withinSchedule } from '/js/offline.js';

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
function signOut(msg = '') {
  // Unsent offline scans stay queued for the next sign-in on this phone; the saved ticket list does not.
  cfg = {}; info = null; recent = []; save(); dropPack(); viewKey(msg);
}

// ---- Offline ---------------------------------------------------------------------------------------------
// The scanner keeps the event's ticket list on the phone (refreshed every minute while online). With no signal it
// decides each scan itself with the same rules as the server, queues the result, and sends the queue when the
// signal is back. Two scanners that are both offline cannot see each other's entries; the report marks any
// ticket that got in twice that way.
const PACK = 'tapin-gate-pack';
const QUEUE = 'tapin-gate-queue';
const MESSAGES = {
  invalid_token: 'Not a valid Tap In pass.', revoked: 'This pass was cancelled.', no_zone_access: 'This pass does not include this area.',
  already_used: 'This pass has already been used here.', expired: 'This pass has expired.', stale_code: 'This pass code is out of date. Ask them to reopen their pass.',
  static_pass: 'This event needs the live code from the app. Screenshots and printed codes do not work.', outside_hours: 'This pass is not valid at this time.',
  use_wristband: 'Wristbands were made for this ticket. Scan their wristband instead.'
};
let pack = null;        // { data, fetched_at, offset }
let idx = null;         // lookups built from the pack
let offline = false;
let syncing = false;
let paintStatus = () => {};
const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const queue = () => readJSON(QUEUE, []);
function dropPack() { pack = null; idx = null; try { localStorage.removeItem(PACK); } catch {} }
function index() {
  const d = pack.data;
  idx = {
    passes: new Map(d.passes.map((p) => [p.id, p])),
    guests: new Map(d.guests.map((g) => [g.id, g])),
    codes: new Map(d.guests.filter((g) => g.code_hash).map((g) => [g.code_hash, g])),
    tiers: new Map(d.tiers.map((t) => [t.id, t])),
    entered: new Map(d.entries.map((e) => [e.ref + '|' + e.zone_id, e.at]))
  };
  for (const q of queue()) if (q.result === 'granted' && q.event_id === d.event.id && !idx.entered.has(q.ref + '|' + q.zone_id)) idx.entered.set(q.ref + '|' + q.zone_id, q.at);
}
function usePack(p) { pack = p; index(); }
async function refreshPack() {
  const d = await get('/gate/list', auth());
  const p = { data: d, fetched_at: Date.now(), offset: d.generated_at - Date.now() / 1000 };
  if (!writeJSON(PACK, p)) console.warn('Could not save the ticket list on this phone');
  usePack(p);
}
const gateNow = () => Math.floor(Date.now() / 1000 + (pack ? pack.offset : 0));
const randomId = () => { const B = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => B[b & 31]).join(''); };

// Decide a scan with no signal, exactly as the server would from the saved list.
async function decideOffline(token, zone) {
  const d = pack.data, ev = d.event, now = gateNow();
  const code = await identify(token, d.key, now);
  let h0 = null, ref = null, reason = null, kind = null;
  if (code.kind === 'pass') { h0 = idx.passes.get(code.id); ref = 'p:' + code.id; }
  else if (code.kind === 'guest') { h0 = idx.guests.get(code.id); ref = 'g:' + code.id; kind = h0 && h0.kind; }
  else { h0 = idx.codes.get(code.hash); ref = h0 ? 'g:' + h0.id : null; kind = 'import'; }
  if (code.kind === 'pass' && code.live && code.unverified) reason = 'stale_code'; // server-made live codes can't be checked offline
  else if (!h0) reason = 'invalid_token';
  else if (h0.status !== 'active') reason = 'revoked';
  else if (h0.wristbanded) reason = 'use_wristband';
  else if (code.kind === 'pass' && ev.secure_qr && !code.rolling) reason = 'static_pass';
  else if (code.stale) reason = 'stale_code';
  else if (h0.expires_at && h0.expires_at <= now) reason = 'expired';
  else if (h0.valid_until && h0.valid_until <= now) reason = 'expired';
  else if (h0.valid_from && now < h0.valid_from) reason = 'outside_hours';
  else {
    const tier = idx.tiers.get(h0.tier_id);
    if (!tier || !withinSchedule(tier, now, ev.tz_offset_min)) reason = 'outside_hours';
    else if (!tier.zones.includes(zone.id)) reason = 'no_zone_access';
  }
  let previous = null;
  if (!reason && !ev.allow_reentry && idx.entered.has(ref + '|' + zone.id)) { reason = 'already_used'; previous = idx.entered.get(ref + '|' + zone.id); }
  const granted = !reason;
  if (granted && !idx.entered.has(ref + '|' + zone.id)) idx.entered.set(ref + '|' + zone.id, now);
  const q = queue();
  q.push({ id: randomId(), event_id: ev.id, ref: h0 ? ref : null, zone_id: zone.id, result: granted ? 'granted' : 'denied', reason, at: now });
  writeJSON(QUEUE, q);
  const tier = h0 && idx.tiers.get(h0.tier_id);
  return {
    offline: true, result: granted ? 'granted' : 'denied', reason, message: granted ? 'Welcome in.' : MESSAGES[reason],
    holder: h0 ? h0.holder : null, tier: tier ? tier.name : null, zone: zone.name, previous_at: previous,
    ...(h0 && code.kind !== 'pass' ? { guest: kind || h0.kind, party: h0.party, table: h0.table, rsvp: h0.rsvp, host: h0.host } : {}),
    ...(ev.require_photo && h0 ? { photo: null, photo_missing: true } : {})
  };
}

// Send queued offline scans, then fetch a fresh list. Quietly does nothing with no signal.
async function syncNow() {
  if (syncing || !cfg.key) return;
  syncing = true;
  try {
    let q = queue();
    const mine = (x) => !pack || x.event_id === pack.data.event.id;
    while (q.some(mine)) {
      const batch = q.filter(mine).slice(0, 500);
      await post('/gate/sync', { scans: batch.map(({ event_id, ...rest }) => rest) }, auth());
      const sent = new Set(batch.map((x) => x.id));
      q = queue().filter((x) => !sent.has(x.id));
      writeJSON(QUEUE, q);
    }
    await refreshPack();
    offline = false;
  } catch (ex) {
    if (ex.status === 0) offline = true;
    else if (ex.status === 401) { syncing = false; return signOut('This scanner is no longer signed in. Ask the organiser for a new scanner link.'); }
  }
  syncing = false;
  paintStatus();
}
setInterval(syncNow, 60000);
window.addEventListener('online', syncNow);
window.addEventListener('offline', () => { offline = true; paintStatus(); });

// A scan with a time limit: on a weak signal, decide offline rather than keep the queue waiting.
function postScan(body) {
  return Promise.race([post('/gate/scan', body, auth()), new Promise((_, rej) => setTimeout(() => rej(new ApiError(0, 'timeout', 'No answer from Tap In.')), 6000))]);
}
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
      let r;
      try {
        if (navigator.onLine === false) throw new ApiError(0, 'network', 'offline');
        r = await postScan({ token: t, zone_id: zone.id });
        if (offline) { offline = false; syncNow(); }
      } catch (ex) {
        if (ex.status !== 0 || !pack) throw ex;
        offline = true;
        r = await decideOffline(t, zone);
      }
      paintStatus();
      recent.unshift(r);
      recent = recent.slice(0, 8);
      paintResult(resBox, r);
      paintRecent();
      beep(r.result === 'granted');
    } catch (ex) {
      if (ex.status === 401) return signOut('This scanner is no longer signed in. Ask the organiser for a new scanner link.');
      paintResult(resBox, { result: 'error', message: ex.status === 0 ? 'No signal, and this phone has no saved ticket list yet. Connect once so the list can download.' : ex.message });
    }
    input.value = '';
    input.disabled = false;
    input.focus();
  }

  const recentBox = h('div', { class: 'recent' });
  function paintRecent() {
    mount(recentBox, recent.map((r) => h('div', { class: 'item' }, h('span', {}, r.holder || 'Unknown pass'), h('span', { class: r.result === 'granted' ? 'chip ok' : 'chip bad' }, r.result === 'granted' ? 'Entered' : 'Declined'))));
  }

  // Online or offline, how fresh the saved list is, and how many scans are waiting to be sent.
  const statusBox = h('div', { class: 'netstatus', role: 'status' });
  paintStatus = () => {
    const waiting = queue().length;
    const age = pack ? Math.round((Date.now() - pack.fetched_at) / 60000) : null;
    const nSaved = pack ? pack.data.passes.length + pack.data.guests.length : 0;
    const listTxt = pack ? `${nSaved} ${nSaved === 1 ? 'ticket' : 'tickets'} saved ${age < 1 ? 'just now' : age + ' min ago'}` : 'Ticket list not saved yet';
    mount(statusBox, h('span', { class: 'dot ' + (offline ? 'off' : 'on') }), h('strong', {}, offline ? 'No signal: checking against the saved list' : 'Online'),
      h('span', { class: 'hint' }, ` \u00b7 ${listTxt}${waiting ? ` \u00b7 ${waiting} scan${waiting === 1 ? '' : 's'} waiting to send` : ''}`),
      !offline && waiting > 0 && h('button', { class: 'linkbtn', style: 'margin-left:6px', type: 'button', onclick: syncNow }, 'Send now'));
  };
  paintStatus();

  mount(main, h('div', { class: 'narrow' },
    statusBox,
    h('div', { class: 'spread' }, h('div', {}, h('p', { class: 'eyebrow' }, info.event.name), h('h2', {}, zone.name)),
      h('button', { class: 'btn ghost small', type: 'button', onclick: viewZone }, 'Change area')),
    h('form', { style: 'margin-top:14px', onsubmit: (e) => { e.preventDefault(); submit(input.value); } }, input,
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Check pass'), camBtn,
        info.event.kind === 'workplace' && h('button', { class: 'btn ghost', type: 'button', onclick: () => walkIn(zone, resBox, paintRecent) }, 'Walk-in visitor'))),
    video, resBox,
    h('h3', { style: 'margin-top:18px' }, 'Recent'), recentBox, whoBar()));
  paintRecent();
  input.focus();
  // USB / bluetooth scanners type the code and press Enter; keep focus on the box.
  main.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A') input.focus(); });
}

// Offices: someone arrives without a pass. Record them, let them in, and (if they gave a phone) send them a pass
// that works until the end of the day.
function walkIn(zone, resBox, paintRecent) {
  const tiers = info.tiers || [];
  const guess = tiers.find((t) => /visit|guest/i.test(t.name)) || tiers[0];
  const name = h('input', { class: 'input', id: 'wn', autocomplete: 'off', required: true, maxlength: '80' });
  const contact = h('input', { class: 'input', id: 'wc', autocomplete: 'off', inputmode: 'tel', placeholder: 'Optional' });
  const host = h('input', { class: 'input', id: 'wh', autocomplete: 'off', maxlength: '80', placeholder: 'Who are they here to see?' });
  const purpose = h('input', { class: 'input', id: 'wp', autocomplete: 'off', maxlength: '120', placeholder: 'Optional, e.g. delivery, interview' });
  const group = h('select', { class: 'input', id: 'wg' }, tiers.map((t) => h('option', { value: t.id, selected: guess && t.id === guess.id }, t.name)));
  const err = h('div', {});
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Walk-in visitor' },
    h('form', { class: 'card', style: 'width:min(92vw,440px)', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await post('/gate/walkin', { name: name.value, contact: contact.value || undefined, host: host.value || undefined, purpose: purpose.value || undefined, tier_id: group.value, zone_id: zone.id }, auth());
        close();
        recent.unshift(r); recent = recent.slice(0, 8);
        paintResult(resBox, r); paintRecent(); beep(true);
      } catch (ex) {
        mount(err, h('div', { class: 'error', role: 'alert' }, ex.status === 0 ? 'Walk-ins need a connection. Note their details and add them when the signal is back.' : ex.message));
      }
    } },
      h('h2', {}, 'Walk-in visitor'),
      h('p', { class: 'muted', style: 'margin-top:4px' }, 'They are let in now and their visit is on record. A phone number lets you send them a pass for the rest of the day.'),
      h('div', { class: 'field' }, h('label', { for: 'wn' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'wh' }, 'Visiting'), host),
      h('div', { class: 'field' }, h('label', { for: 'wc' }, 'Phone or email'), contact),
      h('div', { class: 'field' }, h('label', { for: 'wp' }, 'Reason'), purpose),
      h('div', { class: 'field' }, h('label', { for: 'wg' }, 'Group'), group),
      err,
      h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Check in'), h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel'))));
  overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.body.append(overlay);
  name.focus();
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
    r.host && h('p', { style: 'font-weight:700' }, 'Visiting: ' + r.host),
    r.tier && h('p', { class: 'muted' }, r.tier + (r.zone ? ' · ' + r.zone : '') + (r.guest === 'import' ? ' · imported ticket' : r.guest === 'invite' ? ' · guest list' : r.guest === 'visitor' ? (r.walk_in ? ' · walk-in visitor' : ' · visitor') : '')),
    r.walk_in && r.link && h('div', { class: 'row', style: 'justify-content:center;margin-top:10px' },
      h('a', { class: 'btn ghost small', target: '_blank', rel: 'noopener', href: `https://wa.me/${r.contact && r.contact.startsWith('+') ? r.contact.slice(1) : ''}?text=${encodeURIComponent('Your visitor pass for today. Show it at the door if you step out and come back: ' + r.link)}` }, 'Send their pass on WhatsApp')),
    ok && r.rsvp === 'no' && h('div', { class: 'notice warn', style: 'margin:10px auto;max-width:340px' }, 'They told the host they could not come. Check with the host if unsure.'),
    h('p', { style: 'margin-top:8px' }, r.message),
    r.previous_at && h('p', { class: 'hint' }, 'First used at ' + when(r.previous_at, { timeStyle: 'short' })),
    r.offline && h('p', { class: 'hint' }, 'Decided offline from the saved list. It will be sent when the signal is back.')));
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/gate/sw.js', { scope: '/gate/' }).catch(() => {});
  const saved = readJSON(PACK, null);
  try {
    await ensureInfo();
    if (saved && saved.data.event.id === info.event.id) usePack(saved);
    syncNow(); // sends anything left from last time and saves a fresh list
    cfg.zoneId ? viewScan() : viewZone();
  } catch (ex) {
    // No signal on start-up: carry on from the saved list if there is one.
    if (ex.status === 0 && saved) {
      usePack(saved);
      offline = true;
      info = { event: saved.data.event, zones: saved.data.zones, steward: saved.data.steward };
      return cfg.zoneId ? viewScan() : viewZone();
    }
    signOut(ex.status === 0 ? 'No signal. Connect once to sign this scanner in.' : 'That scanner link or key no longer works. Ask the organiser for a new one.');
  }
})();
