import { h, mount, toast, copy, when, ago } from '/js/dom.js';
import { api, get, post, patch } from '/js/api.js';
import { signInFlow } from '/js/auth-ui.js';

const root = document.getElementById('app');
const state = { user: null, passes: [], waiting: [], history: [], tab: 'passes', config: {} };

const icons = {
  passes: 'M4 7h16v10H4zM4 11h16',
  add: 'M12 5v14M5 12h14',
  history: 'M12 7v5l3 2M4 12a8 8 0 1 0 3-6.2M4 4v4h4',
  me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0'
};
const icon = (name) => {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', icons[name]);
  s.append(p);
  return s;
};

// ---- QR code as inline SVG (one path, no innerHTML) --------------------------------------------
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + quiet * 2} ${n + quiet * 2}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Your Tap In pass QR code');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', n + quiet * 2);
  bg.setAttribute('height', n + quiet * 2);
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#2B1B2D');
  svg.append(bg, path);
  return svg;
}

// ---- Loading and routing -------------------------------------------------------------------------
async function refresh() {
  const r = await get('/me');
  state.user = r.user;
  state.passes = r.passes;
  state.waiting = r.waiting;
}

function shell(content, { tabs = true, title } = {}) {
  const head = h('div', { class: 'head' },
    h('a', { class: 'wordmark', href: '/' }, h('img', { src: '/logo/tap-in-app-icon.svg', alt: '' }), 'Tap In'),
    window.TapTheme.button());
  mount(root, head, h('main', { class: 'page' }, content), tabs && tabBar());
  if (title) document.title = title + ' · Tap In';
}

function tabBar() {
  const items = [['passes', 'Passes'], ['add', 'Add pass'], ['history', 'History'], ['me', 'Me']];
  return h('nav', { class: 'tabs', 'aria-label': 'Main' }, h('div', {},
    items.map(([k, label]) => h('button', { type: 'button', 'aria-current': state.tab === k ? 'page' : null, onclick: () => go(k) }, icon(k), label))));
}

async function go(tab) {
  state.tab = tab;
  if (tab === 'history') {
    try { state.history = (await get('/me/history')).scans; } catch { state.history = []; }
  }
  if (tab === 'passes') {
    try { await refresh(); } catch {}
  }
  render();
}

function render() {
  ({ passes: viewPasses, add: viewAdd, history: viewHistory, me: viewMe })[state.tab]();
}

// ---- Views ---------------------------------------------------------------------------------------
function viewWelcome() {
  mount(root,
    h('div', { class: 'head' }, h('a', { class: 'wordmark', href: '/' }, h('img', { src: '/logo/tap-in-app-icon.svg', alt: '' }), 'Tap In'), window.TapTheme.button()),
    h('main', { class: 'page hero' },
      h('p', { class: 'eyebrow' }, 'Your phone is your pass'),
      h('h1', {}, 'Walk in. No band required.'),
      h('p', {}, 'Add your invite once. At the gate, show your pass and you are in. Works for events, offices, venues and campuses.'),
      h('div', { class: 'stack', style: 'margin-top:28px' },
        h('button', { class: 'btn primary block', type: 'button', onclick: viewSignIn }, 'Get started'),
        h('p', { class: 'hint', style: 'text-align:center' }, 'Running an event? ', h('a', { href: '/organiser/' }, 'Open the organiser console')))));
}

function viewSignIn() {
  const box = h('div', { style: 'padding-top:6vh' });
  mount(root,
    h('div', { class: 'head' }, h('button', { class: 'btn ghost small', type: 'button', onclick: viewWelcome }, 'Back'), window.TapTheme.button()),
    h('main', { class: 'page' }, box));
  signInFlow(box, {
    title: 'Sign in or create your account',
    lede: 'One step. We text you a code.',
    onDone: async () => {
      await refresh();
      state.tab = state.passes.length || state.waiting.length ? 'passes' : 'add';
      render();
    }
  });
}

function passCard(p) {
  const live = p.status === 'active';
  return h('button', { class: 'pass' + (live ? '' : ' off'), type: 'button', onclick: () => live && showPass(p), 'aria-label': `Open pass for ${p.event.name}` },
    h('div', { class: 'spread' }, h('span', { class: 'eyebrow' }, p.event.starts_at ? when(p.event.starts_at, { dateStyle: 'medium' }) : 'Date to be announced'),
      live ? h('span', { class: 'chip ok' }, 'Active') : h('span', { class: 'chip bad' }, 'Cancelled')),
    h('h3', {}, p.event.name),
    h('p', { class: 'muted' }, [p.event.venue, p.event.city].filter(Boolean).join(', ') || p.tier),
    h('div', { class: 'zones' }, h('span', { class: 'chip' }, p.tier), p.zones.map((z) => h('span', { class: 'chip' }, z))),
    live && h('span', { style: 'font-weight:700' }, 'Show pass →'));
}

function viewPasses() {
  const waiting = state.waiting.map((w) => h('div', { class: 'card', style: 'border-color:var(--signal)' },
    h('p', { class: 'eyebrow' }, 'An invite is waiting for you'),
    h('h3', { style: 'margin-top:4px' }, w.event.name),
    h('p', { class: 'muted' }, w.tier + ' ticket'),
    h('button', { class: 'btn primary block', style: 'margin-top:12px', type: 'button', onclick: () => claim({ invite_id: w.id }) }, 'Add to my passes')));
  shell(h('div', { class: 'stack' },
    h('h2', {}, 'Your passes'),
    waiting,
    state.passes.length
      ? state.passes.map(passCard)
      : h('div', { class: 'empty' }, h('p', {}, 'No passes yet.'), h('button', { class: 'btn primary', style: 'margin-top:14px', type: 'button', onclick: () => go('add') }, 'Add your invite code'))), { title: 'Passes' });
}

