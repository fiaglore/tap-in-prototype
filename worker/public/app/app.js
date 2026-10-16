import { h, wordmarkText, mount, toast, copy, when, ago } from '/js/dom.js';
import { get, post, patch } from '/js/api.js';
import { signInFlow } from '/js/auth-ui.js';
import { cardEl, cardNumber, loadCard, saveCard, sanitise, PRESETS, SWATCHES, FINISHES, PATTERNS, TYPES } from '/js/card.js';
import { orbitSvg, nextIndex, daysTo } from '/app/orbit.js';

const root = document.getElementById('app');
const state = { user: null, passes: [], waiting: [], history: [], tab: 'around', config: {}, sel: null, ctx: [] };
const ONB = 'tapin-onboarded';
const flag = (v) => { try { if (v === undefined) return localStorage.getItem(ONB) === '1'; v ? localStorage.setItem(ONB, '1') : localStorage.removeItem(ONB); } catch { return false; } };

const NS = 'http://www.w3.org/2000/svg';
const icons = {
  around: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z',
  passes: 'M4 7h16v10H4zM4 11h16',
  add: 'M12 5v14M5 12h14',
  history: 'M12 7v5l3 2M4 12a8 8 0 1 0 3-6.2M4 4v4h4',
  me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0'
};
const icon = (name) => {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
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
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + quiet * 2} ${n + quiet * 2}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Your Tap In pass QR code');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', n + quiet * 2);
  bg.setAttribute('height', n + quiet * 2);
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#2B1B2D');
  svg.append(bg, path);
  return svg;
}

// ---- Data ----------------------------------------------------------------------------------------
async function refresh() {
  const r = await get('/me');
  state.user = r.user;
  state.passes = r.passes;
  state.waiting = r.waiting;
}
const firstName = () => (state.user && state.user.name ? state.user.name.trim().split(/\s+/)[0] : 'there');
const cardInfo = (status = 'Active') => ({ name: (loadCard().name || (state.user && state.user.name) || 'Your name').slice(0, 16), num: cardNumber(state.user && state.user.id), status });

// ---- Shell with bottom tabs ----------------------------------------------------------------------
function shell(content, { tabs = true, title } = {}) {
  const head = h('div', { class: 'head' },
    h('a', { class: 'wordmark', href: '/' }, h('img', { src: '/logo/tap-in-app-icon.svg', alt: '' }), wordmarkText()),
    window.TapTheme.button());
  mount(root, head, h('main', { class: 'page' }, content), tabs && tabBar());
  if (title) document.title = title + ' · Tap In';
  window.scrollTo(0, 0);
}
function tabBar() {
  const items = [['around', 'Around me'], ['passes', 'Passes'], ['add', 'Add'], ['history', 'History'], ['me', 'Me']];
  return h('nav', { class: 'tabs', 'aria-label': 'Main' }, h('div', {},
    items.map(([k, label]) => h('button', { type: 'button', 'aria-current': state.tab === k ? 'page' : null, onclick: () => go(k) }, icon(k), label))));
}
async function go(tab) {
  state.tab = tab;
  if (tab === 'history') { try { state.history = (await get('/me/history')).scans; } catch { state.history = []; } }
  if (tab === 'around' || tab === 'passes') { try { await refresh(); } catch (ex) { if (ex.status === 401) return onboarding('signin'); } }
  render();
}
function render() {
  ({ around: viewAround, passes: viewPasses, add: viewAdd, history: viewHistory, me: viewMe, custom: viewCustom })[state.tab]();
}

// ---- Onboarding ----------------------------------------------------------------------------------
const CONTEXTS = ['Festivals', 'Concerts', 'Clubs', 'Offices & doors', 'Conferences', 'Art & culture'];
const STEPS = ['ctx', 'signin', 'passes', 'protect', 'practice'];

function onbShell(step, ...kids) {
  const n = STEPS.indexOf(step) + 1;
  const head = h('div', { class: 'head' },
    n > 1 ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => onboarding(prevStep(step)) }, 'Back') : h('a', { class: 'wordmark', href: '/' }, h('img', { src: '/logo/tap-in-app-icon.svg', alt: '' }), wordmarkText()),
    window.TapTheme.button());
  mount(root, head, h('main', { class: 'page onb' },
    n > 0 && h('div', { class: 'seg3', 'aria-hidden': 'true' }, STEPS.map((_, i) => h('i', { class: i < n ? 'on' : '' }))),
    n > 0 && h('p', { class: 'eyebrow' }, `Step ${n} of ${STEPS.length}`),
    ...kids));
  window.scrollTo(0, 0);
}
function prevStep(step) {
  const i = STEPS.indexOf(step);
  let p = STEPS[Math.max(0, i - 1)];
  if (p === 'signin' && state.user) p = 'ctx';
  return p;
}
function nextStep(step) {
  const i = STEPS.indexOf(step);
  let nx = STEPS[i + 1];
  if (nx === 'signin' && state.user) nx = 'passes';
  return nx;
}

