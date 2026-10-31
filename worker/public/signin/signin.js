// Landing page for the emailed sign-in link. Trades the one-time code in the URL for a session.
import { h, mount } from '/js/dom.js';
import { patch, post } from '/js/api.js';

const root = document.getElementById('root');
const query = new URLSearchParams(location.search);
const oobCode = query.get('oobCode');
// Present when the phone app asked for this link: the browser leaves a note the app collects (see js/applogin.js).
const appChallenge = /^[A-Za-z0-9_-]{43}$/.test(query.get('ac') || '') ? query.get('ac') : null;
let saved = {};
try { saved = JSON.parse(localStorage.getItem('tapin-signin') || '{}'); } catch {}

const back = () => (typeof saved.ret === 'string' && /^\/(app|organiser)\/$/.test(saved.ret) ? saved.ret : '/app/');
const fail = (msg) => mount(root, h('h2', {}, 'That link did not work'), h('p', { class: 'muted', style: 'margin-top:6px' }, msg),
  h('a', { class: 'btn primary block', style: 'margin-top:16px', href: back() }, 'Request a new link'));

function finish(user) {
  try { localStorage.removeItem('tapin-signin'); } catch {}
  location.replace(back());
}

// The sign-in was asked for from the app: tell the person to go back to it (it asks for a name itself the first time),
// and let them carry on here if they would rather.
function backToApp(user) {
  mount(root, h('h2', {}, 'You are signed in'),
    h('p', { class: 'muted', style: 'margin-top:6px' }, 'Go back to the Tap In app. It signs you in on its own within a few seconds.'),
    h('p', { class: 'hint', style: 'margin-top:12px' }, 'Nothing happening? Open the app again and wait a moment.'),
    h('button', { class: 'btn ghost block', type: 'button', style: 'margin-top:16px', onclick: () => { if (user.name) finish(user); else nameStep(user); } }, 'Continue in this browser instead'));
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
    const r = await post('/auth/email-link/complete', appChallenge ? { email, oobCode, app_challenge: appChallenge } : { email, oobCode });
    if (r.app_handoff === true) backToApp(r.user);
    else if (r.is_new || !r.user.name) nameStep(r.user);
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
