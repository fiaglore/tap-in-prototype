import { h, wordmarkText, mount, toast, copy, when, ago, download } from '/js/dom.js';
import { get, post, patch } from '/js/api.js';
import { signInFlow } from '/js/auth-ui.js';
import { qrSvg } from '/js/qr.js';

const OFFICE = document.body.dataset.console === 'office';
const CONSOLE = OFFICE ? 'Offices' : 'Organiser';
const top = document.getElementById('top');
const main = document.getElementById('main');
let user = null;
let timer = null;
const reasons = { already_used: 'Already used', no_zone_access: 'Wrong area', revoked: 'Cancelled pass', expired: 'Pass expired', outside_hours: 'Outside hours', stale_code: 'Old code / screenshot', static_pass: 'Screenshot or printout', invalid_token: 'Unreadable / fake', wrong_event: 'Other event' };

function header() {
  mount(top,
    h('a', { class: 'wordmark', href: '#/' }, wordmarkText(), ' ', h('span', { class: 'muted', style: 'font-weight:600;font-size:14px' }, CONSOLE)),
    h('div', { class: 'row' },
      h('a', { class: 'btn ghost small hide-sm', href: '/gate/' }, 'Open scanner'),
      !user && h('span', { class: 'hint hide-sm' }, 'Sign in below'),
      user && h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { await post('/auth/logout').catch(() => {}); user = null; boot(); } }, 'Sign out'),
      window.TapTheme.button()));
}

function stopTimer() { if (timer) clearInterval(timer); timer = null; }

async function boot() {
  header();
  try {
    user = (await get('/me')).user;
  } catch {
    user = null;
  }
  header();
  if (!user) return viewSignIn();
  route();
}
window.addEventListener('hashchange', () => user && route());

function viewSignIn() {
  // Signing in sits at the very top of the page, with a short reminder of what you get below it.
  const box = h('div', { class: 'card signin-top' });
  const perks = OFFICE
    ? [['Add people by email', 'Staff, contractors and visitors get their pass in the app. Nothing to send.'], ['Set the hours', 'Each group is allowed in at certain entrances, only at certain times.'], ['Selfie check', 'Door staff see a face next to every name.']]
    : [['Sell tickets', 'Limits that cannot oversell, sales windows, and a public page for each event.'], ['Live QR', 'The pass code changes every 30 seconds, so screenshots stop working.'], ['Scan at the gate', 'Staff see a clear admit or refuse, with the face on file.']];
  mount(main, h('div', { class: 'narrow' }, box,
    h('div', { class: 'grid three', style: 'margin-top:18px' }, perks.map(([t, d]) => h('div', { class: 'card' }, h('h3', {}, t), h('p', { class: 'muted', style: 'margin-top:4px;font-size:14px' }, d))))));
  signInFlow(box, { title: OFFICE ? 'Tap In for Business sign in' : 'Organiser sign in', lede: OFFICE ? 'Sign in with the phone number or email you will manage your office from.' : 'Sign in with the phone number or email you will run events from.', onDone: (u) => { user = u; header(); location.hash = '#/'; route(); } });
}

function route() {
  stopTimer();
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  if (!parts.length) return viewEvents();
  if (parts[0] === 'new') return viewNew('', undefined, OFFICE);
  if (parts[0] === 'e' && parts[1]) return viewEvent(parts[1], parts[2] || 'overview');
  viewEvents();
}


// Two-column layout: sidebar navigation on the left, content on the right (stacks on phones).
function layout(items, content) {
  return h('div', { class: 'org' },
    h('nav', { class: 'side', 'aria-label': 'Sections' }, items.map((i) => i.label
      ? h('p', { class: 'eyebrow side-label' }, i.label)
      : h('a', { href: i.href, 'aria-current': i.on ? 'page' : null }, i.text))),
    h('div', { class: 'main' }, content));
}
const listNav = (on) => [{ href: '#/', text: OFFICE ? 'Your offices' : 'Your events', on: on === 'list' }, { href: '#/new', text: OFFICE ? 'New office' : 'New event', on: on === 'new' }, { href: '/gate/', text: 'Open scanner' }];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const fail = (ex) => {
  if (ex.status === 401) { user = null; boot(); return; }
  mount(main, h('div', { class: 'error' }, ex.message), h('p', { style: 'margin-top:12px' }, h('a', { href: '#/' }, OFFICE ? 'Back to offices' : 'Back to events')));
};

// ---- Events list -------------------------------------------------------------------------------------
async function viewEvents() {
  try {
    const { events } = await get('/events?kind=' + (OFFICE ? 'workplace' : 'event'));
    document.title = (OFFICE ? 'Offices' : 'Events') + ' · Tap In';
    mount(main, layout(listNav('list'), h('div', {},
      h('div', { class: 'spread' }, h('h1', { style: 'font-size:34px' }, OFFICE ? 'Your offices' : 'Your events'), h('a', { class: 'btn primary', href: '#/new' }, OFFICE ? 'New office' : 'New event')),
      events.length
        ? h('div', { class: 'grid two', style: 'margin-top:18px' }, events.map((e) => h('a', { class: 'card', href: '#/e/' + e.id, style: 'text-decoration:none;color:inherit' },
            h('p', { class: 'eyebrow' }, e.kind === 'workplace' ? 'Office access' : e.starts_at ? when(e.starts_at, { dateStyle: 'medium' }) : 'Date to be announced'),
            h('h3', { style: 'font-size:20px;margin:4px 0' }, e.name),
            h('p', { class: 'muted' }, [e.venue, e.city].filter(Boolean).join(', ')),
            h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'chip' }, e.registered + (e.kind === 'workplace' ? ' people' : ' registered')), h('span', { class: 'chip ok' }, e.checked_in + (e.kind === 'workplace' ? ' seen' : ' checked in')), h('span', { class: 'chip' }, e.invites_open + (e.kind === 'workplace' ? ' waiting to join' : ' invites open'))))))
        : h('div', { class: 'card', style: 'margin-top:18px;text-align:center;padding:40px' }, h('p', {}, OFFICE ? 'No offices yet.' : 'No events yet.'), h('a', { class: 'btn primary', style: 'margin-top:14px', href: '#/new' }, OFFICE ? 'Set up your first office' : 'Create your first event')))));
  } catch (ex) { fail(ex); }
}

// ---- Create event -------------------------------------------------------------------------------------
// A wedding, party or launch: one entrance, a free "Guest" ticket, not on the public Play page; then the guest list.
const PRIVATE_DRAFT = { private: true, name: '', venue: '', city: 'Lagos', starts_at: '', zones: ['Entrance'], tiers: [{ name: 'Guest', zones: ['Entrance'], price: '', capacity: '' }], reentry: true, sales_start: '', sales_end: '', secure_qr: false, require_photo: false, listed: false };

