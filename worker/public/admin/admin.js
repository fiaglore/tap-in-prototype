// The Tap In team's support console. Nothing here is public: the API answers "not found" to anyone who is not signed-in staff.
// Every change asks for a written reason first, and the server logs who did what, to whom, and why.
import { h, mount, toast, when, ago, download, wordmarkText } from '/js/dom.js';
import { api, get, post } from '/js/api.js';
import { signInFlow } from '/js/auth-ui.js?v=2';

const root = document.getElementById('root');
let me = null; // the signed-in team member
const pending = {}; // a search carried from one page to the next

const REASONS = { already_used: 'Already used', no_zone_access: 'Wrong area', revoked: 'Cancelled pass', expired: 'Pass expired', outside_hours: 'Outside hours', stale_code: 'Old code / screenshot', static_pass: 'Screenshot or printout', invalid_token: 'Unreadable / fake', wrong_event: 'Other event', unknown: 'No reason given' };
const ACTIONS = {
  'user.view': 'Opened a person’s page', 'user.export': 'Exported a person’s data', 'user.sign_out': 'Signed a person out everywhere', 'user.send_link': 'Emailed a sign-in link',
  'user.clear_limits': 'Cleared sign-in limits', 'user.rename': 'Fixed a name', 'user.suspend': 'Suspended an account', 'user.restore': 'Restored an account', 'user.delete': 'Deleted an account',
  'pass.revoke': 'Revoked a pass', 'pass.restore': 'Restored a pass', 'invite.lookup': 'Looked up an invite', 'invite.revoke': 'Revoked an invite',
  'event.unlist': 'Took an event off the public list', 'event.relist': 'Put an event back on the public list'
};
const naira = (k) => '₦' + (k / 100).toLocaleString('en-NG');
const friendly = (ex) => ({
  runs_events: 'This person runs events or vendors. Close those with them before deleting the account.',
  wallet_balance: 'Their wallet still holds money. That has to be settled first.',
  is_staff: 'This is a member of the team. An engineer has to change a team account.',
  is_you: 'You cannot do this to your own account.'
})[ex.code] || ex.message;

// The admin API; a "not found" from it means the session ended, so start again from the top.
async function adm(method, path, body) {
  try { return await api(method, '/admin' + path, body); } catch (ex) {
    if (ex.status === 404 && ex.code === 'not_found') { await boot(); throw new Error('Your admin session has ended. Sign in again.'); }
    throw ex;
  }
}

// ---- getting in ----------------------------------------------------------------------------------------------------
async function boot() {
  try { me = await api('GET', '/admin/me'); } catch (ex) {
    me = null;
    if (ex.status === 404) {
      let who = null;
      try { who = (await get('/me')).user; } catch {}
      return who ? noAccess(who) : signIn();
    }
    return mount(root, h('main', { class: 'main' }, h('div', { class: 'error' }, ex.message)));
  }
  route();
}
function signIn() {
  const box = h('div', { class: 'card' });
  mount(root, h('main', { class: 'main', style: 'max-width:460px;margin:8vh auto 0' }, h('p', { class: 'eyebrow' }, 'Tap In team'), box));
  signInFlow(box, { title: 'Team sign in', lede: 'Sign in with your Tap In team email. This area is only for the team.', onDone: () => boot() });
}
function noAccess(who) {
  mount(root, h('main', { class: 'main', style: 'max-width:520px;margin:8vh auto 0' },
    h('div', { class: 'card' }, h('h1', {}, 'No access'),
      h('p', { class: 'lede', style: 'margin-top:8px' }, 'You are signed in as ' + (who.identifier || 'someone') + ', but this account cannot open the support console.'),
      h('p', { class: 'hint' }, 'Either it is not on the team list, or your admin session is older than 8 hours. Sign out and sign in again. If this keeps happening, ask an engineer to add your email to the team list.'),
      h('button', { class: 'btn primary', style: 'margin-top:14px', type: 'button', onclick: signOut }, 'Sign out'))));
}
async function signOut() { await post('/auth/logout').catch(() => {}); me = null; location.hash = ''; boot(); }

