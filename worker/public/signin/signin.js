// Landing page for the emailed sign-in link. Trades the one-time code in the URL for a session.
import { h, mount } from '/js/dom.js';
import { patch, post } from '/js/api.js';

const root = document.getElementById('root');
const oobCode = new URLSearchParams(location.search).get('oobCode');
let saved = {};
try { saved = JSON.parse(localStorage.getItem('tapin-signin') || '{}'); } catch {}

const back = () => (typeof saved.ret === 'string' && /^\/(app|organiser)\/$/.test(saved.ret) ? saved.ret : '/app/');
const fail = (msg) => mount(root, h('h2', {}, 'That link did not work'), h('p', { class: 'muted', style: 'margin-top:6px' }, msg),
  h('a', { class: 'btn primary block', style: 'margin-top:16px', href: back() }, 'Request a new link'));

function finish(user) {
  try { localStorage.removeItem('tapin-signin'); } catch {}
  location.replace(back());
}

function nameStep(user, err = '') {
  const input = h('input', { class: 'input', id: 'nm', type: 'text', autocomplete: 'name', placeholder: 'Full name', maxlength: '80' });
  mount(root, h('h2', {}, 'Welcome. What should we call you?'),
    h('form', { onsubmit: async (e) => { e.preventDefault(); try { await patch('/me', { name: input.value.trim() }); finish(); } catch (ex) { nameStep(user, ex.message); } } },
      h('div', { class: 'field' }, h('label', { for: 'nm' }, 'Your name'), input,
        h('p', { class: 'hint' }, 'Gate staff see your first name and last initial, so they can match you to your pass.')),
      err && h('div', { class: 'error', role: 'alert' }, err),
      h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn primary block', type: 'submit' }, 'Finish'))));
  input.focus();
}

async function complete(email) {
  mount(root, h('p', { class: 'muted' }, 'Signing you in…'));
  try {
    const r = await post('/auth/email-link/complete', { email, oobCode });
    if (r.is_new || !r.user.name) nameStep(r.user);
    else finish(r.user);
  } catch (ex) {
    fail(ex.message);
  }
}

if (!oobCode) {
  location.replace('/app/');
} else if (saved.email) {
  complete(saved.email);
} else {
  // Opened on a different browser from the one that asked for the link: confirm the address.
  const input = h('input', { class: 'input', id: 'em', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
  mount(root, h('h2', {}, 'Confirm your email'), h('p', { class: 'muted', style: 'margin-top:6px' }, 'Type the email address this link was sent to.'),
    h('form', { onsubmit: (e) => { e.preventDefault(); complete(input.value.trim().toLowerCase()); } },
      h('div', { class: 'field' }, h('label', { for: 'em' }, 'Email address'), input),
      h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in'))));
  input.focus();
}
