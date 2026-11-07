// Console screens added for Tap In for Business (departments, on site now, incidents, team access) and the
// Developers page (API keys and webhook addresses). Kept apart from organiser.js, which is already very large.
import { h, mount, toast, when, ago, copy } from '/js/dom.js';
import { get, post, patch, del } from '/js/api.js';
import { mfaVerify } from '/js/mfa-ui.js';

const clock = (sec) => (sec ? new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const fail = (box, ex) => mount(box, h('div', { class: 'error', role: 'alert' }, ex.message || String(ex)));
const canAct = (data) => data.role === 'owner' || data.role === 'security';

// ---- Departments: create them, and give each person a department and employee ID (owner) ---------------
export async function tabDepartments(body, data) {
  const id = data.event.id;
  const box = h('div', {});
  body.append(box);
  async function load() {
    let deps, people;
    try { [deps, people] = await Promise.all([get(`/events/${id}/departments`).then((r) => r.departments), get(`/events/${id}/attendees`).then((r) => r.attendees.filter((a) => a.status === 'active'))]); } catch (ex) { return fail(box, ex); }
    const name = h('input', { class: 'input', placeholder: 'e.g. Engineering', maxlength: '50', 'aria-label': 'New department name' });
    mount(box,
      h('div', { class: 'card' }, h('h3', {}, 'Departments'),
        h('p', { class: 'hint', style: 'margin:4px 0 10px' }, 'Use departments to compare attendance between teams. People can be added to a department when you give them access, or below.'),
        deps.length ? h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['Department', 'People', ''].map((c) => h('th', {}, c)))),
          h('tbody', {}, deps.map((d) => h('tr', {}, h('td', {}, h('strong', {}, d.name)), h('td', { class: 'mono' }, String(d.people)),
            h('td', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' },
              h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { const n = prompt('New name for this department', d.name); if (!n || n === d.name) return; try { await patch(`/events/${id}/departments/${d.id}`, { name: n }); load(); } catch (ex) { toast(ex.message); } } }, 'Rename'),
              h('button', { class: 'btn danger small', type: 'button', onclick: async () => { if (!confirm(`Delete ${d.name}? Its ${d.people} people stay, with no department.`)) return; try { await del(`/events/${id}/departments/${d.id}`); load(); } catch (ex) { toast(ex.message); } } }, 'Delete'))))))) : h('p', { class: 'muted' }, 'No departments yet.'),
        h('form', { class: 'row', style: 'gap:8px;margin-top:12px', onsubmit: async (e) => { e.preventDefault(); try { await post(`/events/${id}/departments`, { name: name.value }); load(); } catch (ex) { toast(ex.message); } } },
          name, h('button', { class: 'btn primary small', type: 'submit' }, 'Add department'))),
      h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, 'People'),
        people.length ? h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Department', 'Employee ID'].map((c) => h('th', {}, c)))),
          h('tbody', {}, people.map((p) => {
            const sel = h('select', { class: 'input', 'aria-label': `Department for ${p.name || 'this person'}`, onchange: async (e) => { try { await post(`/events/${id}/people/profile`, { pass_id: p.id, department_id: e.target.value || null }); toast('Saved'); } catch (ex) { toast(ex.message); load(); } } },
              h('option', { value: '' }, 'No department'), deps.map((d) => h('option', { value: d.id, selected: d.id === p.department_id }, d.name)));
            const ref = h('input', { class: 'input', value: p.employee_ref || '', maxlength: '40', style: 'width:130px', 'aria-label': `Employee ID for ${p.name || 'this person'}`, onchange: async (e) => { try { await post(`/events/${id}/people/profile`, { pass_id: p.id, employee_ref: e.target.value.trim() || null }); toast('Saved'); } catch (ex) { toast(ex.message); } } });
            return h('tr', {}, h('td', {}, h('strong', {}, p.name || '—'), h('div', { class: 'hint' }, p.contact || '')), h('td', {}, sel), h('td', {}, ref));
          })))) : h('p', { class: 'muted' }, 'Nobody has set up their pass yet. People appear here once they have.')));
  }
  load();
}