function onboarding(step) {
  if (step === 'welcome') return stepWelcome();
  if (step === 'ctx') return stepCtx();
  if (step === 'signin') return stepSignIn();
  if (step === 'passes') return stepPasses();
  if (step === 'protect') return stepProtect();
  if (step === 'practice') return stepPractice();
  stepWelcome();
}

function stepWelcome() {
  mount(root,
    h('div', { class: 'head' }, h('a', { class: 'wordmark', href: '/' }, h('img', { src: '/logo/tap-in-app-icon.svg', alt: '' }), wordmarkText()), window.TapTheme.button()),
    h('main', { class: 'page hero' },
      h('p', { class: 'eyebrow' }, 'Your phone is your pass'),
      h('h1', {}, 'No bands.', h('br'), 'No paper.', h('br'), 'Just tap in.'),
      h('p', {}, 'One app for festival gates, office doors and the guest list at the club. Your pass is ready on your phone when you arrive.'),
      h('div', { class: 'obc' }, cardEl(loadCard(), { name: 'Your name', num: 'TI •••• 0173', status: 'Ready' })),
      h('div', { class: 'stack' },
        h('button', { class: 'btn primary block', type: 'button', onclick: () => onboarding('ctx') }, 'Get started'),
        h('button', { class: 'btn ghost block', type: 'button', onclick: () => { state.user ? onboarding('passes') : onboarding('signin'); } }, 'I have an invite code'),
        h('p', { class: 'hint', style: 'text-align:center' }, 'Running an event? ', h('a', { href: '/organiser/' }, 'Open the organiser console')))));
}

function stepCtx() {
  const row = h('div', { class: 'chips' });
  const paint = () => row.replaceChildren(...CONTEXTS.map((c) => h('button', { type: 'button', class: 'chip' + (state.ctx.includes(c) ? ' on' : ''), 'aria-pressed': state.ctx.includes(c) ? 'true' : 'false', onclick: () => { const i = state.ctx.indexOf(c); i < 0 ? state.ctx.push(c) : state.ctx.splice(i, 1); paint(); } }, c)));
  paint();
  onbShell('ctx',
    h('h1', { class: 'ob' }, 'Where will you tap in?'),
    h('p', { class: 'muted' }, 'Pick what you will use Tap In for. This only tunes what we show you first.'),
    row,
    h('button', { class: 'btn primary block', style: 'margin-top:24px', type: 'button', onclick: () => onboarding(nextStep('ctx')) }, 'Continue'));
}

function stepSignIn() {
  const box = h('div', { style: 'padding-top:4px' });
  onbShell('signin', box);
  signInFlow(box, {
    title: 'Sign in or create your account',
    lede: 'One step. We send you a code.',
    onDone: async () => {
      await refresh();
      onboarding('passes');
    }
  });
}

