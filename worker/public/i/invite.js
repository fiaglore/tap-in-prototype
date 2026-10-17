// A guest's invitation, opened from the link the host sent. No account: the link itself is the key.
// The guest answers the RSVP (and how many of their party are coming) and shows the QR code at the door.
import { h, mount, when } from '/js/dom.js';
import { post } from '/js/api.js';
import { qrSvg } from '/js/qr.js';

const root = document.getElementById('root');
const token = decodeURIComponent(location.hash.slice(1));

function fail(title, message) {
  mount(root, h('div', { class: 'inv-head' }, h('h1', {}, title), h('p', { class: 'muted' }, message)));
}

function render(d, note = '') {
  const e = d.event, g = d.guest;
  document.title = `${e.name} · Your invitation`;
  const place = [e.venue, e.city].filter(Boolean).join(', ');
  const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
  const howMany = h('select', { class: 'input', 'aria-label': 'How many of you are coming' },
    Array.from({ length: g.party_size }, (_, i) => i + 1).map((n) => h('option', { value: n, selected: n === (g.attending || g.party_size) }, people(n))));
  const msg = h('div', { role: 'status' }, note && h('div', { class: 'notice', style: 'margin-top:12px' }, note));

  async function answer(response, btn) {
    btn.disabled = true;
    try {
      const r = await post('/invitation/rsvp', { token, response, attending: response === 'yes' ? Number(howMany.value) : undefined });
      render(r, response === 'yes' ? 'Thank you. The host knows you are coming.' : 'Thank you for letting the host know.');
    } catch (ex) {
      btn.disabled = false;
      mount(msg, h('div', { class: 'error', role: 'alert' }, ex.message));
    }
  }
  const yes = h('button', { class: 'btn primary', type: 'button', 'aria-pressed': String(g.rsvp === 'yes'), onclick: (ev) => answer('yes', ev.currentTarget) }, g.rsvp === 'yes' ? 'Coming ✓' : 'I’m coming');
  const no = h('button', { class: 'btn ghost', type: 'button', 'aria-pressed': String(g.rsvp === 'no'), onclick: (ev) => answer('no', ev.currentTarget) }, g.rsvp === 'no' ? 'Not coming' : 'I can’t make it');

  mount(root,
    h('div', { class: 'inv-head' },
      h('p', { class: 'eyebrow' }, 'You’re invited'),
      h('h1', {}, e.name),
      h('p', { class: 'when' }, [e.starts_at && when(e.starts_at), place].filter(Boolean).join(' · '))),
    h('div', { class: 'card inv-card' },
      h('p', { class: 'dear' }, 'For ', h('strong', {}, g.name)),
      h('p', { class: 'party' }, g.party_size > 1 ? `This invitation is for up to ${people(g.party_size)}.` : 'This invitation is for one person.', g.table ? ` Your table: ${g.table}.` : ''),
      h('h3', { style: 'margin-top:16px' }, 'Will you be there?'),
      g.party_size > 1 && h('div', { class: 'howmany' }, h('span', {}, 'How many of you?'), howMany),
      h('div', { class: 'rsvp-row' }, yes, no),
      msg),
    h('div', { class: 'card entry' },
      h('h3', {}, 'Your entry code'),
      h('p', { class: 'muted', style: 'margin-top:4px' }, g.party_size > 1 ? 'Show this at the door. One scan lets your whole party in.' : 'Show this at the door.'),
      h('div', { class: 'qr' }, qrSvg(d.code, 'Entry code for ' + g.name)),
      h('p', { class: 'code' }, d.code),
      h('p', { class: 'hint', style: 'margin-top:10px' }, 'Keep this link, or take a screenshot of the code. ' + (e.reentry ? 'You can come and go with it.' : 'It works once at each entrance.') + ' Please do not share it: it is only for you and your party.')));
}

(async function start() {
  if (!token) return fail('Invitation not found', 'This link is incomplete. Open the full link the host sent you.');
  try { render(await post('/invitation', { token })); }
  catch (ex) {
    if (ex.status === 410) fail('Invitation cancelled', ex.message);
    else if (ex.status === 429) fail('Please wait', ex.message);
    else fail('Invitation not found', ex.message);
  }
})();