// ---- Who has access (read-only), for team members ---------------------------------------------------------
export async function tabPeopleReadOnly(body, data) {
  const box = h('div', { class: 'card scroll-x' });
  body.append(box);
  try {
    const { attendees } = await get(`/events/${data.event.id}/attendees`);
    mount(box, h('h3', {}, `Who has access (${attendees.filter((a) => a.status === 'active').length})`),
      h('table', { style: 'margin-top:8px' }, h('thead', {}, h('tr', {}, ['Name', 'Department', 'Group', 'First entry', 'Access'].map((c) => h('th', {}, c)))),
        h('tbody', {}, attendees.map((a) => h('tr', { class: a.status === 'active' ? '' : 'muted' }, h('td', {}, h('strong', {}, a.name || '—'), a.employee_ref && h('div', { class: 'hint' }, a.employee_ref)),
          h('td', {}, a.department || '—'), h('td', {}, a.tier), h('td', { class: 'hint' }, a.first_entry ? when(a.first_entry, { dateStyle: 'short', timeStyle: 'short' }) : '—'), h('td', {}, a.status === 'active' ? 'Yes' : 'Removed'))))));
  } catch (ex) { fail(box, ex); }
}

// ---- On site now: the emergency list (owner and security) ------------------------------------------------------
export async function tabOnSite(body, data) {
  const id = data.event.id;
  const box = h('div', {});
  body.append(h('div', { class: 'noprint row', style: 'margin-bottom:10px' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => window.print() }, 'Print this list'), h('button', { class: 'btn ghost small', type: 'button', onclick: load }, 'Refresh')), h('h2', { class: 'printonly' }, data.event.name + ' · On site'), box);
  async function load() {
    let r;
    try { r = await get(`/events/${id}/on-site`); } catch (ex) { return fail(box, ex); }
    mount(box,
      h('div', { class: 'notice warn' }, r.note),
      h('p', { class: 'hint', style: 'margin-top:6px' }, 'As at ' + when(r.generated_at, { dateStyle: 'medium', timeStyle: 'medium' })),
      h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, `Visitors on site (${r.visitors.length})`),
        r.visitors.length ? h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['Visitor', 'Visiting', 'Came in', 'Phone', ''].map((c) => h('th', {}, c)))),
          h('tbody', {}, r.visitors.map((v) => h('tr', {}, h('td', {}, h('strong', {}, v.name), v.purpose && h('div', { class: 'hint' }, v.purpose)), h('td', {}, v.host || '—'), h('td', {}, clock(v.arrived_at)), h('td', { class: 'mono' }, v.contact || ''),
            h('td', { class: 'noprint' }, h('button', { class: 'btn small primary', type: 'button', onclick: async () => { try { await post(`/events/${id}/visitors/${v.id}/checkout`); toast(v.name + ' checked out'); load(); } catch (ex) { toast(ex.message); } } }, 'Check out')))))))
          : h('p', { class: 'muted', style: 'margin-top:6px' }, 'No visitors are checked in.')),
      h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, `Staff scanned in today (${r.staff.length})`),
        r.staff.length ? h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Department', 'First in', 'Last seen', 'Phone or email'].map((c) => h('th', {}, c)))),
          h('tbody', {}, r.staff.map((s) => h('tr', {}, h('td', {}, h('strong', {}, s.name || '—'), s.employee_ref && h('div', { class: 'hint' }, s.employee_ref)), h('td', {}, s.department || '—'), h('td', {}, clock(s.first_in)), h('td', {}, clock(s.last_seen)), h('td', { class: 'mono' }, s.contact || '')))))) : h('p', { class: 'muted', style: 'margin-top:6px' }, 'Nobody has scanned in today.')));
  }
  load();
}