function stepPasses() {
  const list = h('div', { class: 'stack' });
  const err = h('div', { role: 'alert' });
  const input = h('input', { class: 'input code', id: 'obcode', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Invite code, e.g. PGF-26-VIP-7K4Q-9XM2' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Add pass');
  async function claim(body) {
    try {
      await post('/claim', body);
      await refresh();
      toast('Pass added');
      stepPasses();
    } catch (ex) {
      btn.disabled = false;
      if (ex.status === 401) return onboarding('signin');
      mount(err, h('div', { class: 'error' }, ex.message));
    }
  }
  mount(list,
    state.waiting.map((w) => h('div', { class: 'fld2' }, h('div', {}, h('b', {}, w.event.name), h('div', { class: 'hint' }, w.tier + ' ticket · invite waiting for you')), h('button', { class: 'btn small primary', type: 'button', onclick: () => claim({ invite_id: w.id }) }, 'Add'))),
    state.passes.map((p) => h('div', { class: 'fld2' }, h('div', {}, h('b', {}, p.event.name), h('div', { class: 'hint' }, p.tier + (p.status === 'active' ? '' : ' · cancelled'))), h('span', { class: 'chip ok' }, 'On your card'))));
  if (!state.waiting.length && !state.passes.length) list.replaceChildren(h('p', { class: 'muted' }, 'Nothing is linked to your number or email yet. If you were sent an invite code, enter it below.'));
  onbShell('passes',
    h('h1', { class: 'ob' }, 'Find your passes'),
    h('p', { class: 'muted' }, 'Invites sent to your phone number or email show up here. You can also type an invite code.'),
    list,
    h('form', { onsubmit: (e) => { e.preventDefault(); btn.disabled = true; mount(err); claim({ code: input.value }); } },
      h('div', { class: 'field' }, h('label', { for: 'obcode' }, 'Invite code'), input), err, h('div', { style: 'margin-top:12px' }, btn)),
    h('button', { class: 'btn ghost block', style: 'margin-top:18px', type: 'button', onclick: () => onboarding('protect') }, state.passes.length ? 'Continue' : 'Skip for now'));
}

function stepProtect() {
  const item = (t, d) => h('div', { class: 'fld2', style: 'cursor:default' }, h('div', {}, h('b', {}, t), h('div', { class: 'hint' }, d)));
  onbShell('protect',
    h('h1', { class: 'ob' }, 'How your pass is protected'),
    h('p', { class: 'muted' }, 'Here is what Tap In does today, so you know what to expect.'),
    item('Each invite works once', 'Once you add an invite code, nobody else can use it.'),
    item('Signed-in phone only', 'Your pass shows after you sign in with a code sent to your number or email.'),
    item('Gate staff see little', 'Only your first name, last initial and ticket type. Not your phone number or email.'),
    item('Do not share screenshots', 'A pass works until it is scanned in at an area, so keep it to yourself.'),
    h('button', { class: 'btn primary block', style: 'margin-top:20px', type: 'button', onclick: () => onboarding('practice') }, 'Continue'));
}

function stepPractice() {
  const out = h('div', {});
  let busy = false;
  const ring = h('button', { class: 'tapz', type: 'button', 'aria-label': 'Practice scan', onclick: () => {
    if (busy) return;
    busy = true;
    ring.classList.add('go');
    mount(out, h('p', { class: 'muted', style: 'text-align:center' }, 'Reading…'));
    setTimeout(() => {
      ring.classList.remove('go');
      busy = false;
      mount(out, h('div', { class: 'result granted' }, h('div', { class: 'big' }, 'Let them in'), h('p', { class: 'muted', style: 'margin-top:6px' }, 'That was a practice scan. Nothing was recorded.')),
        h('button', { class: 'btn primary block', type: 'button', onclick: finishOnboarding }, 'Go to Around me'));
      if (navigator.vibrate) navigator.vibrate(30);
    }, 900);
  } }, h('div', { class: 'ringc' }, '◉'), h('span', {}, 'Tap the reader to practise'));
  onbShell('practice',
    h('h1', { class: 'ob' }, 'Try one scan'),
    h('p', { class: 'muted' }, 'Real gates read the QR on your pass. Practise what a successful entry looks like. No ticket needed.'),
    ring, out,
    h('button', { class: 'btn ghost block', style: 'margin-top:12px', type: 'button', onclick: finishOnboarding }, 'Skip'));
}

async function finishOnboarding() {
  flag(true);
  try { await refresh(); } catch (ex) { if (ex.status === 401) return onboarding('signin'); }
  state.tab = state.passes.length ? 'around' : 'add';
  render();
}

// ---- Around me -----------------------------------------------------------------------------------
function viewAround() {
  if (!state.passes.length) {
    return shell(h('div', { class: 'stack' }, h('h2', {}, 'Hello, ' + firstName() + '.'), state.waiting.length && waitingCards(),
      h('div', { class: 'empty' }, h('p', {}, 'No passes yet.'), h('button', { class: 'btn primary', style: 'margin-top:14px', type: 'button', onclick: () => go('add') }, 'Add your invite code'))), { title: 'Around me' });
  }
  const sel = state.sel != null && state.passes[state.sel] ? state.sel : nextIndex(state.passes);
  const p = state.passes[sel];
  const d = daysTo(p.event.starts_at);
  const live = p.status === 'active';
  let status;
  if (!live) status = 'This pass was cancelled. Contact the organiser.';
  else if (d === null) status = 'Date to be announced. Your pass is ready.';
  else if (d < 0) status = 'This event has passed.';
  else if (d === 0) status = 'Today. Open your pass at the gate.';
  else status = 'Your pass is ready. Open it at the gate.';
  const orbit = h('div', { class: 'orb' }, orbitSvg(state.passes, sel, (i) => { state.sel = i; viewAround(); }));
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }).toUpperCase();
  shell(h('div', { class: 'stack' },
    h('div', {}, h('p', { class: 'eyebrow' }, dateLine), h('h2', { style: 'margin-top:4px' }, 'Hello, ' + firstName() + '.')),
    orbit,
    h('button', { class: 'glass nu', type: 'button', onclick: () => live && showPass(p), 'aria-label': 'Open pass for ' + p.event.name },
      h('p', { class: 'eyebrow' }, 'Next up' + (p.event.city ? ' · ' + p.event.city.toUpperCase() : '')),
      h('div', { class: 'cd' }, h('b', {}, d === null ? '—' : String(Math.max(d, 0))), h('small', {}, 'DAYS')),
      h('h3', { style: 'font-size:20px;margin:6px 0' }, p.event.name),
      h('p', { class: 'muted' }, [p.event.starts_at ? when(p.event.starts_at, { weekday: 'short', day: 'numeric', month: 'short' }) : null, p.tier + ' ticket', p.zones.length + (p.zones.length === 1 ? ' area' : ' areas')].filter(Boolean).join(' · ')),
      h('p', { style: 'margin-top:10px;font-size:13px' }, '● ' + status)),
    state.waiting.length ? waitingCards() : null), { title: 'Around me' });
}

