// The public Play page: lists upcoming events and sends each one to its own sales page.
import { h, mount } from '/js/dom.js';
import { get } from '/js/api.js';

const box = document.getElementById('events');
const naira = (kobo) => (kobo > 0 ? 'From ₦' + (kobo / 100).toLocaleString('en-NG') : 'Free');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function dateBlock(sec) {
  if (!sec) return h('div', { class: 'date tba', 'aria-label': 'Date to be announced' }, h('b', {}, 'TBA'), h('small', {}, 'Soon'));
  const d = new Date(sec * 1000);
  return h('div', { class: 'date', 'aria-hidden': 'true' }, h('small', {}, MONTHS[d.getMonth()]), h('b', {}, String(d.getDate())), h('small', {}, d.toLocaleDateString(undefined, { weekday: 'short' })));
}
function state(e) {
  if (e.sold_out) return h('span', { class: 'chip bad' }, 'Sold out');
  if (e.sales === 'upcoming') return h('span', { class: 'chip' }, 'Sales open soon');
  if (e.sales === 'closed') return h('span', { class: 'chip' }, 'Sales closed');
  return h('span', { class: 'chip ok' }, 'Tickets on sale');
}
function card(e) {
  const when = e.starts_at ? new Date(e.starts_at * 1000).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }) : 'Date to be announced';
  // Each card opens that event's own sales page.
  return h('a', { class: 'ev', role: 'listitem', href: '/e/?id=' + encodeURIComponent(e.id), 'aria-label': e.name + ', ' + when },
    dateBlock(e.starts_at),
    h('div', {}, h('h3', {}, e.name),
      h('p', { class: 'where' }, [e.venue, e.city].filter(Boolean).join(', ') || when),
      e.venue || e.city ? h('p', { class: 'where', style: 'margin-top:2px' }, when) : null,
      h('div', { class: 'meta' }, state(e), e.from_kobo !== null && e.from_kobo !== undefined ? h('span', { class: 'chip' }, naira(e.from_kobo)) : null, h('span', { class: 'go' }, 'Tickets →'))));
}

// Inside the phone app: a search box and a few filters above the list.
function nativeList(events) {
  const FILTERS = [['all', 'All'], ['on', 'On sale'], ['free', 'Free']];
  let filter = 'all';
  const input = h('input', { class: 'input', id: 'evq', type: 'search', placeholder: 'Search events, venues, cities', 'aria-label': 'Search events', autocomplete: 'off', enterkeyhint: 'search' });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter events' });
  const count = h('p', { class: 'muted evcount', role: 'status' });
  const list = h('div', { role: 'list' });
  const onSale = (e) => !e.sold_out && e.sales !== 'upcoming' && e.sales !== 'closed';
  const paint = () => {
    const term = input.value.trim().toLowerCase();
    const rows = events.filter((e) => (!term || [e.name, e.venue, e.city].filter(Boolean).join(' ').toLowerCase().includes(term))
      && (filter === 'all' || (filter === 'on' && onSale(e)) || (filter === 'free' && e.from_kobo === 0)));
    mount(chips, FILTERS.map(([k, label]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': filter === k ? 'true' : 'false', onclick: () => { filter = k; paint(); } }, label)));
    count.textContent = rows.length === events.length ? events.length + (events.length === 1 ? ' event' : ' events') : rows.length + ' of ' + events.length;
    mount(list, rows.length ? rows.map(card) : h('div', { class: 'emptybox' }, h('h3', {}, 'Nothing matches'), h('p', { class: 'muted', style: 'margin-top:6px' }, 'Try a different search or filter.')));
  };
  input.addEventListener('input', paint);
  mount(box, h('div', { class: 'evtools' }, input, chips), count, list);
  paint();
}

get('/public/events').then((r) => {
  if (!r.events.length) {
    return mount(box, h('div', { class: 'emptybox' }, h('h3', {}, 'No upcoming events yet'), h('p', { class: 'muted', style: 'margin-top:6px' }, 'Check back soon, or run your own.'),
      h('a', { class: 'btn primary', style: 'margin-top:16px', href: '/organiser/' }, 'Organiser sign in')));
  }
  if (document.documentElement.classList.contains('is-native')) nativeList(r.events);
  else mount(box, r.events.map(card));
}).catch((ex) => mount(box, h('div', { class: 'error' }, ex.message || 'Could not load events. Try again.')));