function viewNew(err = '', draft, office = false) {
  if (draft && draft.office !== undefined) office = draft.office;
  const isPrivate = !office && !!(draft && draft.private);
  const T = office
    ? { page: 'New office', title: 'Name of the company or office', area: 'Doors', areaOne: 'door', group: 'Access groups', groupOne: 'access group', create: 'Create office', lede: 'Doors are the entrances you scan at. Access groups decide which doors people can open, and when.' }
    : { page: 'New event', title: 'Event name', area: 'Areas', areaOne: 'area', group: 'Ticket types', groupOne: 'ticket type', create: 'Create event', lede: 'Areas are the doors or zones you scan at. Ticket types decide which areas a pass can enter.' };
  document.title = T.page + ' · Tap In';
  const d = draft || (office
    ? { name: '', venue: '', city: 'Lagos', starts_at: '', zones: ['Front door'], tiers: [{ name: 'Staff', zones: ['Front door'], days: [0, 1, 2, 3, 4], from: '07:00', to: '19:00' }], reentry: true }
    : { name: '', venue: '', city: 'Lagos', starts_at: '', zones: ['Main entrance'], tiers: [{ name: 'General', zones: ['Main entrance'], price: '', capacity: '' }], reentry: false, sales_start: '', sales_end: '', secure_qr: false, require_photo: false, listed: true });
  const name = h('input', { class: 'input', id: 'n', value: d.name, maxlength: '80', required: true });
  const venue = h('input', { class: 'input', id: 'v', value: d.venue, maxlength: '80' });
  const city = h('input', { class: 'input', id: 'c', value: d.city, maxlength: '80' });
  const starts = h('input', { class: 'input', id: 's', type: 'datetime-local', value: d.starts_at });
  const reentry = h('input', { type: 'checkbox', id: 'r', checked: d.reentry });
  const secure = h('input', { type: 'checkbox', id: 'q', checked: !!d.secure_qr });
  const listedBox = h('input', { type: 'checkbox', id: 'ls', checked: d.listed === undefined ? true : !!d.listed });
  const selfie = h('input', { type: 'checkbox', id: 'sf', checked: d.require_photo === undefined ? office : !!d.require_photo });
  const salesStart = h('input', { class: 'input', id: 'ss', type: 'datetime-local', value: d.sales_start || '' });
  const salesEnd = h('input', { class: 'input', id: 'se', type: 'datetime-local', value: d.sales_end || '' });
  const zoneInputs = [];
  const zoneBox = h('div', { class: 'stack' });
  const tierBox = h('div', { class: 'stack' });
  const tiers = d.tiers.map((t) => ({ ...t, zones: new Set(t.zones), price: t.price ?? '', capacity: t.capacity ?? '', days: new Set(t.days ?? [0, 1, 2, 3, 4, 5, 6]), from: t.from ?? '', to: t.to ?? '' }));

  function zoneNames() { return zoneInputs.map((i) => i.value.trim()).filter(Boolean); }
  function drawZones(names) {
    zoneInputs.length = 0;
    zoneBox.replaceChildren(...names.map((z, i) => {
      const inp = h('input', { class: 'input', value: z, maxlength: '60', 'aria-label': T.areaOne + ' name', oninput: () => drawTiers() });
      zoneInputs.push(inp);
      return h('div', { class: 'row' }, h('div', { style: 'flex:1' }, inp), names.length > 1 && h('button', { class: 'btn ghost small', type: 'button', onclick: () => { drawZones(zoneNames().filter((_, j) => j !== i)); drawTiers(); } }, 'Remove'));
    }));
  }
  function drawTiers() {
    const zs = zoneNames();
    tierBox.replaceChildren(...tiers.map((t, i) => h('div', { class: 'tierrow' },
      h('div', { class: 'row' },
        h('div', { style: 'flex:1' }, h('input', { class: 'input', value: t.name, maxlength: '60', 'aria-label': T.groupOne + ' name', oninput: (e) => { t.name = e.target.value; } })),
        !office && h('input', { class: 'input', style: 'width:110px', value: t.price, inputmode: 'decimal', placeholder: 'Free', 'aria-label': 'Price in naira, blank for free', oninput: (e) => { t.price = e.target.value; } }),
        !office && h('input', { class: 'input', style: 'width:110px', value: t.capacity, inputmode: 'numeric', placeholder: 'No limit', 'aria-label': 'Most tickets of this type, blank for no limit', oninput: (e) => { t.capacity = e.target.value; } }),
        tiers.length > 1 && h('button', { class: 'btn ghost small', type: 'button', onclick: () => { tiers.splice(i, 1); drawTiers(); } }, 'Remove')),
      h('div', { class: 'checks' }, zs.map((z) => h('label', {}, h('input', { type: 'checkbox', checked: t.zones.has(z), onchange: (e) => { e.target.checked ? t.zones.add(z) : t.zones.delete(z); } }), z))),
      office && h('div', { style: 'margin-top:10px' },
        h('div', { class: 'checks' }, DAY_NAMES.map((n, di) => h('label', {}, h('input', { type: 'checkbox', checked: t.days.has(di), onchange: (e) => { e.target.checked ? t.days.add(di) : t.days.delete(di); } }), n))),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('label', { class: 'hint' }, 'From ', h('input', { class: 'input', type: 'time', style: 'width:120px', value: t.from, oninput: (e) => { t.from = e.target.value; } })),
          h('label', { class: 'hint' }, 'Until ', h('input', { class: 'input', type: 'time', style: 'width:120px', value: t.to, oninput: (e) => { t.to = e.target.value; } })),
          h('span', { class: 'hint' }, 'Lagos time. Leave blank for any time.'))))));
  }
  drawZones(d.zones);
  drawTiers();

  const btn = h('button', { class: 'btn primary', type: 'submit' }, T.create);
  mount(main, h('div', { class: 'narrow' },
    h('a', { href: '#/' }, OFFICE ? '← Offices' : '← Events'),
    h('h1', { style: 'font-size:34px;margin:8px 0 4px' }, T.page),
    h('p', { class: 'muted' }, T.lede),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        const zs = zoneNames();
        const body = {
          kind: office ? 'workplace' : 'event',
          name: name.value, venue: venue.value, city: city.value, allow_reentry: reentry.checked,
          starts_at: starts.value && !office ? new Date(starts.value).toISOString() : undefined,
          zones: zs,
          tiers: tiers.map((t) => ({ name: t.name, zones: zs.filter((z) => t.zones.has(z)),
            ...(office ? { days: [...t.days].sort(), from: t.from || undefined, to: t.to || undefined } : { price_kobo: t.price.trim() ? Math.round(parseFloat(t.price) * 100) : 0, capacity: String(t.capacity).trim() || undefined }) })),
          require_photo: selfie.checked,
          listed: office ? undefined : listedBox.checked,
          secure_qr: !office && secure.checked,
          sales_start: !office && salesStart.value ? new Date(salesStart.value).toISOString() : undefined,
          sales_end: !office && salesEnd.value ? new Date(salesEnd.value).toISOString() : undefined
        };
        try {
          const r = await post('/events', body);
          showGateKey(r.event, r.gate_key, () => { location.hash = '#/e/' + r.event.id + (office ? '/people' : isPrivate ? '/guests' : '/invites'); });
        } catch (ex) {
          viewNew(ex.message, { office, private: isPrivate, name: name.value, venue: venue.value, city: city.value, starts_at: starts.value, zones: zs, tiers: tiers.map((t) => ({ name: t.name, zones: [...t.zones], price: t.price, capacity: t.capacity, days: [...t.days], from: t.from, to: t.to })), reentry: reentry.checked, secure_qr: secure.checked, require_photo: selfie.checked, listed: listedBox.checked, sales_start: salesStart.value, sales_end: salesEnd.value });
        }
      }
    },
      !office && h('div', { class: 'notice', style: 'margin-bottom:6px' }, isPrivate
        ? ['Private event: guests get an invitation link, answer the RSVP and show their code at the door. ', h('button', { class: 'linkbtn', type: 'button', onclick: () => viewNew('', null, false) }, 'Switch to a ticketed event')]
        : ['Planning a wedding, party or launch? ', h('button', { class: 'linkbtn', type: 'button', onclick: () => viewNew('', PRIVATE_DRAFT, false) }, 'Start from the private-event setup'), ' (invitations with RSVP and plus-ones, no tickets to sell).']),
      h('div', { class: 'field' }, h('label', { for: 'n' }, isPrivate ? 'Name of the occasion (e.g. Tolu & Ada\u2019s wedding)' : T.title), name),
      h('div', { class: 'grid two' }, h('div', { class: 'field' }, h('label', { for: 'v' }, office ? 'Address or building' : 'Venue'), venue), h('div', { class: 'field' }, h('label', { for: 'c' }, 'City'), city)),
      !office && h('div', { class: 'field' }, h('label', { for: 's' }, 'Starts'), starts),
      h('h3', { style: 'margin-top:22px' }, T.area), zoneBox,
      h('button', { class: 'btn ghost small', style: 'margin-top:8px', type: 'button', onclick: () => { drawZones([...zoneNames(), '']); drawTiers(); } }, 'Add ' + T.areaOne),
      h('h3', { style: 'margin-top:22px' }, T.group), tierBox,
      h('button', { class: 'btn ghost small', style: 'margin-top:8px', type: 'button', onclick: () => { tiers.push({ name: '', zones: new Set(), days: new Set([0, 1, 2, 3, 4, 5, 6]), from: '', to: '', price: '', capacity: '' }); drawTiers(); } }, 'Add ' + T.groupOne),
      !office && h('div', { class: 'grid two', style: 'margin-top:14px' },
        h('div', { class: 'field' }, h('label', { for: 'ss' }, 'Ticket sales open (optional)'), salesStart),
        h('div', { class: 'field' }, h('label', { for: 'se' }, 'Ticket sales close (optional)'), salesEnd)),
      !office && h('div', { class: 'checks', style: 'margin-top:20px' },
        h('label', {}, reentry, 'Allow re-entry (a pass can be scanned in again at the same area)'),
        h('label', {}, secure, 'Live QR: the pass code changes every 30 seconds so screenshots stop working (phones need a connection)')),
      !office && h('div', { class: 'checks', style: 'margin-top:14px' }, h('label', {}, listedBox, 'Show this event on the public Play page so people can find it and open its ticket page (untick for a private, invite-only event)')),
      h('div', { class: 'checks', style: 'margin-top:14px' }, h('label', {}, selfie, 'Ask for a selfie when someone adds their pass, and show it to door staff when it is scanned (so they can match the face to the person)')),
      err && h('div', { role: 'alert', class: err ? 'error' : '' }, err),
      h('div', { style: 'margin-top:20px' }, btn))));
}