// ---- the frame --------------------------------------------------------------------------------------------------------
function shell(active, ...content) {
  const nav = [['overview', 'Overview'], ['people', 'People'], ['invites', 'Invites'], ['events', 'Events'], ['audit', 'Audit log']];
  mount(root, h('div', { class: 'adm' },
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, wordmarkText(), h('small', {}, 'Support')),
      nav.map(([k, label]) => h('a', { class: 'nav', href: '#/' + k, 'aria-current': active === k ? 'page' : null }, label)),
      h('div', { class: 'me' },
        h('span', {}, 'Signed in as ', h('b', {}, me.staff.identifier)),
        h('span', {}, 'Session ends ' + when(me.session_expires)),
        h('div', { class: 'row' }, window.TapTheme.button(), h('button', { class: 'btn ghost small', type: 'button', onclick: signOut }, 'Sign out')))),
    h('main', { class: 'main' }, ...content)));
  window.scrollTo(0, 0);
}
function route() {
  const [, area, id] = location.hash.replace(/^#/, '').split('/');
  const views = { overview: viewOverview, people: viewPeople, invites: viewInvites, events: viewEvents, audit: viewAudit };
  (views[area] || viewOverview)(id ? decodeURIComponent(id) : null);
}
window.addEventListener('hashchange', () => me && route());

// ---- small pieces -------------------------------------------------------------------------------------------------------
const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
const badge = (text, kind = '') => h('span', { class: 'badge ' + kind }, text);
const empty = (text) => h('p', { class: 'empty' }, text);
const table = (head, rows) => h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))), h('tbody', {}, rows)));

