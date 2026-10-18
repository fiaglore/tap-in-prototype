import { h, wordmarkText, mount, toast, copy, when, ago } from '/js/dom.js';
import { get, post, patch, put, del } from '/js/api.js';
import { selfieModal } from '/js/selfie.js';
import { signInFlow } from '/js/auth-ui.js';
import { cardEl, cardNumber, loadCard, saveCard, sanitise, PRESETS, SWATCHES, FINISHES, PATTERNS, TYPES } from '/js/card.js';
import { orbitSvg, nextIndex, daysTo } from '/app/orbit.js';
import { qrSvg } from '/js/qr.js';
import { rollingToken, secondsLeft, LIVE_STEP } from '/js/offline.js';

const root = document.getElementById('app');
const state = { user: null, passes: [], waiting: [], history: [], wallet: null, tab: 'around', config: {}, sel: null, ctx: [] };
const ONB = 'tapin-onboarded';
const flag = (v) => { try { if (v === undefined) return localStorage.getItem(ONB) === '1'; v ? localStorage.setItem(ONB, '1') : localStorage.removeItem(ONB); } catch { return false; } };

const NS = 'http://www.w3.org/2000/svg';
const icons = {
  around: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z',
  passes: 'M4 7h16v10H4zM4 11h16',
  add: 'M12 5v14M5 12h14',
  history: 'M12 7v5l3 2M4 12a8 8 0 1 0 3-6.2M4 4v4h4',
  wallet: 'M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4zM4 7a2 2 0 0 1 2-2h10M16 14h2',
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

// ---- Data ----------------------------------------------------------------------------------------
// Passes are kept on this phone too, so they still open with no signal (cleared on sign out).
const CACHE = 'tapin-me';
function useData(r) {
  state.user = r.user;
  state.passes = r.passes;
  state.waiting = r.waiting || [];
  // How far this phone's clock is from the server's, so codes made offline match the gate's time.
  if (r.server_time && r.fetched_at) state.clockOffset = r.server_time - r.fetched_at / 1000;
}
async function refresh() {
  try {
    const r = await get('/me');
    r.fetched_at = Date.now();
    useData(r);
    state.offline = false;
    try { localStorage.setItem(CACHE, JSON.stringify(r)); } catch {}
  } catch (ex) {
    if (ex.status !== 0) throw ex;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CACHE)); } catch {}
    if (!saved) throw ex;
    useData(saved);
    state.offline = true;
  }
}
const forgetCache = () => { try { localStorage.removeItem(CACHE); } catch {} };
const nowSec = () => Date.now() / 1000 + (state.clockOffset || 0);
const firstName = () => (state.user && state.user.name ? state.user.name.trim().split(/\s+/)[0] : 'there');
const cardInfo = (status = 'Active') => ({ name: (loadCard().name || (state.user && state.user.name) || 'Your name').slice(0, 16), num: cardNumber(state.user && state.user.id), status });

// ---- Shell with bottom tabs ----------------------------------------------------------------------
function shell(content, { tabs = true, title } = {}) {
  const head = h('div', { class: 'head' },
    h('a', { class: 'wordmark', href: '/' }, wordmarkText()),
    window.TapTheme.button());
  const offline = state.offline && h('div', { class: 'notice warn', role: 'status', style: 'margin-bottom:12px' }, 'No connection. Your saved passes still work at the gate; everything else updates when you are back online.');
  mount(root, head, h('main', { class: 'page' }, offline, content), tabs && tabBar());
  if (title) document.title = title + ' · Tap In';
  window.scrollTo(0, 0);
}
function tabBar() {
  // The wallet tab only exists while payments are switched on (PAYMENTS_MODE is not "off").
  const items = [['around', 'Around me'], ['passes', 'Passes'], ...(state.config.payments === false ? [] : [['wallet', 'Wallet']]), ['add', 'Add'], ['history', 'History'], ['me', 'Me']];
  return h('nav', { class: 'tabs', 'aria-label': 'Main' }, h('div', {},
    items.map(([k, label]) => h('button', { type: 'button', 'aria-current': state.tab === k ? 'page' : null, onclick: () => go(k) }, icon(k), label))));
}
async function go(tab) {
  if (tab === 'wallet' && state.config.payments === false) tab = 'passes';
  state.tab = tab;
  if (tab === 'history') { try { state.history = (await get('/me/history')).scans; } catch { state.history = []; } }
  if (tab === 'wallet') { try { state.wallet = await get('/wallet'); } catch (ex) { if (ex.status === 401) return onboarding('signin'); state.wallet = null; } }
  if (tab === 'around' || tab === 'passes') { try { await refresh(); } catch (ex) { if (ex.status === 401) return onboarding('signin'); } }
  render();
}
function render() {
  ({ around: viewAround, passes: viewPasses, add: viewAdd, history: viewHistory, wallet: viewWallet, me: viewMe, custom: viewCustom })[state.tab]();
}