// ---- Incidents -----------------------------------------------------------------------------------------------------
const KIND = { security: 'Security', access: 'Access problem', safety: 'Safety', other: 'Other' };
export async function tabIncidents(body, data) {
  const id = data.event.id;
  const act = canAct(data);
  const box = h('div', {});
  const kind = h('select', { class: 'input', 'aria-label': 'Type' }, Object.entries(KIND).map(([k, l]) => h('option', { value: k }, l)));
  const summary = h('input', { class: 'input', maxlength: '140', required: true, placeholder: 'What happened, in one line', 'aria-label': 'Summary' });
  const details = h('textarea', { class: 'input', rows: '3', maxlength: '2000', placeholder: 'Details (optional): who, where, what was done', 'aria-label': 'Details' });
  const csv = h('a', { class: 'btn ghost small', href: `/api/events/${id}/incidents.csv?area=console`, download: '' }, 'Download CSV');
  async function load() {
    let rows;
    try { rows = (await get(`/events/${id}/incidents`)).incidents; } catch (ex) { return fail(box, ex); }
    mount(box, h('div', { class: 'card' }, h('div', { class: 'spread' }, h('h3', {}, `Incidents (${rows.length})`), csv),
      rows.length ? h('div', { class: 'scroll-x' }, h('table', { style: 'margin-top:8px' }, h('thead', {}, h('tr', {}, ['When', 'Type', 'What happened', 'Reported by', 'Status', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, rows.map((r) => h('tr', { class: r.status === 'open' ? '' : 'muted' }, h('td', { class: 'hint' }, ago(r.created_at)), h('td', {}, KIND[r.kind] || r.kind),
          h('td', {}, h('strong', {}, r.summary), r.details && h('div', { class: 'hint' }, r.details), r.resolution && h('div', { class: 'hint' }, 'Resolved: ' + r.resolution)),
          h('td', { class: 'hint' }, r.reported_by), h('td', {}, r.status === 'open' ? h('span', { class: 'chip bad' }, 'Open') : h('span', { class: 'chip ok' }, 'Resolved')),
          h('td', {}, act && r.status === 'open' && h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { const note = prompt('What was done? (optional)') ; if (note === null) return; try { await post(`/events/${id}/incidents/${r.id}/resolve`, note ? { resolution: note } : {}); load(); } catch (ex) { toast(ex.message); } } }, 'Mark resolved'))))))) : h('p', { class: 'muted', style: 'margin-top:6px' }, 'Nothing logged.')));
  }
  if (act) body.append(h('form', { class: 'card', style: 'margin-bottom:14px', onsubmit: async (e) => { e.preventDefault(); try { await post(`/events/${id}/incidents`, { kind: kind.value, summary: summary.value, details: details.value || undefined }); summary.value = ''; details.value = ''; toast('Logged'); load(); } catch (ex) { toast(ex.message); } } },
    h('h3', {}, 'Log an incident'), h('div', { class: 'grid two', style: 'margin-top:6px' }, h('div', { class: 'field' }, h('label', {}, 'Type'), kind), h('div', { class: 'field' }, h('label', {}, 'Summary'), summary)),
    h('div', { class: 'field' }, h('label', {}, 'Details'), details), h('button', { class: 'btn primary small', type: 'submit' }, 'Log it')));
  body.append(box);
  load();
}

// ---- Team access (owner) ------------------------------------------------------------------------------------------
const ROLE_TEXT = { viewer: 'Viewer: can read attendance, visitors and who has access', security: 'Security: a viewer who can also log incidents, check visitors out and see who is on site' };
export async function tabTeamAccess(body, data) {
  const id = data.event.id;
  const box = h('div', {});
  body.append(box);
  async function load() {
    let members;
    try { members = (await get(`/events/${id}/members`)).members; } catch (ex) { return fail(box, ex); }
    const who = h('input', { class: 'input', placeholder: 'Their email or phone', 'aria-label': 'Email or phone', required: true });
    const role = h('select', { class: 'input', 'aria-label': 'Role' }, Object.entries(ROLE_TEXT).map(([k, l]) => h('option', { value: k }, l)));
    mount(box, h('div', { class: 'card' }, h('h3', {}, 'Team access'),
      h('p', { class: 'hint', style: 'margin:4px 0 10px' }, 'You own this office and can do everything. Add colleagues here so they can see what they need without being able to change anything else. They sign in to the Business console with this email or phone.'),
      members.length ? h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['Person', 'Role', 'Added by', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, members.map((m) => h('tr', {}, h('td', { class: 'mono' }, m.identifier), h('td', {}, m.role === 'security' ? 'Security' : 'Viewer'), h('td', { class: 'hint' }, m.added_by),
          h('td', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' },
            h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { try { await post(`/events/${id}/members`, { identifier: m.identifier, role: m.role === 'security' ? 'viewer' : 'security' }); load(); } catch (ex) { toast(ex.message); } } }, m.role === 'security' ? 'Make viewer' : 'Make security'),
            h('button', { class: 'btn danger small', type: 'button', onclick: async () => { if (!confirm(`Remove ${m.identifier}? They lose access at once.`)) return; try { await post(`/events/${id}/members/${m.id}/remove`); load(); } catch (ex) { toast(ex.message); } } }, 'Remove'))))))) : h('p', { class: 'muted' }, 'Nobody else has access yet.'),
      h('form', { class: 'grid two', style: 'margin-top:14px', onsubmit: async (e) => { e.preventDefault(); try { await post(`/events/${id}/members`, { identifier: who.value, role: role.value }); who.value = ''; toast('Added'); load(); } catch (ex) { toast(ex.message); } } },
        h('div', { class: 'field' }, h('label', {}, 'Add someone'), who), h('div', { class: 'field' }, h('label', {}, 'What they can do'), role),
        h('div', {}, h('button', { class: 'btn primary small', type: 'submit' }, 'Add')))));
  }
  load();
}