// A question the team answers before anything changes: a reason (always) and sometimes a word to type.
function ask({ title, text, confirmLabel = 'Confirm', danger = false, word = null, fields = [], reason = true }) {
  return new Promise((resolve) => {
    const why = reason && h('textarea', { class: 'input', id: 'dlg-why', maxlength: '300', placeholder: 'What happened and what you checked. This goes in the audit log.', 'aria-label': 'Reason' });
    const extra = fields.map((f) => ({ f, el: h('input', { class: 'input', id: 'dlg-' + f.name, value: f.value || '', maxlength: String(f.max || 80), 'aria-label': f.label }) }));
    const typed = word && h('input', { class: 'input', id: 'dlg-word', autocomplete: 'off', autocapitalize: 'characters', placeholder: word, 'aria-label': 'Type ' + word + ' to confirm' });
    const err = h('div', { class: 'error', role: 'alert', style: 'display:none;margin-top:10px' });
    const say = (m) => { err.textContent = m; err.style.display = ''; };
    const close = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const r = why ? why.value.trim() : '';
        if (why && r.length < 5) return say('Write a short reason, at least 5 characters.');
        if (typed && typed.value.trim() !== word) return say('Type ' + word + ' exactly to confirm.');
        const out = { reason: r };
        for (const { f, el } of extra) { out[f.name] = el.value.trim(); if (!out[f.name]) return say(f.label + ' cannot be empty.'); }
        if (word) out.confirm = word;
        close(out);
      }
    },
      extra.map(({ f, el }) => h('div', { class: 'field' }, h('label', { for: 'dlg-' + f.name }, f.label), el)),
      why && h('div', { class: 'field' }, h('label', { for: 'dlg-why' }, 'Reason'), why),
      typed && h('div', { class: 'field' }, h('label', { for: 'dlg-word' }, 'Type ' + word + ' to confirm'), typed),
      err,
      h('div', { class: 'btns' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => close(null) }, 'Cancel'), h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'submit' }, confirmLabel)));
    const scrim = h('div', { class: 'scrim', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e) => { if (e.target === scrim) close(null); } }, h('div', { class: 'dlg' }, h('h2', {}, title), text && h('p', {}, text), form));
    document.addEventListener('keydown', onKey);
    document.body.append(scrim);
    (extra[0] ? extra[0].el : why || typed || scrim).focus();
  });
}
function popup(title, ...content) {
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const scrim = h('div', { class: 'scrim', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e) => { if (e.target === scrim) close(); } },
    h('div', { class: 'dlg', style: 'width:min(720px,100%)' }, h('h2', {}, title), ...content, h('div', { class: 'btns' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Close'))));
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
}
// Ask for a reason, run the change, say so, and carry on. `again` redraws the page afterwards.
async function change(opts, run, again, said = 'Done') {
  const v = await ask(opts);
  if (!v) return;
  try { const r = await run(v); toast(typeof said === 'function' ? said(r) : said); await again(r); } catch (ex) { toast(friendly(ex)); }
}
const personLink = (id, label) => h('a', { href: '#/people/' + encodeURIComponent(id) }, label);

// ---- overview -----------------------------------------------------------------------------------------------------------
async function viewOverview() {
  shell('overview', h('h1', {}, 'Overview'), h('p', { class: 'lede' }, 'How Tap In is doing right now, and where to start.'), h('p', { class: 'muted' }, 'Loading…'));
  let o;
  try { o = await adm('GET', '/overview'); } catch (ex) { return shell('overview', h('h1', {}, 'Overview'), h('div', { class: 'error' }, ex.message)); }
  const tile = (n, label, warn = false) => h('div', { class: 'tile' + (warn ? ' warn' : '') }, h('b', {}, String(n)), h('span', {}, label));
  const search = h('input', { class: 'input', id: 'q', placeholder: 'Name, email, phone or id', 'aria-label': 'Find a person' });
  const find = h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); if (search.value.trim().length < 2) return toast('Type at least two characters.'); pending.people = search.value.trim(); location.hash = '#/people'; } }, search, h('button', { class: 'btn primary', type: 'submit' }, 'Find a person'));
  const mode = { firebase: 'Emailed sign-in link (Firebase)', live: 'Codes by text or email', demo: 'Demo: codes shown on screen' }[o.config.otp_mode] || o.config.otp_mode;
  shell('overview',
    h('h1', {}, 'Overview'), h('p', { class: 'lede' }, 'How Tap In is doing right now, and where to start.'),
    find,
    h('div', { class: 'grid tiles', style: 'margin-bottom:16px' },
      tile(o.people.total, 'People'), tile(o.people.new_7d, 'New this week'), tile(o.people.suspended, 'Suspended', o.people.suspended > 0),
      tile(o.passes_active, 'Active passes'), tile(o.events.upcoming + ' / ' + o.events.listed, 'Upcoming / listed events'),
      tile(o.entries_24h.granted, 'Let in, last 24 hours'), tile(o.entries_24h.denied, 'Turned away, last 24 hours', o.entries_24h.denied > o.entries_24h.granted && o.entries_24h.denied > 10),
      tile(o.sign_in.requests_last_hour, 'Sign-in requests, last hour'), tile(o.sign_in.people_rate_limited_now, 'People told “too many codes” now', o.sign_in.people_rate_limited_now > 0)),
    h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h2', {}, 'Why people were turned away (24 hours)'),
        o.entries_24h.denied_reasons.length ? table(['Reason', 'Times'], o.entries_24h.denied_reasons.map((r) => h('tr', {}, h('td', {}, REASONS[r.reason] || r.reason), h('td', {}, String(r.n))))) : empty('Nobody was turned away.')),
      h('div', { class: 'card' }, h('h2', {}, 'How it is set up'),
        kv([['Sign-in', mode], ['Payments', o.config.payments ? 'On' : 'Off'], ['Email service key', o.config.firebase_key_set ? 'Set' : badge('Missing', 'bad')], ['Team members', String(o.config.team_size)]]))));
}