// ---- Onboarding ----------------------------------------------------------------------------------
const CONTEXTS = ['Festivals', 'Concerts', 'Clubs', 'Offices & doors', 'Conferences', 'Art & culture'];
const STEPS = ['ctx', 'signin', 'passes', 'protect', 'practice'];

function onbShell(step, ...kids) {
  const n = STEPS.indexOf(step) + 1;
  const head = h('div', { class: 'head' },
    n > 1 ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => onboarding(prevStep(step)) }, 'Back') : h('a', { class: 'wordmark', href: '/' }, wordmarkText()),
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
    h('div', { class: 'head' }, h('a', { class: 'wordmark', href: '/' }, wordmarkText()), window.TapTheme.button()),
    h('main', { class: 'page hero' },
      h('p', { class: 'eyebrow' }, 'Your phone is your pass'),
      h('h1', {}, 'No bands.', h('br'), 'No paper.'),
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
      await postClaim(body);
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
  const office = p.event.kind === 'workplace';
  const expired = !!p.expires_at && p.expires_at * 1000 <= Date.now();
  const live = p.status === 'active' && !expired;
  let status;
  if (expired) status = 'This pass has expired.';
  else if (!live) status = 'This pass was cancelled. Contact the organiser.';
  else if (office) status = p.expires_at ? 'Valid until ' + when(p.expires_at, { dateStyle: 'medium', timeStyle: 'short' }) + '. Tap in at the door.' : 'You have access. Tap in at the door.';
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
      h('p', { class: 'eyebrow' }, (office ? 'Office access' : 'Next up') + (p.event.city ? ' · ' + p.event.city.toUpperCase() : '')),
      !office && h('div', { class: 'cd' }, h('b', {}, d === null ? '—' : String(Math.max(d, 0))), h('small', {}, 'DAYS')),
      h('h3', { style: 'font-size:20px;margin:6px 0' }, p.event.name),
      h('p', { class: 'muted' }, [p.event.starts_at ? when(p.event.starts_at, { weekday: 'short', day: 'numeric', month: 'short' }) : null, p.tier + (office ? '' : ' ticket'), p.zones.length + (office ? (p.zones.length === 1 ? ' door' : ' doors') : (p.zones.length === 1 ? ' area' : ' areas'))].filter(Boolean).join(' · ')),
      h('p', { style: 'margin-top:10px;font-size:13px' }, '● ' + status)),
    state.waiting.length ? waitingCards() : null), { title: 'Around me' });
}

function waitingCards() {
  return state.waiting.map((w) => h('div', { class: 'card', style: 'border-color:var(--signal)' },
    h('p', { class: 'eyebrow' }, w.event.kind === 'workplace' ? 'Office access is waiting for you' : 'An invite is waiting for you'),
    h('h3', { style: 'margin-top:4px' }, w.event.name),
    h('p', { class: 'muted' }, w.event.kind === 'workplace' ? w.tier : w.tier + ' ticket'),
    h('button', { class: 'btn primary block', style: 'margin-top:12px', type: 'button', onclick: () => claim({ invite_id: w.id }) }, 'Add to my passes')));
}

