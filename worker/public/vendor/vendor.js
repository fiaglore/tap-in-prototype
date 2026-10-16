import { h, wordmarkText, mount, toast, copy, ago } from '/js/dom.js';
import { get, post, patch } from '/js/api.js';
import { signInFlow } from '/js/auth-ui.js';

const top = document.getElementById('top');
const main = document.getElementById('main');
let user = null;

const naira = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: kobo % 100 ? 2 : 0, maximumFractionDigits: 2 });
const toKobo = (v) => { const n = Number.parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };

function header() {
  mount(top,
    h('a', { class: 'wordmark', href: '/' }, wordmarkText(), ' ', h('span', { class: 'muted', style: 'font-weight:600;font-size:14px' }, 'Vendors')),
    h('div', { class: 'row' },
      h('a', { class: 'btn ghost small hide-sm', href: '/till/' }, 'Open till'),
      user && h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { await post('/auth/logout').catch(() => {}); user = null; boot(); } }, 'Sign out'),
      window.TapTheme.button()));
}

async function boot() {
  header();
  try { user = (await get('/me')).user; } catch { user = null; }
  header();
  if (!user) return viewSignIn();
  route();
}
window.addEventListener('hashchange', () => user && route());

function viewSignIn() {
  const box = h('div', { class: 'narrow card', style: 'margin-top:6vh' });
  mount(main, box);
  signInFlow(box, { title: 'Vendor sign-in', lede: 'Sign in with the phone number or email you will manage your business from.', onDone: (u) => { user = u; header(); location.hash = '#/'; route(); } });
}

function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  if (parts[0] === 'new') return viewNew();
  if (parts[0] === 'v' && parts[1]) return viewVendor(parts[1]);
  viewList();
}

const fail = (ex) => {
  if (ex.status === 401) { user = null; boot(); return; }
  mount(main, h('div', { class: 'error' }, ex.message), h('p', { style: 'margin-top:12px' }, h('a', { href: '#/' }, 'Back to your businesses')));
};

async function viewList() {
  try {
    const { vendors } = await get('/vendors');
    document.title = 'Vendors · Tap In';
    mount(main, h('div', { class: 'narrow' },
      h('div', { class: 'spread' }, h('h1', { style: 'font-size:34px' }, 'Your businesses'), h('a', { class: 'btn primary', href: '#/new' }, 'Add a business')),
      h('p', { class: 'muted', style: 'margin-top:6px' }, 'Take payments from Tap In wallets. Customers pay by showing a code; you scan it on the till.'),
      vendors.length
        ? h('div', { class: 'stack', style: 'margin-top:18px' }, vendors.map((v) => h('a', { class: 'card', href: '#/v/' + v.id, style: 'text-decoration:none;color:inherit' },
            h('p', { class: 'eyebrow' }, v.category || 'Business'),
            h('h3', { style: 'font-size:20px;margin:4px 0' }, v.name),
            h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'chip ok' }, naira(v.balance_kobo) + ' balance'), h('span', { class: 'chip' }, v.sales + ' sales')))))
        : h('div', { class: 'card', style: 'margin-top:18px;text-align:center;padding:40px' }, h('p', {}, 'No businesses yet.'), h('a', { class: 'btn primary', style: 'margin-top:14px', href: '#/new' }, 'Set up your first business'))));
  } catch (ex) { fail(ex); }
}

function viewNew(err = '', draft = {}) {
  document.title = 'Add a business · Tap In';
  const name = h('input', { class: 'input', id: 'bn', value: draft.name || '', maxlength: '80', required: true });
  const cat = h('input', { class: 'input', id: 'bc', value: draft.category || '', maxlength: '40', placeholder: 'e.g. Food, Drinks, Merch' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create business');
  mount(main, h('div', { class: 'narrow' },
    h('a', { href: '#/' }, '← Businesses'),
    h('h1', { style: 'font-size:34px;margin:8px 0 4px' }, 'Add a business'),
    h('p', { class: 'muted' }, 'You get a till key for the device that takes payments.'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const r = await post('/vendors', { name: name.value, category: cat.value });
        mount(main, h('div', { class: 'narrow card' },
          h('p', { class: 'eyebrow' }, 'Business created'), h('h2', { style: 'margin:4px 0 10px' }, r.vendor.name),
          h('p', {}, 'This is the till key. Enter it on the till page on each device. ', h('strong', {}, 'It is shown only once'), ' (you can make a new one later).'),
          h('div', { class: 'gatekey', style: 'margin:14px 0' }, r.till_key),
          h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => copy(r.till_key, 'Till key copied') }, 'Copy key'),
            h('button', { class: 'btn primary', type: 'button', onclick: () => { location.hash = '#/v/' + r.vendor.id; } }, 'I have saved it. Continue'))));
      } catch (ex) { viewNew(ex.message, { name: name.value, category: cat.value }); }
    } },
      h('div', { class: 'field' }, h('label', { for: 'bn' }, 'Business name'), name),
      h('div', { class: 'field' }, h('label', { for: 'bc' }, 'Category (optional)'), cat),
      err && h('div', { class: 'error', role: 'alert' }, err),
      h('div', { style: 'margin-top:20px' }, btn))));
}