// ---- people -------------------------------------------------------------------------------------------------------------
function viewPeople(id) {
  if (id) return viewProfile(id);
  const input = h('input', { class: 'input', id: 'q', placeholder: 'Name, email, phone or id', 'aria-label': 'Search people', autocomplete: 'off', value: pending.people || '' });
  const out = h('div', { class: 'list' });
  async function run(q) {
    if (q.length < 2) return mount(out, empty('Type at least two characters.'));
    mount(out, empty('Searching…'));
    try {
      const r = (await adm('GET', '/users?q=' + encodeURIComponent(q))).people;
      mount(out, r.length ? r.map((u) => h('a', { class: 'item', href: '#/people/' + encodeURIComponent(u.id) },
        h('div', {}, h('div', { class: 't' }, u.name || 'No name'), h('div', { class: 's' }, (u.identifier || '') + ' · joined ' + when(u.created_at, { dateStyle: 'medium' }))),
        h('div', { class: 'row' }, u.suspended_at ? badge('Suspended', 'bad') : null, u.deleted ? badge('Deleted', 'warn') : null, badge(u.passes + (u.passes === 1 ? ' pass' : ' passes'))))) : empty('Nobody matches that.'));
    } catch (ex) { mount(out, h('div', { class: 'error' }, ex.message)); }
  }
  shell('people', h('h1', {}, 'People'), h('p', { class: 'lede' }, 'Find someone by name, email, phone number or id. Opening a person’s page is recorded in the audit log.'),
    h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); pending.people = input.value.trim(); run(pending.people); } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Search')), out);
  input.focus();
  if (pending.people) run(pending.people);
}