// ---- Passes --------------------------------------------------------------------------------------
function passCard(p) {
  const live = p.status === 'active' && !(p.expires_at && p.expires_at * 1000 <= Date.now());
  return h('button', { class: 'pass' + (live ? '' : ' off'), type: 'button', onclick: () => live && showPass(p), 'aria-label': `Open pass for ${p.event.name}` },
    h('div', { class: 'spread' }, h('span', { class: 'eyebrow' }, p.event.kind === 'workplace' ? 'Office access' : p.event.starts_at ? when(p.event.starts_at, { dateStyle: 'medium' }) : 'Date to be announced'),
      live ? h('span', { class: 'chip ok' }, 'Active') : h('span', { class: 'chip bad' }, p.status === 'active' ? 'Expired' : 'Cancelled')),
    h('h3', {}, p.event.name),
    h('p', { class: 'muted' }, [p.event.venue, p.event.city].filter(Boolean).join(', ') || p.tier),
    h('div', { class: 'zones' }, h('span', { class: 'chip' }, p.tier), p.zones.map((z) => h('span', { class: 'chip' }, z))),
    live && needsPhoto(p) && h('span', { class: 'chip bad' }, 'Photo needed'),
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
    const r = await postClaim(body);
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

// Some events want a selfie on every pass. If the server says so, take one, save it, and try the claim again.
async function ensurePhoto(note) {
  const shot = await selfieModal({ title: 'Add your photo', note: note || 'Door staff will compare this with your face when your pass is scanned.' });
  if (!shot) return false;
  await put('/me/photo', { image: shot });
  if (state.user) state.user.has_photo = true;
  return true;
}
async function postClaim(body) {
  try {
    return await post('/claim', body);
  } catch (ex) {
    if (ex.code === 'photo_required' && (await ensurePhoto('This event checks passes against a photo of you.'))) return post('/claim', body);
    throw ex;
  }
}
const needsPhoto = (p) => p.event.require_photo && state.user && !state.user.has_photo;

// "Add to Apple Wallet" / "Save to Google Wallet", once those are set up. Live passes stay in the app, because a
// wallet pass cannot change its code every 30 seconds.
function walletButtons(p) {
  const w = state.config.wallet || {};
  if (!w.apple && !w.google) return null;
  if (p.live) return h('p', { class: 'hint', style: 'margin-top:10px;text-align:center;max-width:320px' }, 'This event uses a live code, so the pass stays here in the app rather than in a wallet.');
  const google = async (e) => {
    e.currentTarget.disabled = true;
    try { location.href = (await get('/me/passes/' + p.id + '/wallet/google')).url; } catch (ex) { toast(ex.message); e.currentTarget.disabled = false; }
  };
  return h('div', { class: 'row wallets', style: 'margin-top:14px;justify-content:center' },
    w.apple && h('a', { class: 'btn ghost small', href: '/api/me/passes/' + p.id + '/wallet/apple' }, 'Add to Apple Wallet'),
    w.google && h('button', { class: 'btn ghost small', type: 'button', onclick: google }, 'Save to Google Wallet'));
}

function showPass(p) {
  const prev = document.body.style.overflow;
  let timer = null;
  const close = () => { clearInterval(timer); overlay.remove(); document.body.style.overflow = prev; };
  const qrBox = h('div', { class: 'qrbox' });
  const tokenEl = h('p', { class: 'token' });
  const note = h('p', { class: 'hint', style: 'margin-top:14px;text-align:center;max-width:320px' });
  const copyBtn = h('button', { class: 'btn ghost small', style: 'margin-top:12px', type: 'button', onclick: () => copy(tokenEl.textContent, 'Pass code copied') }, 'Copy pass code');
  function draw(token) { mount(qrBox, qrSvg(token)); tokenEl.textContent = token; }
  const countdown = h('div', { class: 'countdown', 'aria-hidden': 'true' }, h('i', {}));
  countdown.hidden = true;
  if (p.live && p.roll_key) {
    // Secure event: the phone makes a new code every 30 seconds by itself, so it works with no signal.
    // The moving bar shows staff the code is live, not a screenshot.
    copyBtn.hidden = true;
    countdown.hidden = false;
    note.textContent = 'This code changes every 30 seconds, so a screenshot will not work. It works without a connection.';
    let shownWin = -1;
    const tick = async () => {
      const now = nowSec();
      const win = Math.floor(now / LIVE_STEP);
      if (win !== shownWin) { shownWin = win; draw(await rollingToken(p.roll_key, p.id, now)); }
      countdown.firstChild.style.width = (secondsLeft(now) / LIVE_STEP) * 100 + '%';
    };
    tick();
    timer = setInterval(tick, 1000);
  } else if (p.live) {
    // Secure event on an older saved pass without a key: keep asking the server for a fresh code.
    note.textContent = 'Getting your live code…';
    copyBtn.hidden = true;
    let last = 0;
    const fetchLive = async () => {
      try {
        const r = await get('/me/passes/' + p.id + '/live');
        draw(r.token);
        last = Date.now();
        note.textContent = 'This code refreshes every few seconds, so a screenshot will not work. Hold it up to the scanner.';
      } catch (ex) {
        note.textContent = ex.status === 409 ? 'This pass is no longer active.' : (Date.now() - last > 60000 ? 'No connection. Reconnect to show a fresh code.' : note.textContent);
        if (ex.status === 409) { mount(qrBox); tokenEl.textContent = ''; clearInterval(timer); }
      }
    };
    fetchLive();
    timer = setInterval(fetchLive, 20000);
  } else {
    draw(p.token);
    note.textContent = 'Hold this up to the scanner. If the scanner cannot read it, staff can type the code under the picture.';
  }
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Pass for ' + p.event.name },
    h('div', { class: 'spread', style: 'width:100%;max-width:460px' }, h('button', { class: 'btn ghost small', type: 'button', onclick: close }, 'Close'), h('span', { class: 'chip' }, p.tier)),
    h('h2', { style: 'margin-top:14px;text-align:center' }, p.event.name),
    h('p', { class: 'muted', style: 'text-align:center' }, state.user.name || ''),
    needsPhoto(p) && h('div', { class: 'notice warn', style: 'max-width:340px;text-align:center' }, 'This event checks passes against a photo of you. ',
      h('button', { class: 'btn small primary', style: 'margin-top:8px', type: 'button', onclick: async () => { try { if (await ensurePhoto()) { toast('Photo saved'); close(); render(); } } catch (ex) { toast(ex.message); } } }, 'Add my photo')),
    qrBox, countdown, tokenEl,
    h('div', { class: 'zones', style: 'margin-top:12px;justify-content:center' }, p.zones.map((z) => h('span', { class: 'chip' }, z))),
    note, copyBtn, walletButtons(p));
  document.body.style.overflow = 'hidden';
  document.body.append(overlay);
  overlay.querySelector('button').focus();
  overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}

// ---- Wallet --------------------------------------------------------------------------------------
const naira = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: kobo % 100 ? 2 : 0, maximumFractionDigits: 2 });
const toKobo = (v) => { const n = Number.parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const ENTRY = { topup: 'Added money', payment: 'Paid', refund: 'Refund from', payout: 'Payout' };

async function viewWallet() {
  const w = state.wallet;
  if (!w) return shell(h('div', { class: 'empty' }, h('p', {}, 'Could not load your wallet.'), h('button', { class: 'btn primary', style: 'margin-top:14px', type: 'button', onclick: () => go('wallet') }, 'Try again')), { title: 'Wallet' });
  const demo = w.mode === 'demo';
  const amount = h('input', { class: 'input', id: 'payamt', inputmode: 'decimal', placeholder: 'Amount in naira, e.g. 2500', autocomplete: 'off' });
  const err = h('div', { role: 'alert' });
  async function add(kobo) {
    try { state.wallet = await post('/wallet/topup', { amount_kobo: kobo }); toast('Added ' + naira(kobo)); viewWallet(); } catch (ex) { toast(ex.message); }
  }
  shell(h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'spread' }, h('p', { class: 'eyebrow' }, 'Tap In wallet'), demo && h('span', { class: 'chip' }, 'Demo money')),
      h('div', { style: 'font:800 40px var(--display);margin:6px 0' }, naira(w.balance_kobo)),
      demo
        ? h('div', {}, h('p', { class: 'hint' }, 'Add play money to try paying. Nothing real moves yet.'),
            h('div', { class: 'row', style: 'margin-top:10px' }, [1000, 5000, 10000].map((n) => h('button', { class: 'btn ghost small', type: 'button', onclick: () => add(n * 100) }, '+ ' + naira(n * 100)))))
        : h('p', { class: 'hint' }, 'Adding real money is not available yet.')),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      const kobo = toKobo(amount.value);
      if (!(kobo > 0)) return mount(err, h('div', { class: 'error' }, 'Enter how much you are paying.'));
      if (kobo > w.balance_kobo) return mount(err, h('div', { class: 'error' }, 'That is more than your balance. Add money first.'));
      try { const r = await post('/wallet/pay-code', { amount_kobo: kobo }); mount(err); showPayCode(r); } catch (ex) { mount(err, h('div', { class: 'error' }, ex.message)); }
    } },
      h('h3', {}, 'Pay a vendor'),
      h('p', { class: 'hint', style: 'margin-top:4px' }, 'Enter the amount, then show the code to the vendor. They can only charge exactly that amount.'),
      h('div', { class: 'field' }, h('label', { for: 'payamt' }, 'Amount (₦)'), amount), err,
      h('button', { class: 'btn primary block', style: 'margin-top:12px', type: 'submit' }, 'Show pay code')),
    h('div', { class: 'card' }, h('h3', {}, 'Recent'),
      w.entries.length
        ? h('div', { class: 'list', style: 'margin-top:8px' }, w.entries.map((e) => h('div', { class: 'item' },
            h('div', {}, h('strong', {}, (ENTRY[e.kind] || e.kind) + (e.vendor ? ' ' + e.vendor : '')), h('div', { class: 'hint' }, ago(e.created_at))),
            h('strong', { class: e.kind === 'payment' ? '' : 'ok-text' }, (e.kind === 'payment' ? '−' : '+') + naira(e.amount_kobo)))))
        : h('p', { class: 'muted', style: 'margin-top:6px' }, 'No payments yet.')),
    h('div', { class: 'card', id: 'enabled' })), { title: 'Wallet' });
  // The "Tap In enabled" list is nice to have; the wallet works without it.
  get('/public/vendors').then((r) => {
    const box = document.getElementById('enabled');
    if (box) mount(box, h('h3', {}, 'Tap In enabled'), r.vendors.length ? h('div', { class: 'zones', style: 'margin-top:8px' }, r.vendors.map((v) => h('span', { class: 'chip' }, v.name + (v.category ? ' · ' + v.category : '')))) : h('p', { class: 'muted', style: 'margin-top:6px' }, 'No vendors yet. Run a business? Set it up at /vendor/.'));
  }).catch(() => {});
}