async function viewVendor(id) {
  try {
    const d = await get('/vendors/' + id);
    const v = d.vendor;
    document.title = v.name + ' · Tap In';
    const keyBox = h('div', {});
    const amt = h('input', { class: 'input', id: 'po', inputmode: 'decimal', placeholder: 'Amount in naira' });
    const listed = h('input', { type: 'checkbox', checked: v.listed, onchange: async (e) => { try { await patch('/vendors/' + id, { listed: e.target.checked }); toast('Saved'); } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message); } } });
    const kinds = { payment: 'Sale', refund: 'Refund', payout: 'Payout' };
    mount(main, h('div', { class: 'narrow' },
      h('a', { href: '#/' }, '← Businesses'),
      h('div', { class: 'spread', style: 'margin:8px 0' }, h('h1', { style: 'font-size:34px' }, v.name), h('a', { class: 'btn primary small', href: '/till/' }, 'Open till')),
      h('div', { class: 'grid cols' }, [['Balance', naira(v.balance_kobo), true], ['Sales', naira(d.totals.taken)], ['Refunded', naira(d.totals.refunded)], ['Paid out', naira(d.totals.paid_out)]].map(([l, val, dk]) => h('div', { class: 'card stat' + (dk ? ' dk' : '') }, h('b', {}, val), h('span', {}, l)))),
      h('div', { class: 'grid two', style: 'margin-top:14px' },
        h('form', { class: 'card', onsubmit: async (e) => {
          e.preventDefault();
          const kobo = toKobo(amt.value);
          if (!(kobo > 0)) return toast('Enter an amount to pay out.');
          try { await post(`/vendors/${id}/payout`, { amount_kobo: kobo }); toast('Payout recorded'); viewVendor(id); } catch (ex) { toast(ex.message); }
        } }, h('h3', {}, 'Pay out'), h('p', { class: 'hint', style: 'margin:4px 0 8px' }, 'Demo: this records the payout; no bank transfer happens yet.'),
          h('div', { class: 'field' }, h('label', { for: 'po' }, 'Amount (₦)'), amt),
          h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary small', type: 'submit' }, 'Pay out'), h('button', { class: 'btn ghost small', type: 'button', onclick: () => { amt.value = String(v.balance_kobo / 100); } }, 'All of it'))),
        h('div', { class: 'card' }, h('h3', {}, 'Till key'),
          h('p', { class: 'muted', style: 'margin-top:6px' }, 'Current key ends in ', h('strong', { class: 'mono' }, v.till_key_hint || '????'), '. Lost it? Make a new one; the old one stops working at once.'), keyBox,
          h('button', { class: 'btn danger small', style: 'margin-top:10px', type: 'button', onclick: async () => {
            if (!confirm('Make a new till key? Every till using the old key will stop working until you enter the new one.')) return;
            try { const r = await post(`/vendors/${id}/till-key`); mount(keyBox, h('div', { class: 'gatekey', style: 'margin-top:12px' }, r.till_key), h('button', { class: 'btn ghost small', style: 'margin-top:8px', type: 'button', onclick: () => copy(r.till_key, 'Till key copied') }, 'Copy key')); } catch (ex) { toast(ex.message); }
          } }, 'Make a new till key'),
          h('div', { class: 'checks', style: 'margin-top:14px' }, h('label', {}, listed, 'Show in the “Tap In enabled” list')))),
      h('h3', { style: 'margin:22px 0 6px' }, 'Activity'),
      h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'What', 'Customer', 'Amount', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, d.entries.length ? d.entries.map((e) => h('tr', {},
          h('td', {}, ago(e.at)), h('td', {}, kinds[e.kind] || e.kind, e.refunded && h('span', { class: 'chip', style: 'margin-left:6px' }, 'Refunded')), h('td', {}, e.customer || '—'),
          h('td', { class: 'mono' }, (e.kind === 'payment' ? '+' : '−') + naira(e.amount_kobo)),
          h('td', {}, e.kind === 'payment' && !e.refunded && h('button', { class: 'btn danger small', type: 'button', onclick: async () => {
            if (!confirm(`Refund ${naira(e.amount_kobo)} to ${e.customer || 'the customer'}? It comes out of your balance.`)) return;
            try { await post(`/vendors/${id}/refunds`, { payment_id: e.id }); toast('Refunded'); viewVendor(id); } catch (ex) { toast(ex.message); }
          } }, 'Refund')))) : h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'No sales yet.')))))));
  } catch (ex) { fail(ex); }
}

boot();