async function viewProfile(id) {
  shell('people', h('p', { class: 'muted' }, 'Loading…'));
  let d;
  try { d = await adm('GET', '/users/' + encodeURIComponent(id)); } catch (ex) { return shell('people', h('p', {}, h('a', { href: '#/people' }, '← People')), h('div', { class: 'error' }, ex.message)); }
  const u = d.user;
  const again = () => viewProfile(id);
  const can = !u.deleted;
  const protect = d.target_is_staff;
  const act = (label, opts, path, extraBody, said, cls = 'btn ghost small', method = 'POST') =>
    h('button', { class: cls, type: 'button', onclick: () => change(opts, (v) => adm(method, '/users/' + encodeURIComponent(id) + path, { ...extraBody?.(v), reason: v.reason, ...(v.confirm ? { confirm: v.confirm } : {}) }), again, said) }, label);

  const actions = h('div', { class: 'actions' },
    can && u.email && !u.suspended_at ? act('Email a sign-in link', { title: 'Email a sign-in link', text: 'A fresh link goes to ' + u.email + '. It goes to their own inbox, not to you. At most three an hour.', confirmLabel: 'Send the link' }, '/send-link', null, 'Link sent') : null,
    can ? act('Sign out everywhere', { title: 'Sign out everywhere', text: 'Ends every session on every device. They can sign in again when they like.', confirmLabel: 'Sign them out' }, '/sign-out', null, (r) => r.sessions_ended + ' session' + (r.sessions_ended === 1 ? '' : 's') + ' ended') : null,
    can ? act('Clear sign-in limits', { title: 'Clear sign-in limits', text: 'For someone who was told “Too many codes requested”. They can ask for a new link straight away.', confirmLabel: 'Clear the limits' }, '/clear-limits', null, 'Limits cleared') : null,
    can ? act('Fix name', { title: 'Fix name', text: 'This is the name gate staff see.', confirmLabel: 'Save the name', fields: [{ name: 'name', label: 'Name', value: u.name || '', max: 60 }] }, '', (v) => ({ name: v.name }), 'Name saved', 'btn ghost small', 'PATCH') : null,
    can && !protect && !u.suspended_at ? act('Suspend', { title: 'Suspend this account', text: 'They are signed out everywhere and cannot sign back in until you restore them. Their passes stay as they are.', confirmLabel: 'Suspend', danger: true }, '/suspend', null, 'Suspended', 'btn danger small') : null,
    u.suspended_at ? act('Restore', { title: 'Restore this account', text: 'They can sign in again.', confirmLabel: 'Restore' }, '/restore', null, 'Restored', 'btn primary small') : null,
    h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { try { const data = await adm('GET', '/users/' + encodeURIComponent(id) + '/export'); download('tap-in-export-' + id + '.json', JSON.stringify(data, null, 2), 'application/json'); toast('Exported. The export is in the audit log.'); } catch (ex) { toast(friendly(ex)); } } }, 'Export their data'),
    can && !protect ? act('Delete account', { title: 'Delete this account', text: 'Removes their name, email, phone and photo, cancels their passes, and signs them out. This cannot be undone. It is what a person’s own “Delete my account” does.', confirmLabel: 'Delete the account', danger: true, word: 'DELETE' }, '/delete', null, (r) => 'Deleted. ' + r.passes_cancelled + ' pass' + (r.passes_cancelled === 1 ? '' : 'es') + ' cancelled', 'btn danger small') : null);

  const passRows = d.passes.map((p) => h('tr', {},
    h('td', {}, h('div', {}, p.event_name), h('div', { class: 'hint' }, p.starts_at ? when(p.starts_at, { dateStyle: 'medium' }) : 'Date to be announced')),
    h('td', {}, p.tier), h('td', {}, badge(p.status === 'active' ? 'Active' : 'Revoked', p.status === 'active' ? 'ok' : 'bad')),
    h('td', {}, p.granted + ' in, ' + p.denied + ' refused', p.last_scan ? h('div', { class: 'hint' }, 'last ' + ago(p.last_scan)) : null),
    h('td', {}, h('div', { class: 'row' },
      h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { try { const s = (await adm('GET', '/passes/' + p.id + '/scans')).scans; popup('Entries for this pass', s.length ? table(['When', 'Result', 'Why', 'Area'], s.map((x) => h('tr', {}, h('td', {}, when(x.at)), h('td', {}, badge(x.result === 'granted' ? 'Let in' : 'Turned away', x.result === 'granted' ? 'ok' : 'bad')), h('td', {}, x.reason ? REASONS[x.reason] || x.reason : ''), h('td', {}, x.zone || '')))) : empty('This pass has not been scanned.')); } catch (ex) { toast(ex.message); } } }, 'Entries'),
      can ? h('button', { class: 'btn ' + (p.status === 'active' ? 'danger' : 'primary') + ' small', type: 'button',
        onclick: () => change(p.status === 'active' ? { title: 'Revoke this pass', text: 'It stops working at the gate straight away.', confirmLabel: 'Revoke the pass', danger: true } : { title: 'Restore this pass', text: 'It works at the gate again.', confirmLabel: 'Restore the pass' },
          (v) => adm('POST', '/passes/' + p.id + (p.status === 'active' ? '/revoke' : '/restore'), { reason: v.reason }), again, p.status === 'active' ? 'Pass revoked' : 'Pass restored') }, p.status === 'active' ? 'Revoke' : 'Restore') : null))));

  shell('people',
    h('p', {}, h('a', { href: '#/people' }, '← People')),
    h('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start;margin-bottom:6px' },
      h('div', {}, h('h1', {}, u.name || 'No name'), h('p', { class: 'lede', style: 'margin:0' }, (u.identifier || '') + '  ·  ', h('span', { class: 'mono' }, u.id))),
      h('div', { class: 'row' }, u.suspended_at ? badge('Suspended ' + when(u.suspended_at, { dateStyle: 'medium' }), 'bad') : badge('In good standing', 'ok'), u.deleted ? badge('Deleted', 'warn') : null, protect ? badge('Team member', 'ok') : null)),
    protect ? h('div', { class: 'notice warn' }, 'This is a member of the team. They cannot be suspended or deleted here.') : null,
    u.deleted ? h('div', { class: 'notice warn' }, 'This account was deleted. What is left is anonymous.') : null,
    h('div', { class: 'card' }, h('h2', {}, 'What you can do'), actions),
    h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h2', {}, 'Account'), kv([
        ['Email', u.email && !u.deleted ? u.email : '—'], ['Phone', u.phone || '—'], ['Joined', when(u.created_at)],
        ['Signed in on', d.sessions.active + (d.sessions.active === 1 ? ' device' : ' devices') + (d.sessions.last ? ' (latest ' + ago(d.sessions.last) + ')' : '')],
        ['Photo on file', d.has_photo ? 'Yes' : 'No'], d.wallet ? ['Wallet', naira(d.wallet.balance_kobo)] : null, ['Opened by the team', d.views_30d + (d.views_30d === 1 ? ' time' : ' times') + ' in the last 30 days']])),
      h('div', { class: 'card' }, h('h2', {}, 'What the team did'),
        d.audit.length ? h('div', { class: 'list' }, d.audit.map((a) => h('div', {}, h('div', {}, h('b', {}, ACTIONS[a.action] || a.action), ' · ' + a.staff_identifier + ' · ' + ago(a.at)), a.reason ? h('div', { class: 'hint' }, a.reason) : null))) : empty('Nothing yet.'))),
    h('div', { class: 'card' }, h('h2', {}, 'Passes'), d.passes.length ? table(['Event', 'Ticket', 'Status', 'Entries', ''], passRows) : empty('No passes.')),
    d.events_owned.length ? h('div', { class: 'card' }, h('h2', {}, 'Events they run'), h('div', { class: 'list' }, d.events_owned.map((e) => h('a', { class: 'item', href: '#/events/' + encodeURIComponent(e.id) }, h('div', {}, h('div', { class: 't' }, e.name), h('div', { class: 's' }, e.starts_at ? when(e.starts_at, { dateStyle: 'medium' }) : 'Date to be announced')), badge(e.listed ? 'Listed' : 'Not listed', e.listed ? 'ok' : ''))))) : null,
    d.invites_bound.length ? h('div', { class: 'card' }, h('h2', {}, 'Invites made for their email or phone'), table(['Event', 'Code ends', 'Status'], d.invites_bound.map((i) => h('tr', {}, h('td', {}, i.event_name), h('td', { class: 'mono' }, '…' + i.code_hint), h('td', {}, badge(i.status, i.status === 'claimed' ? 'ok' : i.status === 'revoked' ? 'bad' : ''))))) ) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Recent entries'), d.recent_entries.length ? table(['When', 'Event', 'Area', 'Result'], d.recent_entries.map((s) => h('tr', {}, h('td', {}, when(s.at)), h('td', {}, s.event_name), h('td', {}, s.zone || ''), h('td', {}, badge(s.result === 'granted' ? 'Let in' : 'Turned away' + (s.reason ? ': ' + (REASONS[s.reason] || s.reason) : ''), s.result === 'granted' ? 'ok' : 'bad'))))) : empty('No entries yet.')));
}

