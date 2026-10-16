// Public ticket sales page (demo). Anyone can see prices; buying needs a signed-in session so the
// ticket has somewhere to land. No real payment runs here — this stands in for a checkout step.
import { h, mount, when } from '/js/dom.js';
import { get, post } from '/js/api.js';
import { signInFlow } from '/js/auth-ui.js';

const root = document.getElementById('root');
const eventId = new URLSearchParams(location.search).get('id');

const naira = (kobo) => (kobo > 0 ? '₦' + (kobo / 100).toLocaleString('en-NG') : 'Free');

function fail(message) {
  mount(root, h('h2', {}, 'Can’t open this page'), h('p', { class: 'muted', style: 'margin-top:6px' }, message),
    h('a', { class: 'btn primary block', style: 'margin-top:16px', href: '/' }, 'Back home'));
}

function confirmed(tierName, extraCodes) {
  mount(root,
    h('p', { class: 'eyebrow' }, 'Purchase complete (demo)'),
    h('h2', { style: 'margin-top:6px' }, 'You’re in — ' + tierName),
    h('p', { class: 'muted', style: 'margin-top:6px' }, 'Your ticket was added to your account. Open the app to see your QR pass.'),
    h('a', { class: 'btn primary block', style: 'margin-top:16px', href: '/app/' }, 'Open my pass'),
    extraCodes.length > 0 && h('div', { class: 'card', style: 'margin-top:18px' },
      h('h3', {}, `${extraCodes.length} more code${extraCodes.length === 1 ? '' : 's'} from this purchase`),
      h('p', { class: 'hint', style: 'margin-top:4px' }, 'Send one to each person you bought a ticket for. They add it in the app under their own account.'),
      h('div', { class: 'stack', style: 'margin-top:10px' }, extraCodes.map((c) => h('div', { class: 'input code', style: 'user-select:all' }, c)))));
}

function buyFlow(ev, tier, qty) {
  mount(root, h('p', { class: 'muted' }, 'Setting up your ticket…'));
  const run = async () => {
    try {
      const r = await post(`/public/events/${ev.id}/buy`, { tier_id: tier.id, qty });
      confirmed(tier.name, r.extra_codes || []);
    } catch (ex) {
      if (ex.status === 401) {
        signInFlow(root, {
          title: 'Sign in to get your ticket',
          lede: `We need a phone number or email so your ${tier.name} ticket has somewhere to go.`,
          onDone: run
        });
      } else {
        mount(root, h('div', { class: 'error', role: 'alert' }, ex.message),
          h('button', { class: 'btn primary block', style: 'margin-top:16px', type: 'button', onclick: () => tierPage(ev) }, 'Back to tickets'));
      }
    }
  };
  run();
}

function tierPage(ev) {
  document.title = ev.event.name + ' · Tap In';
  const when_ = [ev.event.venue, ev.event.city, ev.event.starts_at && when(ev.event.starts_at)].filter(Boolean).join(' · ');
  mount(root,
    h('p', { class: 'eyebrow' }, 'Demo checkout — no real payment is taken'),
    h('h1', { style: 'font-size:30px;margin-top:4px' }, ev.event.name),
    when_ && h('p', { class: 'muted', style: 'margin-top:4px' }, when_),
    h('div', { class: 'stack', style: 'margin-top:20px' }, ev.tiers.map((t) => {
      const qty = h('select', { class: 'input', style: 'width:84px', 'aria-label': `Quantity for ${t.name}` },
        [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { value: n }, String(n))));
      return h('div', { class: 'card row', style: 'justify-content:space-between' },
        h('div', {}, h('div', { style: 'font-weight:700' }, t.name), h('div', { class: 'muted' }, naira(t.price_kobo))),
        h('div', { class: 'row' }, qty,
          h('button', { class: 'btn primary small', type: 'button', onclick: () => buyFlow(ev.event, t, Number.parseInt(qty.value, 10)) }, 'Get ticket')));
    })),
    ev.tiers.length === 0 && h('p', { class: 'muted', style: 'margin-top:12px' }, 'Tickets for this event are not on sale yet.'));
}

if (!eventId) {
  fail('This link is missing an event. Ask the organiser for the sales page link again.');
} else {
  get(`/public/events/${eventId}`).then(tierPage).catch((ex) => fail(ex.message));
}
