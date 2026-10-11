// Sign-in / register flow shared by the attendee app and the organiser console.
// Steps: identifier -> 6-digit code -> (first time only) name. Resolves with the signed-in user.
import { h, mount } from './dom.js';
import { get, patch, post } from './api.js';

export function signInFlow(root, { title, lede, onDone }) {
  let identifier = '';
  let config = { otp_mode: 'demo', configured: true };
  get('/config').then((c) => { config = c; }).catch(() => {});

  function stepIdentifier(err = '') {
    const input = h('input', { class: 'input', id: 'ident', type: 'text', inputmode: 'email', autocomplete: 'username', placeholder: '0803 412 7790 or you@example.com', value: identifier, 'aria-describedby': 'ident-hint' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Send me a code');
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        identifier = input.value.trim();
        try {
          const r = await post('/auth/otp/request', { identifier });
          stepCode('', r);
        } catch (ex) {
          stepIdentifier(ex.message);
        }
      }
    },
      h('div', { class: 'field' }, h('label', { for: 'ident' }, 'Phone number or email'), input,
        h('p', { class: 'hint', id: 'ident-hint' }, 'Nigerian numbers work with or without the 0. We only use this to sign you in and match invites sent to you.')),
      err && h('div', { class: 'error', role: 'alert' }, err),
      h('div', { style: 'margin-top:16px' }, btn));
    mount(root, h('h2', {}, title), lede && h('p', { class: 'muted', style: 'margin-top:6px' }, lede), form);
    input.focus();
  }

  function stepCode(err = '', sent = {}) {
    const input = h('input', { class: 'input otp', id: 'otp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '••••••', 'aria-label': '6-digit code' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Verify and continue');
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const r = await post('/auth/otp/verify', { identifier, code: input.value.trim() });
          if (r.is_new || !r.user.name) stepName(r.user);
          else onDone(r.user);
        } catch (ex) {
          stepCode(ex.message, sent);
        }
      }
    },
      h('div', { class: 'field' }, h('label', { for: 'otp' }, 'Enter the 6-digit code'), input),
      sent.dev_code && h('div', { class: 'notice warn' },
        h('strong', {}, 'Demo mode. '), 'No SMS or email is sent yet, so the code is shown here: ',
        h('button', { type: 'button', class: 'btn small ghost', style: 'margin-left:6px', onclick: () => { input.value = sent.dev_code; } }, sent.dev_code)),
      err && h('div', { class: 'error', role: 'alert' }, err),
      h('div', { style: 'margin-top:16px' }, btn),
      h('p', { class: 'hint', style: 'margin-top:10px;text-align:center' }, 'Wrong ' + (identifier.includes('@') ? 'email' : 'number') + '? ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); stepIdentifier(); } }, 'Change it')));
    mount(root, h('h2', {}, 'Check your ' + (sent.channel === 'email' ? 'email' : 'messages')), h('p', { class: 'muted', style: 'margin-top:6px' }, 'We sent a code to ' + identifier + '. It works for 10 minutes.'), form);
    input.focus();
  }

  function stepName(user, err = '') {
    const input = h('input', { class: 'input', id: 'nm', type: 'text', autocomplete: 'name', placeholder: 'Full name', maxlength: '80' });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await patch('/me', { name: input.value.trim() });
          onDone(r.user);
        } catch (ex) {
          stepName(user, ex.message);
        }
      }
    },
      h('div', { class: 'field' }, h('label', { for: 'nm' }, 'Your name'), input,
        h('p', { class: 'hint' }, 'Gate staff see your first name and last initial, so they can match you to your pass.')),
      err && h('div', { class: 'error', role: 'alert' }, err),
      h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn primary block', type: 'submit' }, 'Finish')));
    mount(root, h('h2', {}, 'Welcome. What should we call you?'), form);
    input.focus();
  }

  stepIdentifier();
}