function showGateKey(event, key, next) {
  mount(main, h('div', { class: 'narrow card' },
    h('p', { class: 'eyebrow' }, event.kind === 'workplace' ? 'Office created' : 'Event created'),
    h('h2', { style: 'margin:4px 0 10px' }, event.name),
    h('p', {}, 'This is the gate key. Put it into the scanner on each door device. ', h('strong', {}, 'It is shown only once'), ' (you can rotate it later to get a new one).'),
    h('div', { class: 'gatekey', style: 'margin:14px 0' }, key),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => copy(key, 'Gate key copied') }, 'Copy key'),
      h('button', { class: 'btn primary', type: 'button', onclick: next }, 'I have saved it. Continue'))));
}

// ---- One event -----------------------------------------------------------------------------------------
async function viewEvent(id, tab) {
  try {
    const data = await get('/events/' + id);
    document.title = data.event.name + ' · Tap In';
    const office = data.event.kind === 'workplace';
    if (office !== OFFICE) { location.replace((office ? '/offices/' : '/organiser/') + '#/e/' + id); return; }
    const tabs = office
      ? [['overview', 'Overview'], ['people', 'Add people'], ['attendees', 'Who has access'], ['team', 'Door staff'], ['report', 'Report'], ['gate', 'Doors & key']]
      : [['overview', 'Overview'], ['tickets', 'Tickets'], ['guests', 'Guest list'], ['invites', 'Invite codes'], ['attendees', 'Attendees'], ['team', 'Gate team'], ['report', 'Report'], ['gate', 'Gate key & rules']];
    const items = [{ href: '#/', text: OFFICE ? '\u2190 All offices' : '\u2190 All events' }, { label: data.event.name }]
      .concat(tabs.map(([k, label]) => ({ href: `#/e/${id}/${k}`, text: label, on: tab === k })))
      .concat([{ href: '/gate/', text: 'Open scanner' }]);
    const body = h('div', {});
    mount(main, layout(items, h('div', {},
      h('div', { class: 'spread' },
        h('div', {}, h('h1', { style: 'font-size:34px' }, data.event.name), h('p', { class: 'muted' }, [data.event.venue, data.event.city, data.event.starts_at && when(data.event.starts_at)].filter(Boolean).join(' \u00b7 '))),
        // A private event with only free tickets has no sales page worth sharing: guests come in by invitation.
        !office && (data.event.listed || data.tiers.some((t) => t.price_kobo > 0)) && h('button', { class: 'btn ghost small', type: 'button', onclick: () => copy(location.origin + '/e/?id=' + id, 'Sales page link copied') }, 'Copy sales page link')),
      body)));
    ({ overview: tabOverview, tickets: tabTickets, invites: tabInvites, people: tabPeople, attendees: tabAttendees, team: tabTeam, report: tabReport, guests: tabGuests, gate: tabGate }[tab] || tabOverview)(body, data);
  } catch (ex) { fail(ex); }
}

