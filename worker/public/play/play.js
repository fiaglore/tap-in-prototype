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

// Filters: the server does the filtering (search, place, category, date, price, free, available) so the list stays small.
const CATEGORY_LABEL = { music: 'Music and concerts', festival: 'Festivals', nightlife: 'Nightlife', sports: 'Sports', conference: 'Conferences', exhibition: 'Exhibitions', education: 'Education', networking: 'Business networking', religious: 'Religious gatherings', private: 'Private events', other: 'Other' };
const f = { q: '', country: '', city: '', category: '', from: '', max_price: '', free: false, available: false };
let facets = { countries: [], cities: [], categories: [] };
let timer = null;

function select(label, key, values, labelOf = (v) => v) {
  const el = h('select', { class: 'input', 'aria-label': label, onchange: (e) => { f[key] = e.target.value; load(); } },
    h('option', { value: '' }, label), values.map((v) => h('option', { value: v, selected: f[key] === v }, labelOf(v))));
  return el;
}
function toolbar() {
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search events, venues, cities', 'aria-label': 'Search events', autocomplete: 'off', enterkeyhint: 'search', value: f.q });
  q.addEventListener('input', () => { f.q = q.value.trim(); clearTimeout(timer); timer = setTimeout(load, 250); });
  const date = h('input', { class: 'input', type: 'date', 'aria-label': 'On or after this date', value: f.from, onchange: (e) => { f.from = e.target.value; load(); } });
  const price = h('input', { class: 'input', type: 'number', min: '0', step: '500', placeholder: 'Max price ₦', 'aria-label': 'Maximum price in naira', value: f.max_price, style: 'max-width:150px' });
  price.addEventListener('input', () => { f.max_price = price.value; clearTimeout(timer); timer = setTimeout(load, 400); });
  const chip = (key, label) => h('button', { type: 'button', class: 'chip', 'aria-pressed': f[key] ? 'true' : 'false', onclick: () => { f[key] = !f[key]; load(); } }, label);
  return h('div', { class: 'evtools' }, q,
    h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
      facets.categories.length > 0 && select('Any category', 'category', facets.categories, (v) => CATEGORY_LABEL[v] || v),
      facets.countries.length > 1 && select('Any country', 'country', facets.countries),
      facets.cities.length > 0 && select('Any city', 'city', facets.cities), date, price),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Quick filters' }, chip('free', 'Free'), chip('available', 'Not sold out'),
      Object.values(f).some(Boolean) && h('button', { type: 'button', class: 'chip', onclick: () => { Object.assign(f, { q: '', country: '', city: '', category: '', from: '', max_price: '', free: false, available: false }); load(true); } }, 'Clear filters')));
}

const bar = h('div', {});
box.before(bar);
const count = h('p', { class: 'muted evcount', role: 'status' });
box.before(count);
let seq = 0;
function load(repaintBar = false) {
  const mine = ++seq;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v === true ? '1' : v);
  get('/public/events' + (qs.toString() ? '?' + qs : '')).then((r) => {
    if (mine !== seq) return; // a newer search has started
    const first = !bar.firstChild;
    if (first || repaintBar === true || JSON.stringify(r.facets) !== JSON.stringify(facets)) {
      // Keep the search box (and its caret) alive while typing; only rebuild the toolbar when its choices changed.
      const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.evtools');
      facets = r.facets;
      if (!focused || repaintBar === true) mount(bar, toolbar());
    }
    const filtering = Object.values(f).some(Boolean);
    count.textContent = r.events.length ? r.events.length + (r.events.length === 1 ? ' event' : ' events') : '';
    if (!r.events.length) {
      return mount(box, filtering
        ? h('div', { class: 'emptybox' }, h('h3', {}, 'Nothing matches'), h('p', { class: 'muted', style: 'margin-top:6px' }, 'Try a different search or clear the filters.'))
        : h('div', { class: 'emptybox' }, h('h3', {}, 'No upcoming events yet'), h('p', { class: 'muted', style: 'margin-top:6px' }, 'Check back soon, or run your own.'),
          h('a', { class: 'btn primary', style: 'margin-top:16px', href: '/organiser/' }, 'Organiser sign in')));
    }
    mount(box, r.events.map(card));
  }).catch((ex) => mount(box, h('div', { class: 'error' }, ex.message || 'Could not load events. Try again.')));
}
load();