function waitingCards() {
  return state.waiting.map((w) => h('div', { class: 'card', style: 'border-color:var(--signal)' },
    h('p', { class: 'eyebrow' }, 'An invite is waiting for you'),
    h('h3', { style: 'margin-top:4px' }, w.event.name),
    h('p', { class: 'muted' }, w.tier + ' ticket'),
    h('button', { class: 'btn primary block', style: 'margin-top:12px', type: 'button', onclick: () => claim({ invite_id: w.id }) }, 'Add to my passes')));
}

// ---- Passes --------------------------------------------------------------------------------------
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
  shell(h('div', { class: 'stack' },
    h('h2', {}, 'Your passes'),
    h('div', { class: 'cardwrap' }, cardEl(loadCard(), cardInfo())),
    state.waiting.length ? waitingCards() : null,
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
    state.sel = null;
    state.tab = 'passes';
    render();
    toast('Pass added');
    showPass(r.pass);
  } catch (ex) {
    if (btn) btn.disabled = false;
    if (ex.status === 401) return onboarding('signin');
    if (body.code) viewAdd(ex.message);
    else toast(ex.message);
  }
}

function showPass(p) {
  const prev = document.body.style.overflow;
  const close = () => { overlay.remove(); document.body.style.overflow = prev; };
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

// ---- History -------------------------------------------------------------------------------------
function viewHistory() {
  const reasons = { already_used: 'Already used', no_zone_access: 'Not allowed in this area', revoked: 'Pass cancelled', invalid_token: 'Not recognised', wrong_event: 'Wrong event' };
  shell(h('div', { class: 'stack' }, h('h2', {}, 'History'),
    state.history.length
      ? h('div', { class: 'list' }, state.history.map((s) => h('div', { class: 'item' },
          h('div', {}, h('strong', {}, s.event_name), h('div', { class: 'hint' }, s.zone || ''), s.result === 'denied' && h('div', { class: 'hint' }, reasons[s.reason] || 'Declined')),
          h('div', { style: 'text-align:right' }, h('span', { class: 'chip ' + (s.result === 'granted' ? 'ok' : 'bad') }, s.result === 'granted' ? 'Entered' : 'Declined'), h('div', { class: 'hint' }, ago(s.at))))))
      : h('div', { class: 'empty' }, 'Nothing yet. Entries show up here after you are scanned in.')), { title: 'History' });
}

// ---- Me ------------------------------------------------------------------------------------------
function viewMe() {
  const name = h('input', { class: 'input', id: 'nm', value: state.user.name || '', maxlength: '80', autocomplete: 'name' });
  shell(h('div', { class: 'stack' }, h('h2', {}, 'Me'),
    h('div', { class: 'cardwrap' }, cardEl(loadCard(), cardInfo())),
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => { state.tab = 'custom'; render(); } }, 'Customise card'),
    h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); try { state.user = (await patch('/me', { name: name.value })).user; toast('Saved'); } catch (ex) { toast(ex.message); } } },
      h('div', { class: 'field', style: 'margin-top:0' }, h('label', { for: 'nm' }, 'Name'), name),
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'Signed in as ' + state.user.identifier),
      h('button', { class: 'btn primary small', style: 'margin-top:12px', type: 'submit' }, 'Save name')),
    state.config.otp_mode === 'demo' && h('div', { class: 'notice warn' }, 'Demo mode: sign-in codes are shown on screen instead of being texted. This is for trying Tap In out.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn ghost', href: '/organiser/' }, 'Organiser console'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { flag(false); onboarding('ctx'); } }, 'Replay intro'),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await post('/auth/logout').catch(() => {}); state.user = null; state.passes = []; state.waiting = []; flag(false); onboarding('welcome'); } }, 'Sign out'))), { title: 'Me' });
}