function barRows(rows, label, value, max) {
  return rows.map((r) => h('div', { class: 'bar' }, h('span', {}, r[label]), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${max ? Math.round((value(r) / max) * 100) : 0}%` })), h('span', { class: 'mono' }, String(value(r)))));
}

function tabOverview(body, data) {
  const s = data.stats;
  const feed = h('div', { class: 'scroll-x' });
  const stats = h('div', {});
  function draw(d) {
    const st = d.stats;
    const vmax = Math.max(1, ...st.entry_volume.map((v) => v.n));
    mount(stats,
      h('div', { class: 'grid cols' },
        (data.event.kind === 'workplace'
          ? [['People with access', st.registered], ['Seen at a door', st.checked_in, true], ['Not seen yet', Math.max(0, st.registered - st.checked_in)], ['Refused scans', st.denied]]
          : [['Registered', st.registered], ['Checked in', st.checked_in, true], ['% checked in', (st.registered ? Math.round((st.checked_in / st.registered) * 100) : 0) + '%'], ['Not yet in', Math.max(0, st.registered - st.checked_in)], ['Declined scans', st.denied]]).map(([l, v, dk]) => h('div', { class: 'card stat' + (dk ? ' dk' : '') }, h('b', {}, String(v)), h('span', {}, l)))),
      h('div', { class: 'grid two', style: 'margin-top:14px' },
        h('div', { class: 'card' }, h('h3', {}, data.event.kind === 'workplace' ? 'Entries by door' : 'Entries by area'), barRows(st.by_zone, 'name', (z) => z.granted, Math.max(1, ...st.by_zone.map((z) => z.granted)))),
        h('div', { class: 'card' }, h('h3', {}, data.event.kind === 'workplace' ? 'People by access group' : 'Registered by ticket type'), barRows(st.by_tier, 'name', (t) => t.registered, Math.max(1, ...st.by_tier.map((t) => t.registered))))),
      h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, 'Entries per hour'),
        st.entry_volume.length
          ? h('div', { class: 'bars', role: 'img', 'aria-label': 'Entries per hour' }, st.entry_volume.map((v) => h('i', { title: `${when(v.hour, { hour: 'numeric', weekday: 'short' })}: ${v.n}`, style: `height:${Math.round((v.n / vmax) * 100)}%` })))
          : h('p', { class: 'muted', style: 'margin-top:8px' }, 'No entries yet.')),
      h('p', { class: 'hint', style: 'margin-top:10px' }, `Invites: ${st.invites.unused} unused, ${st.invites.claimed} claimed, ${st.invites.revoked} cancelled.`));
    mount(feed, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'Area', 'Result', 'Scanned by'].map((c) => h('th', {}, c)))),
      h('tbody', {}, d.recent.length ? d.recent.map((r) => h('tr', { class: r.result === 'denied' ? 'denied-row' : '' },
        h('td', {}, ago(r.at)), h('td', {}, r.holder || '—', r.tier && h('div', { class: 'hint' }, r.tier)), h('td', {}, r.zone || ''),
        h('td', {}, r.result === 'granted' ? 'Entered' : (reasons[r.reason] || 'Declined')), h('td', { class: 'hint' }, r.steward || 'Shared key'))) : h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'Nothing scanned yet.')))));
  }
  draw(data);
  body.append(stats, h('h3', { style: 'margin:22px 0 4px' }, 'Live activity ', h('span', { class: 'hint' }, '(updates every 8 seconds)')), feed);
  timer = setInterval(async () => { try { draw(await get('/events/' + data.event.id)); } catch {} }, 8000);
}

function schedText(sc) {
  const d = sc.days;
  const days = d.length === 7 ? 'every day' : d.join() === '0,1,2,3,4' ? 'Mon to Fri' : d.map((i) => DAY_NAMES[i]).join(', ');
  return sc.from === '00:00' && sc.to === '24:00' ? days + ', any time' : `${days}, ${sc.from} to ${sc.to}`;
}

// Add staff, contractors or visitors by phone or email. One per line: "contact, optional name".
async function tabPeople(body, data) {
  const id = data.event.id;
  const group = h('select', { class: 'input', id: 'grp' }, data.tiers.map((t) => h('option', { value: t.id }, `${t.name} (${schedText(t.schedule)})`)));
  const lines = h('textarea', { class: 'input', id: 'ppl', rows: '7', placeholder: 'tolu@company.com, Tolu Adeyemi\n0803 412 7790, Chidi\nngozi@company.com' });
  const until = h('input', { class: 'input', id: 'unt', type: 'datetime-local' });
  const out = h('div', {});
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Give access');
  body.append(h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    const people = lines.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.search(/[,;\t]/); return i < 0 ? { contact: l } : { contact: l.slice(0, i).trim(), name: l.slice(i + 1).trim() || undefined }; });
    try {
      const r = await post(`/events/${id}/people`, { tier_id: group.value, people, access_until: until.value ? new Date(until.value).toISOString() : undefined });
      mount(out, h('div', { class: 'card', style: 'margin-top:14px;border-color:var(--signal)' },
        h('h3', {}, `${r.added.length} ${r.added.length === 1 ? 'person' : 'people'} added to ${r.tier}`),
        h('p', { class: 'muted', style: 'margin-top:6px' }, 'They will see the invite in their Tap In app once they sign in with that phone number or email. Nothing to send.'),
        r.skipped.length > 0 && h('div', { class: 'notice warn', style: 'margin-top:10px' }, h('b', {}, `${r.skipped.length} skipped`), r.skipped.map((s) => h('div', {}, `${s.contact}: ${s.reason}`)))));
      if (r.added.length) lines.value = '';
    } catch (ex) {
      mount(out, h('div', { class: 'error', role: 'alert' }, ex.message));
    }
    btn.disabled = false;
  } },
    h('h3', {}, 'Give people access'),
    h('div', { class: 'field' }, h('label', { for: 'grp' }, 'Access group'), group),
    h('div', { class: 'field' }, h('label', { for: 'ppl' }, 'People (one per line: phone or email, then a name if you like)'), lines),
    h('div', { class: 'field' }, h('label', { for: 'unt' }, 'Access ends (optional, for visitors and contractors)'), until),
    h('p', { class: 'hint' }, 'Up to 200 at a time. Remove someone later from \u201cWho has access\u201d and their pass stops working at once.'),
    h('div', { style: 'margin-top:14px' }, btn)), out);
}

// Ticket types: price, limit and how many are issued; sales window; live QR.
async function tabTickets(body, data) {
  const id = data.event.id;
  const local = (sec) => { if (!sec) return ''; const d = new Date(sec * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const rows = data.tiers.map((t) => {
    const cap = h('input', { class: 'input', style: 'width:110px', inputmode: 'numeric', value: t.capacity ?? '', placeholder: 'No limit', 'aria-label': `Limit for ${t.name}` });
    const price = h('input', { class: 'input', style: 'width:110px', inputmode: 'decimal', value: t.price_kobo ? String(t.price_kobo / 100) : '', placeholder: 'Free', 'aria-label': `Price for ${t.name}` });
    const left = t.capacity === null ? 'No limit' : Math.max(0, t.capacity - t.issued) + ' left';
    return h('tr', {}, h('td', {}, h('strong', {}, t.name)), h('td', {}, price), h('td', {}, cap),
      h('td', {}, t.issued + ' issued', h('div', { class: 'hint' }, left)),
      h('td', {}, h('button', { class: 'btn small primary', type: 'button', onclick: async () => {
        try {
          await patch(`/events/${id}/tiers/${t.id}`, { capacity: cap.value.trim() ? cap.value.trim() : null, price_kobo: price.value.trim() ? Math.round(parseFloat(price.value) * 100) : 0 });
          toast('Saved'); viewEvent(id, 'tickets');
        } catch (ex) { toast(ex.message); }
      } }, 'Save')));
  });
  const start = h('input', { class: 'input', id: 'ts', type: 'datetime-local', value: local(data.event.sales_start) });
  const end = h('input', { class: 'input', id: 'te', type: 'datetime-local', value: local(data.event.sales_end) });
  const secure = h('input', { type: 'checkbox', checked: data.event.secure_qr, onchange: async (e) => {
    try { await patch('/events/' + id, { secure_qr: e.target.checked }); toast('Saved'); } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message); }
  } });
  body.append(
    h('div', { class: 'card' }, h('h3', {}, 'Ticket types'),
      h('p', { class: 'hint', style: 'margin:4px 0 8px' }, 'A limit is the most tickets that can be issued (cancelled invites free their place). Price changes apply to tickets sold from now on.'),
      h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['Type', 'Price (₦)', 'Limit', 'Issued', ''].map((c) => h('th', {}, c)))), h('tbody', {}, rows)))),
    h('div', { class: 'grid two', style: 'margin-top:14px' },
      h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        try { await patch('/events/' + id, { sales_start: start.value ? new Date(start.value).toISOString() : null, sales_end: end.value ? new Date(end.value).toISOString() : null }); toast('Saved'); } catch (ex) { toast(ex.message); }
      } }, h('h3', {}, 'Sales window'),
        h('p', { class: 'hint', style: 'margin:4px 0 8px' }, 'The public page only sells between these times. You can still issue codes yourself outside them.'),
        h('div', { class: 'field' }, h('label', { for: 'ts' }, 'Opens'), start), h('div', { class: 'field' }, h('label', { for: 'te' }, 'Closes'), end),
        h('button', { class: 'btn primary small', style: 'margin-top:12px', type: 'submit' }, 'Save window')),
      h('div', { class: 'card' }, h('h3', {}, 'Live QR'),
        h('p', { class: 'muted', style: 'margin-top:6px' }, 'The pass code changes every 30 seconds, so a screenshot or forwarded picture is useless. Guests need a phone connection at the gate. Printed or screenshotted codes are refused.'),
        h('div', { class: 'checks', style: 'margin-top:10px' }, h('label', {}, secure, 'Use live QR for this event')))));
}

function csvCell(v) { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

async function tabInvites(body, data) {
  const id = data.event.id;
  const tier = h('select', { class: 'input', id: 'tier' }, data.tiers.map((t) => h('option', { value: t.id }, t.name)));
  const count = h('input', { class: 'input', id: 'cnt', type: 'number', min: '1', max: '500', value: '20' });
  const label = h('input', { class: 'input', id: 'lbl', maxlength: '60', placeholder: 'e.g. Sponsors' });
  const bound = h('input', { class: 'input', id: 'bnd', placeholder: 'Optional: only this phone or email can claim it' });
  const out = h('div', {});
  const list = h('div', { class: 'scroll-x', style: 'margin-top:12px' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Generate codes');
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      const n = Number(count.value);
      const r = await post(`/events/${id}/invites`, { tier_id: tier.value, count: bound.value.trim() ? 1 : n, label: label.value, bound_to: bound.value.trim() || undefined });
      const text = r.codes.join('\n');
      mount(out, h('div', { class: 'card', style: 'margin-top:14px;border-color:var(--signal)' },
        h('h3', {}, `${r.codes.length} ${r.tier} code${r.codes.length === 1 ? '' : 's'} created`),
        h('p', { class: 'notice warn' }, 'Download or copy these now. For security we keep only a scrambled version, so we cannot show them again.'),
        h('div', { class: 'codebox', style: 'margin-top:10px', tabindex: '0' }, text),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn small', type: 'button', onclick: () => copy(text, 'Codes copied') }, 'Copy all'),
          h('button', { class: 'btn small primary', type: 'button', onclick: () => download(`${data.event.prefix}-${r.tier.replace(/\W+/g, '-')}-codes.csv`, 'code,ticket_type,label\n' + r.codes.map((c) => [c, r.tier, r.label || ''].map(csvCell).join(',')).join('\n') + '\n') }, 'Download CSV'))));
      loadList();
    } catch (ex) {
      mount(out, h('div', { class: 'error', role: 'alert' }, ex.message));
    }
    btn.disabled = false;
  } },
    h('h3', {}, 'Generate invite codes'),
    h('div', { class: 'grid two' },
      h('div', { class: 'field' }, h('label', { for: 'tier' }, 'Ticket type'), tier),
      h('div', { class: 'field' }, h('label', { for: 'cnt' }, 'How many (up to 500)'), count)),
    h('div', { class: 'grid two' },
      h('div', { class: 'field' }, h('label', { for: 'lbl' }, 'Label (for your records)'), label),
      h('div', { class: 'field' }, h('label', { for: 'bnd' }, 'Tie to one person'), bound)),
    h('p', { class: 'hint', style: 'margin-top:8px' }, 'Tying a code to a phone or email makes one code, and it appears in that person’s app after they sign in.'),
    h('div', { style: 'margin-top:14px' }, btn));
  body.append(form, out, h('h3', { style: 'margin-top:24px' }, 'All codes'), list);

  async function loadList() {
    try {
      const r = await get(`/events/${id}/invites?limit=100`);
      mount(list, h('table', {}, h('thead', {}, h('tr', {}, ['Ends in', 'Type', 'Label', 'Status', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, r.invites.map((i) => h('tr', {},
          h('td', { class: 'mono' }, '…' + i.code_hint), h('td', {}, i.tier), h('td', {}, i.label || (i.bound_identifier ? 'For ' + i.bound_identifier : '')),
          h('td', {}, h('span', { class: 'chip ' + (i.status === 'claimed' ? 'ok' : i.status === 'revoked' ? 'bad' : '') }, i.status === 'claimed' ? 'Claimed by ' + (i.claimed_by || 'someone') : i.status === 'revoked' ? 'Cancelled' : 'Unused')),
          h('td', {}, i.status === 'unused' && h('button', { class: 'btn danger small', type: 'button', onclick: async () => { try { await post(`/events/${id}/invites/${i.id}/revoke`); loadList(); } catch (ex) { toast(ex.message); } } }, 'Cancel')))))));
      if (!r.invites.length) mount(list, h('p', { class: 'muted' }, 'No codes yet.'));
    } catch (ex) { mount(list, h('div', { class: 'error' }, ex.message)); }
  }
  loadList();
}

async function tabAttendees(body, data) {
  const id = data.event.id;
  const box = h('div', { class: 'scroll-x' });
  body.append(box);
  async function load() {
    try {
      const { attendees } = await get(`/events/${id}/attendees`);
      const office = data.event.kind === 'workplace';
      // People added by phone or email who have not signed in yet.
      const pending = office ? (await get(`/events/${id}/invites?status=unused&limit=200`)).invites.filter((i) => i.bound_identifier) : [];
      mount(box,
        h('div', { class: 'row', style: 'margin-bottom:10px' }, h('span', { class: 'chip' }, attendees.length + (office ? ' with access' : ' passes')), pending.length > 0 && h('span', { class: 'chip' }, pending.length + ' invited'),
          attendees.length > 0 && h('button', { class: 'btn small ghost', type: 'button', onclick: () => download('attendees.csv', 'name,contact,ticket_type,status,registered,first_entry\n' + attendees.map((a) => [a.name, a.contact, a.tier, a.status, a.registered_at ? new Date(a.registered_at * 1000).toISOString() : '', a.first_entry ? new Date(a.first_entry * 1000).toISOString() : ''].map(csvCell).join(',')).join('\n') + '\n') }, 'Download CSV')),
        h('table', {}, h('thead', {}, h('tr', {}, [data.event.kind === 'workplace' ? 'Name' : 'Name', 'Contact', data.event.kind === 'workplace' ? 'Group' : 'Ticket', ...(data.event.require_photo ? ['Photo'] : []), data.event.kind === 'workplace' ? 'Last 7 days' : 'Entered', ''].map((c) => h('th', {}, c)))),
          h('tbody', {}, pending.map((i) => h('tr', {},
            h('td', {}, i.label || '—'), h('td', { class: 'mono' }, i.bound_identifier), h('td', {}, i.tier),
            h('td', {}, h('span', { class: 'chip' }, 'Invited, not signed in yet')),
            h('td', {}, h('button', { class: 'btn danger small', type: 'button', onclick: async () => { try { await post(`/events/${id}/invites/${i.id}/revoke`); load(); } catch (ex) { toast(ex.message); } } }, 'Cancel')))),
            attendees.length || pending.length ? attendees.map((a) => h('tr', {},
            h('td', {}, a.name || '—'), h('td', { class: 'mono' }, a.contact || ''), h('td', {}, a.tier, a.expires_at && h('div', { class: 'hint' }, (a.expires_at * 1000 < Date.now() ? 'Expired ' : 'Until ') + when(a.expires_at, { dateStyle: 'medium', timeStyle: 'short' }))),
            ...(data.event.require_photo ? [h('td', {}, a.has_photo ? h('span', { class: 'chip ok' }, 'On file') : h('span', { class: 'chip bad' }, 'Missing'))] : []),
            h('td', {}, a.status === 'revoked' ? h('span', { class: 'chip bad' }, 'Cancelled') : a.first_entry ? h('span', { class: 'chip ok' }, when(a.first_entry, { timeStyle: 'short', dateStyle: 'short' })) : h('span', { class: 'muted' }, 'Not yet')),
            h('td', {}, a.status === 'active' && h('button', { class: 'btn danger small', type: 'button', onclick: async () => { if (!confirm(`Cancel ${a.name || 'this'} pass? They will be refused at the gate.`)) return; try { await post(`/events/${id}/passes/${a.id}/revoke`); load(); } catch (ex) { toast(ex.message); } } }, 'Cancel pass')))) : h('tr', {}, h('td', { colspan: '5', class: 'muted' }, office ? 'Nobody has access yet.' : 'Nobody has added a pass yet.')))));
    } catch (ex) { mount(box, h('div', { class: 'error' }, ex.message)); }
  }
  load();
}

function tabGate(body, data) {
  const id = data.event.id;
  const keyBox = h('div', {});
  const reentry = h('input', { type: 'checkbox', checked: data.event.allow_reentry, onchange: async (e) => {
    try { await patch('/events/' + id, { allow_reentry: e.target.checked }); toast('Saved'); } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message); }
  } });
  const listedOn = h('input', { type: 'checkbox', checked: data.event.listed, onchange: async (e) => {
    try { await patch('/events/' + id, { listed: e.target.checked }); toast('Saved'); } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message); }
  } });
  const selfieOn = h('input', { type: 'checkbox', checked: data.event.require_photo, onchange: async (e) => {
    try { await patch('/events/' + id, { require_photo: e.target.checked }); toast('Saved'); } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message); }
  } });
  body.append(h('div', { class: 'grid two' },
    h('div', { class: 'card' }, h('h3', {}, 'Shared gate key (backup)'),
      h('p', { class: 'muted', style: 'margin-top:6px' }, 'Anyone with this key can scan, and their scans are not linked to a name. Give each person their own scanner link under ', h('a', { href: `#/e/${id}/team` }, data.event.kind === 'workplace' ? 'Door staff' : 'Gate team'), ' instead, and keep this for emergencies. We only keep a scrambled copy, so a lost key is replaced, not recovered. Current key ends in ', h('strong', { class: 'mono' }, data.event.gate_key_hint || '????'), '.'),
      keyBox,
      h('button', { class: 'btn danger', style: 'margin-top:12px', type: 'button', onclick: async () => {
        if (!confirm('Create a new gate key? The old one stops working immediately on every scanner.')) return;
        try { const r = await post(`/events/${id}/gate-key`); mount(keyBox, h('div', { class: 'gatekey', style: 'margin-top:12px' }, r.gate_key), h('button', { class: 'btn ghost small', style: 'margin-top:8px', type: 'button', onclick: () => copy(r.gate_key, 'Gate key copied') }, 'Copy key')); } catch (ex) { toast(ex.message); }
      } }, 'Create a new gate key')),
    h('div', { class: 'card' }, h('h3', {}, data.event.kind === 'workplace' ? 'Hours' : 'Rules'),
      data.event.kind === 'workplace'
        ? h('div', { style: 'margin-top:10px' }, data.tiers.map((t) => h('p', { style: 'margin-bottom:6px' }, h('strong', {}, t.name), ' \u00b7 ', schedText(t.schedule))), h('p', { class: 'hint', style: 'margin-top:8px' }, 'Staff can come and go as often as they like inside these hours (Lagos time).'))
        : h('div', {}, h('div', { class: 'checks', style: 'margin-top:10px' }, h('label', {}, reentry, 'Allow re-entry at the same area'), h('label', {}, listedOn, 'Show on the public Play page')),
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'Off means each pass gets in once per area. Applies to scans from now on.')),
      h('a', { class: 'btn primary', style: 'margin-top:14px', href: '/gate/' }, 'Open gate scanner')),
    h('div', { class: 'card' }, h('h3', {}, 'Selfie check'),
      h('p', { class: 'muted', style: 'margin-top:6px' }, 'People add a selfie when they claim a pass. Door staff see it next to their name on every scan, so they match the face to the person, not just a name. Without it, a pass shared by screenshot looks identical to the real one.'),
      h('div', { class: 'checks', style: 'margin-top:10px' }, h('label', {}, selfieOn, 'Require a selfie and show it at the gate')),
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'Turn it on before people claim. Anyone who already has a pass without a photo shows as "No photo on file" so staff can check ID. Photos are only shown to staff scanning for this event, are never listed or downloadable, and people can delete theirs any time.'))));
}