// ---- invites ------------------------------------------------------------------------------------------------------------
function viewInvites() {
  const input = h('input', { class: 'input', id: 'code', placeholder: 'e.g. PGF-26-VIP-AB12CD', 'aria-label': 'Invite code', autocomplete: 'off', autocapitalize: 'characters' });
  const out = h('div', {});
  async function lookup(e) {
    e.preventDefault();
    mount(out, empty('Looking…'));
    try {
      const r = await adm('POST', '/invites/lookup', { code: input.value.trim() });
      if (!r.found) return mount(out, h('div', { class: 'card' }, h('h2', {}, 'No invite with that code'), h('p', { class: 'hint' }, 'Check the characters with the person. Codes are not case-sensitive, and dashes do not matter.')));
      const i = r.invite;
      const owner = i.claimed_by ? personLink(i.claimed_by, i.claimed_name || i.claimed_email || i.claimed_phone || i.claimed_by) : '—';
      mount(out, h('div', { class: 'card' },
        h('h2', {}, 'Invite ending ' + i.code_hint, badge(i.status, i.status === 'claimed' ? 'ok' : i.status === 'revoked' ? 'bad' : 'warn')),
        kv([['Event', h('a', { href: '#/events/' + encodeURIComponent(i.event_id) }, i.event_name)], ['Ticket', i.tier], ['Made for', i.bound_identifier || 'Anyone with the code'], ['Label', i.label || '—'],
          ['Made', when(i.created_at)], ['Expires', i.expires_at ? when(i.expires_at) : 'Never'], ['Claimed by', owner], i.claimed_at ? ['Claimed', when(i.claimed_at)] : null, i.pass_id ? ['Its pass', (i.pass_status === 'active' ? 'Active' : 'Revoked') + ' (find it on the person’s page)'] : null]),
        i.status === 'unused' ? h('div', { class: 'actions', style: 'margin-top:14px' }, h('button', { class: 'btn danger small', type: 'button', onclick: () => change({ title: 'Revoke this invite', text: 'Nobody will be able to claim it.', confirmLabel: 'Revoke the invite', danger: true }, (v) => adm('POST', '/invites/' + i.id + '/revoke', { reason: v.reason }), () => lookup(new Event('submit')), 'Invite revoked') }, 'Revoke invite')) : null));
    } catch (ex) { mount(out, h('div', { class: 'error' }, friendly(ex))); }
  }
  shell('invites', h('h1', {}, 'Invites'), h('p', { class: 'lede' }, 'Someone says their invite did not work? Type the code they were given. The code itself is never stored or logged.'),
    h('form', { class: 'search', onsubmit: lookup }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Look up')), out);
  input.focus();
}

// ---- events -------------------------------------------------------------------------------------------------------------
function viewEvents(id) {
  if (id) return viewEvent(id);
  const input = h('input', { class: 'input', id: 'q', placeholder: 'Event name, id, or the organiser’s email', 'aria-label': 'Search events', autocomplete: 'off', value: pending.events || '' });
  const out = h('div', { class: 'list' });
  async function run(q) {
    if (q.length < 2) return mount(out, empty('Type at least two characters.'));
    mount(out, empty('Searching…'));
    try {
      const r = (await adm('GET', '/events?q=' + encodeURIComponent(q))).events;
      mount(out, r.length ? r.map((e) => h('a', { class: 'item', href: '#/events/' + encodeURIComponent(e.id) },
        h('div', {}, h('div', { class: 't' }, e.name), h('div', { class: 's' }, [e.venue, e.city].filter(Boolean).join(', ') + (e.starts_at ? ' · ' + when(e.starts_at, { dateStyle: 'medium' }) : ' · date to be announced') + ' · run by ' + (e.owner_name || e.owner_email || 'someone'))),
        h('div', { class: 'row' }, e.kind === 'workplace' ? badge('Office') : null, badge(e.listed ? 'Listed' : 'Not listed', e.listed ? 'ok' : '')))) : empty('No events match.'));
    } catch (ex) { mount(out, h('div', { class: 'error' }, ex.message)); }
  }
  shell('events', h('h1', {}, 'Events'), h('p', { class: 'lede' }, 'Find an event to see how it is doing, who runs it, and to take it off the public list if it has to go.'),
    h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); pending.events = input.value.trim(); run(pending.events); } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Search')), out);
  input.focus();
  if (pending.events) run(pending.events);
}
async function viewEvent(id) {
  shell('events', h('p', { class: 'muted' }, 'Loading…'));
  let d;
  try { d = await adm('GET', '/events/' + encodeURIComponent(id)); } catch (ex) { return shell('events', h('p', {}, h('a', { href: '#/events' }, '← Events')), h('div', { class: 'error' }, ex.message)); }
  const e = d.event;
  const again = () => viewEvent(id);
  shell('events',
    h('p', {}, h('a', { href: '#/events' }, '← Events')),
    h('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start;margin-bottom:10px' },
      h('div', {}, h('h1', {}, e.name), h('p', { class: 'lede', style: 'margin:0' }, [e.venue, e.city].filter(Boolean).join(', ') + (e.starts_at ? ' · ' + when(e.starts_at) : ' · date to be announced'))),
      h('div', { class: 'row' }, badge(e.listed ? 'Listed publicly' : 'Not listed', e.listed ? 'ok' : ''), e.kind === 'workplace' ? badge('Office') : null, e.secure_qr ? badge('Live QR') : null)),
    h('div', { class: 'card' }, h('h2', {}, 'What you can do'), h('div', { class: 'actions' },
      h('button', { class: 'btn ' + (e.listed ? 'danger' : 'primary') + ' small', type: 'button',
        onclick: () => change(e.listed ? { title: 'Take this event off the public list', text: 'It disappears from the Events page. People who already have tickets keep them, and its own page still opens for anyone with the link.', confirmLabel: 'Take it off the list', danger: true } : { title: 'Put this event back on the public list', text: 'It shows on the Events page again.', confirmLabel: 'List it' },
          (v) => adm('POST', '/events/' + encodeURIComponent(id) + '/listed', { listed: !e.listed, reason: v.reason }), again, e.listed ? 'Taken off the list' : 'Back on the list') }, e.listed ? 'Take off the public list' : 'Put back on the public list'),
      h('a', { class: 'btn ghost small', href: '/e/?id=' + encodeURIComponent(id), target: '_blank', rel: 'noopener' }, 'Open its public page'))),
    h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h2', {}, 'The organiser'), kv([['Name', personLink(e.owner_id, e.owner_name || 'No name')], ['Email', e.owner_email || '—'], ['Phone', e.owner_phone || '—'], ['Event id', h('span', { class: 'mono' }, e.id)], ['Gate key ends', e.gate_key_hint ? h('span', { class: 'mono' }, '…' + e.gate_key_hint) : '—'], ['Selfie at the door', e.require_photo ? 'Required' : 'No']])),
      h('div', { class: 'card' }, h('h2', {}, 'Numbers'), kv([['Active passes', String(d.passes.active)], ['Revoked passes', String(d.passes.revoked)], ['Let in', d.entries.granted + ' (' + d.entries.granted_24h + ' in the last 24 hours)'], ['Turned away', d.entries.denied + ' (' + d.entries.denied_24h + ' in the last 24 hours)']]),
        d.entries.denied_reasons.length ? h('div', { style: 'margin-top:10px' }, d.entries.denied_reasons.map((r) => h('div', { class: 'hint' }, (REASONS[r.reason] || r.reason) + ': ' + r.n))) : null)),
    h('div', { class: 'card' }, h('h2', {}, 'Tickets'), table(['Ticket', 'Price', 'Issued', 'Claimed'], d.tiers.map((t) => h('tr', {}, h('td', {}, t.name), h('td', {}, t.price_kobo ? naira(t.price_kobo) : 'Free'),
      h('td', {}, t.capacity ? [t.issued + ' of ' + t.capacity, h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.min(100, Math.round((t.issued / t.capacity) * 100)) + '%' }))] : t.issued + ' (no limit)'), h('td', {}, String(t.claimed)))))));
}