// ---- Customise card ------------------------------------------------------------------------------
function viewCustom() {
  const draft = { ...loadCard() };
  if (!draft.name) draft.name = (state.user.name || '').slice(0, 16);
  const preview = h('div', { class: 'cardwrap', 'aria-live': 'polite' });
  const controls = h('div', { class: 'stack' });
  const paint = () => {
    mount(preview, cardEl(draft, { name: draft.name || 'Your name', num: cardNumber(state.user.id), status: 'Active' }));
    mount(controls,
      group('Start from', Object.keys(PRESETS).map((k) => chip(k, false, () => { Object.assign(draft, PRESETS[k]); paint(); }))),
      group('Colour', [h('p', { class: 'hint' }, 'Main'), swatches('c1'), h('p', { class: 'hint' }, 'Second'), swatches('c2')]),
      group('Finish', FINISHES.map((f) => chip(f, draft.fin === f, () => { draft.fin = f; paint(); }))),
      group('Pattern', PATTERNS.map((f) => chip(f, draft.pat === f, () => { draft.pat = f; paint(); }))),
      group('Type', TYPES.map((f) => chip(f, draft.type === f, () => { draft.type = f; paint(); }))));
  };
  const swatches = (k) => h('div', { class: 'swrow' }, SWATCHES.map((c) => h('button', { type: 'button', class: 'swc' + (draft[k] === c ? ' on' : ''), style: `background:${c}`, 'aria-label': (k === 'c1' ? 'Main colour ' : 'Second colour ') + c, 'aria-pressed': draft[k] === c ? 'true' : 'false', onclick: () => { draft[k] = c; paint(); } })));
  const chip = (label, on, fn) => h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: fn }, label);
  const group = (label, kids) => h('div', {}, h('p', { class: 'label', style: 'margin-bottom:6px' }, label), h('div', { class: 'chips' }, kids));
  const nameIn = h('input', { class: 'input', id: 'dn', value: draft.name, maxlength: '16', oninput: (e) => { draft.name = e.target.value; mount(preview, cardEl(draft, { name: draft.name || 'Your name', num: cardNumber(state.user.id), status: 'Active' })); } });
  paint();
  shell(h('div', { class: 'stack' },
    h('button', { class: 'btn ghost small', type: 'button', style: 'justify-self:start', onclick: () => { state.tab = 'me'; render(); } }, 'Back'),
    h('h2', {}, 'Customise'),
    h('p', { class: 'muted' }, 'Appearance only. Your access and security do not change. Saved on this device.'),
    preview, controls,
    h('div', { class: 'field' }, h('label', { for: 'dn' }, 'Name on card'), nameIn),
    h('button', { class: 'btn primary block', type: 'button', onclick: () => { saveCard(draft) ? toast('Card saved') : toast('Could not save on this device'); state.tab = 'me'; render(); } }, 'Save changes')), { tabs: true, title: 'Customise' });
}

// ---- Start ---------------------------------------------------------------------------------------
(async function start() {
  const splash = document.getElementById('splash');
  if (splash) setTimeout(() => splash.remove(), 3300);
  state.config = await get('/config').catch(() => ({}));
  if (state.config.configured === false) {
    mount(root, h('main', { class: 'page hero' }, h('h1', {}, 'Almost there'), h('p', { class: 'muted', style: 'margin-top:12px' }, 'The server is running but its SECRET_PEPPER secret is not set yet. See the README, "Set the secret".')));
    return;
  }
  try {
    await refresh();
    if (flag() || state.passes.length) { state.tab = state.passes.length ? 'around' : 'add'; render(); } else onboarding('passes');
  } catch {
    flag() ? onboarding('signin') : onboarding('welcome');
  }
})();