// ---- Gate team: one scanner link per steward, so every scan is traced to a person ----------------------
async function tabTeam(body, data) {
  const id = data.event.id;
  const office = data.event.kind === 'workplace';
  const who = office ? 'door staff member' : 'steward';
  const name = h('input', { class: 'input', id: 'stn', maxlength: '60', autocomplete: 'off', placeholder: office ? 'e.g. Musa, front desk' : 'e.g. Ada, Gate A' });
  const fresh = h('div', {});
  const list = h('div', { class: 'scroll-x' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Add and get scanner link');

  function drawList(rows) {
    mount(list, rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Status', 'Last seen', 'Let in', 'Refused', ''].map((c) => h('th', {}, c)))),
          h('tbody', {}, rows.map((r) => h('tr', { class: r.revoked_at ? 'muted' : '' },
            h('td', {}, h('strong', {}, r.name), h('div', { class: 'hint mono' }, 'Key ends ' + r.key_hint)),
            h('td', {}, r.revoked_at ? h('span', { class: 'chip' }, 'Removed') : h('span', { class: 'chip ok' }, 'Active')),
            h('td', {}, r.last_seen_at ? ago(r.last_seen_at) : 'Not yet'),
            h('td', { class: 'mono' }, String(r.admits)), h('td', { class: 'mono' }, String(r.refusals)),
            h('td', {}, !r.revoked_at && h('button', { class: 'btn danger small', type: 'button', onclick: async () => {
              if (!confirm(`Remove ${r.name}? Their scanner stops working at the next scan. Their past scans stay in the report.`)) return;
              try { drawList((await post(`/events/${id}/stewards/${r.id}/revoke`, {})).stewards); toast('Removed'); } catch (ex) { toast(ex.message); }
            } }, 'Remove'))))))
      : h('p', { class: 'muted', style: 'margin-top:8px' }, `No ${who}s yet. Add one above.`));
  }

  function showKey(st, key) {
    const link = `${location.origin}/gate/#k=${encodeURIComponent(key)}`;
    const msg = `Your Tap In scanner for ${data.event.name}. Open this on the phone you will scan with: ${link}`;
    mount(fresh, h('div', { class: 'card stkey' },
      h('div', { class: 'qrbox' }, qrSvg(link, 'Scanner link for ' + st.name)),
      h('div', {},
        h('h3', {}, `Scanner link for ${st.name}`),
        h('p', { class: 'muted', style: 'margin-top:6px' }, `${st.name} scans this QR code with the phone they will use at the ${office ? 'door' : 'gate'}, or opens the link. The scanner signs in as them and stays signed in on that phone.`),
        h('div', { class: 'notice warn', style: 'margin-top:10px' }, 'This is shown once. If it is lost, remove them and add them again.'),
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => copy(link, 'Link copied') }, 'Copy link'),
          h('a', { class: 'btn ghost small', href: 'https://wa.me/?text=' + encodeURIComponent(msg), target: '_blank', rel: 'noopener' }, 'Send on WhatsApp'),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => mount(fresh) }, 'Done')))));
  }

  body.append(
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const r = await post(`/events/${id}/stewards`, { name: name.value });
        name.value = '';
        showKey(r.steward, r.key);
        drawList((await get(`/events/${id}/stewards`)).stewards);
      } catch (ex) { mount(fresh, h('div', { class: 'error', role: 'alert' }, ex.message)); }
      btn.disabled = false;
    } },
      h('h3', {}, office ? 'Door staff' : 'Gate team'),
      h('p', { class: 'muted', style: 'margin-top:6px' }, `Give each ${who} their own scanner link. Every scan is then recorded with their name, so the report shows who let in whom, and you can switch off one person without changing everyone else's scanner.`),
      h('div', { class: 'field' }, h('label', { for: 'stn' }, 'Name'), name),
      h('div', { style: 'margin-top:12px' }, btn)),
    fresh,
    h('h3', { style: 'margin:22px 0 4px' }, office ? 'Your door staff' : 'Your gate team'),
    list);
  try { drawList((await get(`/events/${id}/stewards`)).stewards); } catch (ex) { mount(list, h('div', { class: 'error' }, ex.message)); }
}