// ---- the audit log ------------------------------------------------------------------------------------------------------
async function viewAudit() {
  const body = h('tbody', {});
  const more = h('button', { class: 'btn ghost', type: 'button' }, 'Load more');
  const note = h('p', { class: 'muted' }, 'Loading…');
  let next = null;
  const targetOf = (e) => (e.target_type === 'user' ? personLink(e.target_id, 'person ' + e.target_id.slice(0, 6)) : e.target_type === 'event' ? h('a', { href: '#/events/' + encodeURIComponent(e.target_id) }, 'event ' + e.target_id.slice(0, 6)) : e.target_type ? e.target_type + ' ' + (e.target_id || '').slice(0, 6) : '');
  async function load(first) {
    more.disabled = true;
    try {
      const r = await adm('GET', '/audit' + (next ? '?before=' + next : ''));
      for (const e of r.entries) body.append(h('tr', {}, h('td', {}, when(e.at, { dateStyle: 'medium', timeStyle: 'medium' })), h('td', {}, e.staff_identifier), h('td', {}, ACTIONS[e.action] || e.action), h('td', {}, targetOf(e)), h('td', {}, e.reason || '')));
      next = r.next; more.style.display = next ? '' : 'none'; note.textContent = first && !r.entries.length ? 'Nothing has been recorded yet.' : '';
    } catch (ex) { note.textContent = ex.message; }
    more.disabled = false;
  }
  more.onclick = () => load(false);
  shell('audit', h('h1', {}, 'Audit log'), h('p', { class: 'lede' }, 'Everything the team does, who did it, to whom and why, newest first. Entries can only be added, never changed or removed. Opening a person’s page is recorded too.'),
    h('div', { class: 'card' }, table(['When', 'Who', 'What', 'About', 'Reason'], body), note), h('div', { style: 'margin-top:12px' }, more));
  load(true);
}

boot();