// ---- Developers: API keys and webhook addresses (the signed-in account, not one event) ------------------------------
const SCOPE_TEXT = { 'events:read': 'Read your events', 'events:write': 'Create events', 'attendance:read': 'Read attendees and entries', 'payments:read': 'Read orders and payment status' };
export function developersPage(container) {
  const gate = h('div', {});
  const keysBox = h('div', { class: 'card' });
  const hooksBox = h('div', { class: 'card', style: 'margin-top:14px' });
  const withMfa = async (fn) => {
    try { await fn(); } catch (ex) {
      if (ex.code === 'mfa_required') { const c = h('div', { class: 'card', style: 'margin-bottom:14px' }); mount(gate, c); mfaVerify(c, { title: 'Confirm it is you', onDone: () => { mount(gate); withMfa(fn); } }); return; }
      toast(ex.message);
    }
  };
  const once = (title, value, extra) => h('div', { class: 'notice', style: 'margin-top:12px' }, h('b', {}, title), h('p', { class: 'hint', style: 'margin:4px 0' }, 'Copy it now. It is shown only once and cannot be looked up later.'),
    h('div', { class: 'gatekey', style: 'margin:8px 0;word-break:break-all' }, value), h('button', { class: 'btn ghost small', type: 'button', onclick: () => copy(value, 'Copied') }, 'Copy'), extra);

  async function loadKeys(fresh = null) {
    let keys;
    try { keys = (await get('/me/api-keys')).keys; } catch (ex) { return fail(keysBox, ex); }
    const name = h('input', { class: 'input', placeholder: 'e.g. Box office system', maxlength: '40', 'aria-label': 'Key name' });
    const mode = h('select', { class: 'input', 'aria-label': 'Mode' }, h('option', { value: 'sandbox' }, 'Sandbox (testing, no real events)'), h('option', { value: 'live' }, 'Live (your real events)'));
    const boxes = Object.entries(SCOPE_TEXT).map(([k, l]) => ({ k, el: h('input', { type: 'checkbox', checked: k.endsWith(':read') }), l }));
    mount(keysBox, h('h3', {}, 'API keys'),
      h('p', { class: 'hint', style: 'margin:4px 0 10px' }, 'Let your own systems read your events, attendance and payments. Try it: ', h('code', {}, 'curl -H "Authorization: Bearer YOUR_KEY" https://www.tap-in.world/api/v1/ping')),
      fresh && once('Your new key', fresh),
      keys.length ? h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Mode', 'Can', 'Key', 'Last used', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, keys.map((k) => h('tr', { class: k.status === 'active' ? '' : 'muted' }, h('td', {}, h('strong', {}, k.name)), h('td', {}, k.mode === 'live' ? 'Live' : 'Sandbox'), h('td', { class: 'hint' }, k.scopes.join(', ')), h('td', { class: 'mono' }, k.key_hint),
          h('td', { class: 'hint' }, k.last_used_at ? ago(k.last_used_at) : 'Never'),
          h('td', {}, k.status === 'active' ? h('button', { class: 'btn danger small', type: 'button', onclick: async () => { if (!confirm(`Revoke "${k.name}"? Anything using it stops working at once.`)) return; try { await post(`/me/api-keys/${k.id}/revoke`); loadKeys(); } catch (ex) { toast(ex.message); } } }, 'Revoke') : h('span', { class: 'hint' }, 'Revoked'))))))) : h('p', { class: 'muted' }, 'No keys yet.'),
      h('form', { style: 'margin-top:14px', onsubmit: (e) => { e.preventDefault(); withMfa(async () => { const r = await post('/me/api-keys', { name: name.value, mode: mode.value, scopes: boxes.filter((b) => b.el.checked).map((b) => b.k) }); name.value = ''; loadKeys(r.secret); }); } },
        h('h4', {}, 'Create a key'), h('div', { class: 'grid two', style: 'margin-top:6px' }, h('div', { class: 'field' }, h('label', {}, 'Name'), name), h('div', { class: 'field' }, h('label', {}, 'Mode'), mode)),
        h('div', { class: 'field' }, h('label', {}, 'What it can do'), boxes.map((b) => h('label', { class: 'row', style: 'gap:8px;margin-top:4px' }, b.el, b.l))),
        h('button', { class: 'btn primary small', type: 'submit' }, 'Create key')));
  }

  async function loadHooks(fresh = null) {
    let eps, types;
    try { const r = await get('/me/webhook-endpoints'); eps = r.endpoints; types = r.event_types; } catch (ex) { return fail(hooksBox, ex); }
    const url = h('input', { class: 'input', placeholder: 'https://your-server.example.com/tapin', 'aria-label': 'Webhook address', type: 'url' });
    const mode = h('select', { class: 'input', 'aria-label': 'Mode' }, h('option', { value: 'sandbox' }, 'Sandbox events'), h('option', { value: 'live' }, 'Live events'));
    const picks = types.map((t) => ({ t, el: h('input', { type: 'checkbox', checked: true }) }));
    mount(hooksBox, h('h3', {}, 'Webhook addresses'),
      h('p', { class: 'hint', style: 'margin:4px 0 10px' }, 'We call this address when an order is paid, refunded or disputed. Each call is signed so you can check it came from Tap In. No buyer contact details are sent.'),
      fresh && once('Signing secret', fresh),
      eps.length ? h('div', { class: 'scroll-x' }, h('table', {}, h('thead', {}, h('tr', {}, ['Address', 'Mode', 'Sends', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, eps.map((e) => h('tr', { class: e.status === 'active' ? '' : 'muted' }, h('td', { class: 'mono', style: 'word-break:break-all' }, e.url), h('td', {}, e.mode === 'live' ? 'Live' : 'Sandbox'), h('td', { class: 'hint' }, e.event_types.includes('*') ? 'Everything' : e.event_types.join(', ')),
          h('td', {}, e.status === 'active' ? h('button', { class: 'btn danger small', type: 'button', onclick: async () => { if (!confirm('Stop sending to this address?')) return; try { await post(`/me/webhook-endpoints/${e.id}/revoke`); loadHooks(); } catch (ex) { toast(ex.message); } } }, 'Remove') : h('span', { class: 'hint' }, 'Removed'))))))) : h('p', { class: 'muted' }, 'No addresses yet.'),
      h('form', { style: 'margin-top:14px', onsubmit: async (e) => { e.preventDefault(); try { const chosen = picks.filter((p) => p.el.checked).map((p) => p.t); const r = await post('/me/webhook-endpoints', { url: url.value, mode: mode.value, event_types: chosen.length === picks.length ? [] : chosen }); url.value = ''; loadHooks(r.signing_secret); } catch (ex) { toast(ex.message); } } },
        h('h4', {}, 'Add an address'), h('div', { class: 'grid two', style: 'margin-top:6px' }, h('div', { class: 'field' }, h('label', {}, 'Address (https only)'), url), h('div', { class: 'field' }, h('label', {}, 'Mode'), mode)),
        h('div', { class: 'field' }, h('label', {}, 'Send me'), picks.map((p) => h('label', { class: 'row', style: 'gap:8px;margin-top:4px' }, p.el, p.t))),
        h('button', { class: 'btn primary small', type: 'submit' }, 'Add address')));
  }
  mount(container, gate, keysBox, hooksBox);
  loadKeys(); loadHooks();
}