// ---- Report: entries, speed, refusals, value protected, each steward's lane, and what to look at --------
const GROUPS = [
  ['fake', 'Fake or unreadable codes', 'Codes Tap In never issued.'],
  ['reused', 'Tickets used again', 'A ticket shown after it already got someone in: shared screenshots, tickets passed back out.'],
  ['screenshot', 'Screenshots and old codes', 'A copy of the code instead of the live pass.'],
  ['cancelled', 'Cancelled tickets', 'Tickets you cancelled or refunded.'],
  ['wrong_area', 'Wrong area', 'A real ticket at an area it does not include.'],
  ['timing', 'Wrong time', 'Outside the allowed hours, or after the pass expired.']
];
const naira = (kobo) => '₦' + Math.round(kobo / 100).toLocaleString('en-NG');
const clock = (t) => when(t, { timeStyle: 'short' });

async function tabReport(body, data) {
  const id = data.event.id;
  const office = data.event.kind === 'workplace';
  mount(body, h('p', { class: 'muted' }, 'Building the report…'));
  let r;
  try { r = await get(`/events/${id}/report`); } catch (ex) { return mount(body, h('div', { class: 'error' }, ex.message)); }
  const t = r.totals;
  const gmax = Math.max(1, ...GROUPS.map(([k]) => r.refusals.by_group[k] || 0));
  const smax = Math.max(1, ...r.speed.series.points.map((p) => p.n));
  const bucket = r.speed.series.bucket_secs >= 3600 ? `${r.speed.series.bucket_secs / 3600} hour` : `${r.speed.series.bucket_secs / 60} minutes`;
  const lanes = r.stewards.concat(r.shared_key ? [{ name: 'Shared gate key', shared: true, ...r.shared_key }] : []);

  mount(body, h('div', { class: 'report' },
    h('div', { class: 'spread noprint' },
      h('p', { class: 'hint' }, 'Generated ' + when(r.generated_at) + (t.first_entry ? ` · entries from ${clock(t.first_entry)} to ${clock(t.last_entry)}` : '')),
      h('div', { class: 'row' },
        h('a', { class: 'btn ghost small', href: `/api/events/${id}/scans.csv`, download: '' }, 'Download every scan (CSV)'),
        h('button', { class: 'btn primary small', type: 'button', onclick: () => window.print() }, 'Print or save as PDF'))),
    h('h2', { class: 'printonly' }, data.event.name + ' · Report'),

    h('div', { class: 'grid cols', style: 'margin-top:12px' },
      [[office ? 'People seen' : 'Came in', `${t.came} of ${t.issued}`, `${t.attendance_pct}% ${office ? 'of people with access' : 'of tickets'}`, true],
       ['Refused attempts', String(r.fraud.attempts), 'fake, reused, screenshot or cancelled'],
       ...(office ? [] : [['Value protected', r.fraud.est_value_kobo === null ? '—' : naira(r.fraud.est_value_kobo), r.fraud.est_value_kobo === null ? 'no paid tickets to estimate from' : `estimate: ${r.fraud.value_attempts} attempts × ${naira(r.fraud.avg_ticket_kobo)} average ticket`]]),
       ['Busiest minute', t.admits ? `${r.speed.peak_per_min} / min` : '—', r.speed.peak_at ? 'at ' + clock(r.speed.peak_at) : 'no entries yet']]
        .map(([l, v, sub, dk]) => h('div', { class: 'card stat' + (dk ? ' dk' : '') }, h('b', {}, v), h('span', {}, l), h('small', {}, sub)))),

    r.flags.length > 0 && h('div', { class: 'card flags', style: 'margin-top:14px' }, h('h3', {}, 'Worth a look'),
      h('ul', {}, r.flags.map((f) => h('li', { class: f.level }, f.text))),
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'These are prompts to check, not proof that anyone did anything wrong.')),

    h('div', { class: 'grid two', style: 'margin-top:14px' },
      h('div', { class: 'card' }, h('h3', {}, `What was refused (${t.refusals})`),
        GROUPS.map(([k, label, help]) => h('div', { class: 'bar', title: help }, h('span', {}, label), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${Math.round(((r.refusals.by_group[k] || 0) / gmax) * 100)}%` })), h('span', { class: 'mono' }, String(r.refusals.by_group[k] || 0)))),
        h('p', { class: 'hint', style: 'margin-top:8px' }, 'Counts are attempts, not people: one person may try more than once.')),
      h('div', { class: 'card' }, h('h3', {}, 'Entries over time'),
        r.speed.series.points.length
          ? [h('div', { class: 'bars', role: 'img', 'aria-label': 'Entries over time' }, r.speed.series.points.map((p) => h('i', { title: `${clock(p.t)}: ${p.n}`, style: `height:${Math.round((p.n / smax) * 100)}%` }))),
             h('p', { class: 'hint', style: 'margin-top:6px' }, `Each bar is ${bucket}. ${t.admits} entries${t.reentries ? `, ${t.reentries} of them re-entries` : ''}. Average ${r.speed.avg_per_active_min} a minute while the gate was busy.`)]
          : h('p', { class: 'muted', style: 'margin-top:8px' }, 'No entries yet.'))),

    h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, office ? 'Door staff' : 'Each lane (steward)'),
      lanes.length
        ? h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['Who', 'Let in', 'Refused', 'Refused %', 'Busiest minute', 'Average / busy minute', 'First – last'].map((c) => h('th', {}, c)))),
            h('tbody', {}, lanes.map((l) => h('tr', {},
              h('td', {}, h('strong', {}, l.name), l.removed && h('span', { class: 'hint' }, ' (removed)'), l.shared && h('div', { class: 'hint' }, 'not linked to a person')),
              h('td', { class: 'mono' }, String(l.admits)), h('td', { class: 'mono' }, String(l.refusals)), h('td', { class: 'mono' }, l.refusal_rate + '%'),
              h('td', { class: 'mono' }, l.admits ? l.peak_per_min + ' / min' : '—'), h('td', { class: 'mono' }, l.admits ? String(l.avg_per_active_min) : '—'),
              h('td', { class: 'hint' }, l.first_at ? `${clock(l.first_at)} – ${clock(l.last_at)}` : '—'))))))
        : h('p', { class: 'muted', style: 'margin-top:8px' }, 'No scans yet. Add your gate team so each lane shows up here.')),

    h('div', { class: 'grid two', style: 'margin-top:14px' },
      h('div', { class: 'card' }, h('h3', {}, office ? 'By door' : 'By area'),
        h('table', {}, h('thead', {}, h('tr', {}, ['Area', 'Let in', 'Refused', 'Busiest minute'].map((c) => h('th', {}, c)))),
          h('tbody', {}, r.zones.map((z) => h('tr', {}, h('td', {}, z.name), h('td', { class: 'mono' }, String(z.admits)), h('td', { class: 'mono' }, String(z.refusals)), h('td', { class: 'mono' }, z.admits ? z.peak_per_min + ' / min' : '—')))))),
      h('div', { class: 'card' }, h('h3', {}, office ? 'By access group' : 'By ticket type'),
        h('table', {}, h('thead', {}, h('tr', {}, [office ? 'Group' : 'Ticket', office ? 'People' : 'Issued', office ? 'Seen' : 'Came', '%'].map((c) => h('th', {}, c)))),
          h('tbody', {}, r.tiers.map((x) => h('tr', {}, h('td', {}, x.name), h('td', { class: 'mono' }, String(x.issued)), h('td', { class: 'mono' }, String(x.came)), h('td', { class: 'mono' }, x.pct + '%'))))))),

    r.guest_list && h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, 'Guest list'),
      h('p', { class: 'muted', style: 'margin-top:6px' }, `${r.guest_list.invitations} invitation${r.guest_list.invitations === 1 ? '' : 's'} (${r.guest_list.rsvp_yes} said yes) and ${r.guest_list.imported} imported ticket${r.guest_list.imported === 1 ? '' : 's'}; ${r.guest_list.arrived} arrived. They are included in the numbers above.`)),
    h('p', { class: 'hint', style: 'margin-top:14px' },
      office ? '' : 'Value protected is an estimate: refused fake, reused and screenshot attempts multiplied by the average paid ticket price. ',
      `No-shows: ${t.no_shows}. Cancelled ${office ? 'passes' : 'tickets'}: ${t.cancelled}.`,
      r.truncated ? ' This event has more scans than the report reads at once; the CSV has them all up to the same limit.' : '')));
}

// ---- Guest list: invitations (no account, RSVP, plus-ones) and tickets imported from another platform ----
// A small CSV reader: quoted fields, commas, semicolons or tabs.
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}
// Find the code, name and ticket-type columns from a header row; without one, assume code, name, type.
function importRows(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((x) => x.toLowerCase());
  const find = (words) => head.findIndex((x) => words.some((w) => x.includes(w)));
  let code = find(['code', 'barcode', 'ticket id', 'ticket number', 'ticket no', 'reference', 'ref']);
  const hasHeader = code >= 0 || find(['name']) >= 0;
  if (!hasHeader) return rows.map((r) => ({ code: r[0], name: r[1], tier: r[2] }));
  const name = find(['full name', 'attendee', 'name', 'buyer', 'guest']);
  const first = head.indexOf('first name'), last = head.indexOf('last name');
  const tier = find(['ticket type', 'ticket class', 'tier', 'category', 'type']);
  if (code < 0) code = 0;
  return rows.slice(1).map((r) => ({
    code: r[code],
    name: first >= 0 ? [r[first], r[last]].filter(Boolean).join(' ') : name >= 0 ? r[name] : '',
    tier: tier >= 0 && tier !== code ? r[tier] : ''
  }));
}
const waNumber = (contact) => (contact && contact.startsWith('+') ? contact.slice(1) : '');

async function tabGuests(body, data) {
  const id = data.event.id;
  const tierSelect = (sel) => h('select', { class: 'input' }, data.tiers.map((t) => h('option', { value: t.id, selected: t.id === sel }, t.name)));
  const summary = h('div', {});
  const listBox = h('div', {});
  let all = [];
  let filter = 'all';
  let search = '';
  const invMsg = (ev, g) => `You're invited to ${data.event.name}${data.event.starts_at ? ' on ' + when(data.event.starts_at, { dateStyle: 'full' }) : ''}. Open your invitation, let us know if you're coming, and show your code at the door: ${g.link}`;

  async function load() {
    const r = await get(`/events/${id}/guests`);
    all = r.guests;
    const s = r.summary;
    mount(summary, h('div', { class: 'grid cols' },
      [['Invitations', `${s.invitations}`, `${s.invited_people} ${s.invited_people === 1 ? 'person' : 'people'}`, true],
       ['Coming', `${s.yes}`, `${s.yes_people} ${s.yes_people === 1 ? 'person' : 'people'}`],
       ['Can’t come', `${s.no}`, ''],
       ['No reply yet', `${s.pending}`, ''],
       ['Imported tickets', `${s.imported}`, 'from other platforms'],
       ['Arrived', `${s.arrived}`, 'scanned in']].map(([l, v, sub, dk]) => h('div', { class: 'card stat' + (dk ? ' dk' : '') }, h('b', {}, v), h('span', {}, l), sub && h('small', {}, sub)))));
    drawList();
  }

  function drawList() {
    const q = search.trim().toLowerCase();
    const rows = all.filter((g) => {
      if (filter === 'invite' && g.kind !== 'invite') return false;
      if (filter === 'import' && g.kind !== 'import') return false;
      if (filter === 'yes' && g.rsvp !== 'yes') return false;
      if (filter === 'pending' && !(g.kind === 'invite' && g.rsvp === 'pending')) return false;
      if (filter === 'arrived' && !g.entered_at) return false;
      return !q || g.name.toLowerCase().includes(q) || (g.table_label || '').toLowerCase().includes(q) || (g.code_hint || '').toLowerCase().includes(q);
    });
    const tabs = [['all', 'All'], ['invite', 'Invitations'], ['yes', 'Coming'], ['pending', 'No reply'], ['import', 'Imported'], ['arrived', 'Arrived']];
    mount(listBox,
      h('div', { class: 'spread', style: 'margin-top:22px;gap:10px;flex-wrap:wrap' },
        h('div', { class: 'row' }, tabs.map(([k, l]) => h('button', { class: 'btn small ' + (filter === k ? 'primary' : 'ghost'), type: 'button', onclick: () => { filter = k; drawList(); } }, l))),
        h('input', { class: 'input', style: 'max-width:240px', type: 'search', placeholder: 'Search name, table or code', value: search, 'aria-label': 'Search guests', oninput: (e) => { search = e.target.value; const pos = e.target.selectionStart; drawList(); const el = listBox.querySelector('input[type=search]'); el.focus(); el.setSelectionRange(pos, pos); } })),
      rows.length
        ? h('div', { class: 'scroll-x', style: 'margin-top:10px' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Guest', 'Party', 'Table', 'Reply', 'Arrived', ''].map((c) => h('th', {}, c)))),
            h('tbody', {}, rows.slice(0, 1000).map((g) => h('tr', { class: g.status === 'revoked' ? 'muted' : '' },
              h('td', {}, h('strong', {}, g.name), h('div', { class: 'hint' }, g.kind === 'import' ? `Imported ticket · code ends ${g.code_hint} · ${g.tier}` : `${g.tier}${g.contact ? ' · ' + g.contact : ''}`)),
              h('td', { class: 'mono' }, g.kind === 'invite' && g.rsvp === 'yes' && g.attending ? `${g.attending} of ${g.party_size}` : String(g.party_size)),
              h('td', {}, g.table_label || ''),
              h('td', {}, g.status === 'revoked' ? h('span', { class: 'chip' }, 'Cancelled') : g.kind === 'import' ? '' : g.rsvp === 'yes' ? h('span', { class: 'chip ok' }, 'Coming') : g.rsvp === 'no' ? h('span', { class: 'chip bad' }, 'Not coming') : h('span', { class: 'chip' }, 'No reply')),
              h('td', {}, g.entered_at ? clock(g.entered_at) : ''),
              h('td', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' },
                g.status === 'active' && g.link && h('button', { class: 'btn ghost small', type: 'button', onclick: () => copy(g.link, 'Invitation link copied') }, 'Copy link'),
                g.status === 'active' && g.link && h('a', { class: 'btn ghost small', target: '_blank', rel: 'noopener', href: `https://wa.me/${waNumber(g.contact)}?text=${encodeURIComponent(invMsg(null, g))}` }, 'WhatsApp'),
                g.status === 'active' && h('button', { class: 'btn danger small', type: 'button', onclick: async () => {
                  if (!confirm(`Cancel ${g.name}'s ${g.kind === 'invite' ? 'invitation' : 'ticket'}? Their code stops working at the door.`)) return;
                  try { await post(`/events/${id}/guests/${g.id}/revoke`, {}); toast('Cancelled'); load(); } catch (ex) { toast(ex.message); }
                } }, 'Cancel')))))),
            rows.length > 1000 && h('p', { class: 'hint' }, `Showing the first 1,000 of ${rows.length}. Search to narrow it down.`))
        : h('p', { class: 'muted', style: 'margin-top:12px' }, all.length ? 'Nobody matches.' : 'No guests yet. Invite people above, or import a list.'),
      all.some((g) => g.kind === 'invite' && g.status === 'active') && h('button', { class: 'btn ghost small', style: 'margin-top:10px', type: 'button', onclick: () => {
        const lines = [['Name', 'Phone or email', 'Party size', 'Table', 'Reply', 'Invitation link'].join(',')]
          .concat(all.filter((g) => g.kind === 'invite' && g.status === 'active').map((g) => [g.name, g.contact, g.party_size, g.table_label, g.rsvp, g.link].map(csvCell).join(',')));
        download(`${data.event.name.replace(/[^\w]+/g, '-').toLowerCase()}-invitations.csv`, lines.join('\r\n') + '\r\n');
      } }, 'Download invitation links (CSV)'));
  }

  // Invite guests
  const invTier = tierSelect(data.tiers[0] && data.tiers[0].id);
  const invLines = h('textarea', { class: 'input', rows: '6', id: 'gl', placeholder: 'Adaeze Okafor, 0803 412 7790, 3, Table 4\nBayo Ade, bayo@example.com\nAunty Nkechi, , 2' });
  const invOut = h('div', {});
  const invBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Create invitations');
  // Import a list
  const impTier = tierSelect(data.tiers[0] && data.tiers[0].id);
  const impText = h('textarea', { class: 'input', rows: '5', id: 'il', placeholder: 'Ticket code, Name, Ticket type\nTIX-88812-AB, Chidi Nwosu, VIP\nTIX-99001-CD, Ngozi Eze, Regular' });
  const impFile = h('input', { type: 'file', accept: '.csv,.txt,text/csv', class: 'input', 'aria-label': 'CSV file to import' });
  impFile.onchange = async () => { const f = impFile.files && impFile.files[0]; if (f) impText.value = await f.text(); };
  const impOut = h('div', {});
  const impBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Import list');

  body.append(summary,
    h('div', { class: 'grid two', style: 'margin-top:14px' },
      h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        const guests = invLines.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const [name, contact, party, table] = l.split(/[,;\t]/).map((x) => x.trim());
          return { name, contact: contact || undefined, party_size: party || undefined, table: table || undefined };
        });
        if (!guests.length) return mount(invOut, h('div', { class: 'error' }, 'Add at least one guest, one per line.'));
        invBtn.disabled = true;
        try {
          const r = await post(`/events/${id}/guests`, { tier_id: invTier.value, guests });
          mount(invOut, h('div', { class: 'notice', style: 'margin-top:12px' }, `${r.added.length} invitation${r.added.length === 1 ? '' : 's'} created. Send each guest their link from the list below (Copy link or WhatsApp).`,
            r.skipped.length > 0 && h('div', { style: 'margin-top:6px' }, h('b', {}, `${r.skipped.length} skipped: `), r.skipped.map((x) => `line ${x.line}${x.name ? ' (' + x.name + ')' : ''}: ${x.reason}`).join('; '))));
          if (r.added.length) invLines.value = '';
          await load();
        } catch (ex) { mount(invOut, h('div', { class: 'error', role: 'alert' }, ex.message)); }
        invBtn.disabled = false;
      } },
        h('h3', {}, 'Invite guests'),
        h('p', { class: 'muted', style: 'margin-top:4px' }, 'For weddings, parties and launches. Each guest gets a link: no app or account. They tell you if they are coming and how many, and show the code on that page at the door. One scan lets their whole party in.'),
        h('div', { class: 'field' }, h('label', {}, 'Guests get'), invTier),
        h('div', { class: 'field' }, h('label', { for: 'gl' }, 'One guest per line: name, phone or email (optional), party size (optional), table (optional)'), invLines),
        h('div', { style: 'margin-top:12px' }, invBtn), invOut),
      h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        const rows = importRows(impText.value).filter((r) => r.code);
        if (!rows.length) return mount(impOut, h('div', { class: 'error' }, 'No ticket codes found. Paste the list or choose a CSV file.'));
        impBtn.disabled = true;
        let imported = 0; const skipped = [];
        try {
          for (let i = 0; i < rows.length; i += 1000) {
            mount(impOut, h('p', { class: 'hint', style: 'margin-top:10px' }, `Importing ${Math.min(i + 1000, rows.length)} of ${rows.length}…`));
            const r = await post(`/events/${id}/guests/import`, { tier_id: impTier.value, rows: rows.slice(i, i + 1000) });
            imported += r.imported;
            skipped.push(...r.skipped.map((x) => ({ ...x, line: x.line + i })));
          }
          mount(impOut, h('div', { class: 'notice', style: 'margin-top:12px' }, `${imported} ticket${imported === 1 ? '' : 's'} imported. The gate scanner now accepts their codes.`,
            skipped.length > 0 && h('div', { style: 'margin-top:6px' }, h('b', {}, `${skipped.length} skipped: `), skipped.slice(0, 20).map((x) => `row ${x.line}: ${x.reason}`).join('; '), skipped.length > 20 ? '…' : '')));
          if (imported) { impText.value = ''; impFile.value = ''; }
          await load();
        } catch (ex) { mount(impOut, h('div', { class: 'error', role: 'alert' }, ex.message)); }
        impBtn.disabled = false;
      } },
        h('h3', {}, 'Import tickets sold elsewhere'),
        h('p', { class: 'muted', style: 'margin-top:4px' }, 'Selling on another platform, Instagram or by bank transfer? Export the buyer list and import it here. The gate scanner then checks those printed codes like Tap In tickets: each works once per area, fakes are refused, and every scan is in your report.'),
        h('div', { class: 'field' }, h('label', {}, 'Ticket type when the list does not say'), impTier),
        h('div', { class: 'field' }, h('label', {}, 'CSV file'), impFile),
        h('div', { class: 'field' }, h('label', { for: 'il' }, 'Or paste the list (a header row with "code", "name" and "ticket type" helps)'), impText),
        h('p', { class: 'hint' }, 'Codes are stored scrambled. A ticket type in the list that matches one of yours by name is used; otherwise the one chosen above.'),
        h('div', { style: 'margin-top:12px' }, impBtn), impOut)),
    listBox);
  try { await load(); } catch (ex) { mount(summary, h('div', { class: 'error' }, ex.message)); }
}

boot();