function showPayCode(r) {
  const prev = document.body.style.overflow;
  let poll = null;
  let tick = null;
  const close = () => { clearInterval(poll); clearInterval(tick); overlay.remove(); document.body.style.overflow = prev; go('wallet'); };
  const left = h('p', { class: 'hint', style: 'margin-top:8px' });
  const qr = h('div', { class: 'qrbox' }, qrSvg(r.code, 'Your Tap In pay code'));
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Pay code' },
    h('div', { class: 'spread', style: 'width:100%;max-width:460px' }, h('button', { class: 'btn ghost small', type: 'button', onclick: close }, 'Cancel'), h('span', { class: 'chip' }, 'Pay code')),
    h('h2', { style: 'margin-top:14px;text-align:center' }, 'Pay ' + naira(r.amount_kobo)),
    qr, h('p', { class: 'token' }, r.code), left,
    h('p', { class: 'hint', style: 'margin-top:10px;text-align:center;max-width:320px' }, 'Hold this up to the vendor. It works once, for exactly this amount.'));
  document.body.style.overflow = 'hidden';
  document.body.append(overlay);
  overlay.querySelector('button').focus();
  const start = state.wallet.balance_kobo;
  const endAt = Date.now() + r.expires_in * 1000;
  tick = setInterval(() => { const s = Math.max(0, Math.round((endAt - Date.now()) / 1000)); left.textContent = s ? `Good for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'This code has expired. Close it and make a new one.'; }, 1000);
  // Watch for the vendor's charge landing so the customer sees confirmation straight away.
  poll = setInterval(async () => {
    try {
      const w = await get('/wallet');
      if (w.balance_kobo < start) {
        clearInterval(poll); clearInterval(tick);
        state.wallet = w;
        mount(qr, h('div', { style: 'font:800 64px var(--display);color:var(--ok);text-align:center' }, '✓'));
        left.textContent = 'Paid ' + naira(start - w.balance_kobo) + '. Thank you.';
      }
    } catch {}
  }, 3000);
  overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}

// ---- History -------------------------------------------------------------------------------------
function viewHistory() {
  const reasons = { stale_code: 'Old code', static_pass: 'Needs the live code', expired: 'Pass expired', outside_hours: 'Outside allowed hours', already_used: 'Already used', no_zone_access: 'Not allowed in this area', revoked: 'Pass cancelled', invalid_token: 'Not recognised', wrong_event: 'Wrong event' };
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
    photoCard(),
    state.config.otp_mode === 'demo' && h('div', { class: 'notice warn' }, 'Demo mode: sign-in codes are shown on screen instead of being texted. This is for trying Tap In out.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn ghost', href: '/organiser/' }, 'Organiser console'),
      h('a', { class: 'btn ghost', href: '/business/' }, 'Tap In for Business'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { flag(false); onboarding('ctx'); } }, 'Replay intro'),
      h('a', { class: 'btn ghost', href: '/privacy/' }, 'Privacy'),
      h('a', { class: 'btn ghost', href: '/terms/' }, 'Terms'),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await post('/auth/logout').catch(() => {}); forgetCache(); state.user = null; state.passes = []; state.waiting = []; flag(false); onboarding('welcome'); } }, 'Sign out'))), { title: 'Me' });
}

// ---- My photo (shown to door staff only at events that ask for it) -----------------------------------
function photoCard() {
  const box = h('div', { class: 'card' });
  async function draw() {
    let ph = null;
    try { ph = (await get('/me/photo')).photo; } catch {}
    mount(box,
      h('div', { class: 'row', style: 'gap:14px;align-items:center' },
        ph ? h('img', { class: 'mephoto', src: ph, alt: 'Your photo' }) : h('div', { class: 'mephoto', style: 'display:grid;place-items:center;font-size:28px' }, '☺'),
        h('div', { style: 'flex:1' }, h('h3', {}, 'Your photo'),
          h('p', { class: 'hint' }, ph ? 'Door staff at events that ask for it see this next to your name when your pass is scanned.' : 'Some events and offices ask for a selfie so door staff can match your face to your pass.'))),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn small primary', type: 'button', onclick: async () => { try { if (await ensurePhoto()) { toast('Photo saved'); draw(); } } catch (ex) { toast(ex.message); } } }, ph ? 'Retake' : 'Add a photo'),
        ph && h('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (!confirm('Delete your photo? Events that need one will ask for it again.')) return; try { await del('/me/photo'); state.user.has_photo = false; toast('Photo deleted'); draw(); } catch (ex) { toast(ex.message); } } }, 'Delete')));
  }
  draw();
  return box;
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
  // Keep the app itself on the phone so it opens with no signal.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
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