function viewAdd(err = '') {
  const input = h('input', { class: 'input code', id: 'code', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'PGF-26-VIP-7K4Q-9XM2', 'aria-describedby': 'code-hint' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Add pass');
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); btn.disabled = true; claim({ code: input.value }, btn); } },
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Invite code'), input,
      h('p', { class: 'hint', id: 'code-hint' }, 'Type it exactly as sent, or paste it. Capitals, spaces and dashes do not matter.')),
    err && h('div', { class: 'error', role: 'alert' }, err),
    h('div', { style: 'margin-top:16px' }, btn));
  shell(h('div', {}, h('h2', {}, 'Add a pass'), h('p', { class: 'muted', style: 'margin-top:6px' }, 'Enter the invite code the organiser sent you. Each code works once.'), form), { title: 'Add pass' });
  input.focus();
}

async function claim(body, btn) {
  try {
    const r = await post('/claim', body);
    await refresh();
    state.tab = 'passes';
    render();
    toast('Pass added');
    showPass(r.pass);
  } catch (ex) {
    if (btn) btn.disabled = false;
    if (ex.status === 401) return viewSignIn();
    if (body.code) viewAdd(ex.message);
    else toast(ex.message);
  }
}

function showPass(p) {
  const prevBodyOverflow = document.body.style.overflow;
  const close = () => { overlay.remove(); document.body.style.overflow = prevBodyOverflow; };
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Pass for ' + p.event.name },
    h('div', { class: 'spread', style: 'width:100%;max-width:460px' }, h('button', { class: 'btn ghost small', type: 'button', onclick: close }, 'Close'), h('span', { class: 'chip' }, p.tier)),
    h('h2', { style: 'margin-top:14px;text-align:center' }, p.event.name),
    h('p', { class: 'muted', style: 'text-align:center' }, state.user.name || ''),
    h('div', { class: 'qrbox' }, qrSvg(p.token)),
    h('p', { class: 'token' }, p.token),
    h('div', { class: 'zones', style: 'margin-top:12px;justify-content:center' }, p.zones.map((z) => h('span', { class: 'chip' }, z))),
    h('p', { class: 'hint', style: 'margin-top:14px;text-align:center;max-width:320px' }, 'Hold this up to the scanner. If the scanner cannot read it, staff can type the code under the picture.'),
    h('button', { class: 'btn ghost small', style: 'margin-top:12px', type: 'button', onclick: () => copy(p.token, 'Pass code copied') }, 'Copy pass code'));
  document.body.style.overflow = 'hidden';
  document.body.append(overlay);
  overlay.querySelector('button').focus();
  overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}

function viewHistory() {
  const reasons = { already_used: 'Already used', no_zone_access: 'Not allowed in this area', revoked: 'Pass cancelled', invalid_token: 'Not recognised', wrong_event: 'Wrong event' };
  shell(h('div', { class: 'stack' }, h('h2', {}, 'History'),
    state.history.length
      ? h('div', { class: 'list' }, state.history.map((s) => h('div', { class: 'item' },
          h('div', {}, h('strong', {}, s.event_name), h('div', { class: 'hint' }, s.zone || ''),
            s.result === 'denied' && h('div', { class: 'hint' }, reasons[s.reason] || 'Declined')),
          h('div', { style: 'text-align:right' }, h('span', { class: 'chip ' + (s.result === 'granted' ? 'ok' : 'bad') }, s.result === 'granted' ? 'Entered' : 'Declined'), h('div', { class: 'hint' }, ago(s.at))))))
      : h('div', { class: 'empty' }, 'Nothing yet. Entries show up here after you are scanned in.')), { title: 'History' });
}

function viewMe() {
  const name = h('input', { class: 'input', id: 'nm', value: state.user.name || '', maxlength: '80', autocomplete: 'name' });
  shell(h('div', { class: 'stack' }, h('h2', {}, 'Me'),
    h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); try { state.user = (await patch('/me', { name: name.value })).user; toast('Saved'); } catch (ex) { toast(ex.message); } } },
      h('div', { class: 'field', style: 'margin-top:0' }, h('label', { for: 'nm' }, 'Name'), name),
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'Signed in as ' + state.user.identifier),
      h('button', { class: 'btn primary small', style: 'margin-top:12px', type: 'submit' }, 'Save name')),
    state.config.otp_mode === 'demo' && h('div', { class: 'notice warn' }, 'Demo mode: sign-in codes are shown on screen instead of being texted. This is for trying Tap In out.'),
    h('div', { class: 'row' }, h('a', { class: 'btn ghost', href: '/organiser/' }, 'Organiser console'),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await post('/auth/logout').catch(() => {}); state.user = null; state.passes = []; viewWelcome(); } }, 'Sign out'))), { title: 'Me' });
}

// ---- Start ---------------------------------------------------------------------------------------
(async function start() {
  const splash = h('div', { class: 'splash', 'aria-hidden': 'true' }, h('img', { src: '/logo/tap-in-animated.svg', alt: '' }));
  document.body.append(splash);
  setTimeout(() => splash.remove(), 2500);
  state.config = await get('/config').catch(() => ({}));
  if (state.config.configured === false) {
    mount(root, h('main', { class: 'page hero' }, h('h1', {}, 'Almost there'), h('p', { class: 'muted', style: 'margin-top:12px' }, 'The server is running but its SECRET_PEPPER secret is not set yet. See the README, "Set the secret".')));
    return;
  }
  try {
    await refresh();
    state.tab = state.passes.length || state.waiting.length ? 'passes' : 'add';
    render();
  } catch (ex) {
    viewWelcome();
  }
})();
