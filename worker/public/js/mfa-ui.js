// Two-step sign-in screens, shared by the app (Account > Security) and the team console.
import { h, mount, toast, copy } from '/js/dom.js';
import { get, post } from '/js/api.js';
import { qrSvg } from '/js/qr.js';

const codeInput = () => h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '24', placeholder: '6-digit code or recovery code', 'aria-label': 'Authenticator code', style: 'letter-spacing:.1em' });

// Ask for the current code (or a recovery code) to unlock sensitive actions on this sign-in.
export function mfaVerify(box, { title = 'Two-step sign-in', onDone }) {
  const code = codeInput();
  const err = h('div', { class: 'error', role: 'alert', hidden: true });
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    try { await post('/me/mfa/verify', { code: code.value }); onDone(); } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  } }, h('h2', {}, title), h('p', { class: 'lede' }, 'Open your authenticator app and enter the 6-digit code for Tap In. Lost your phone? Use one of your recovery codes.'),
  code, err, h('button', { class: 'btn primary', type: 'submit' }, 'Continue'));
  mount(box, form);
  code.focus();
}

// Turn two-step sign-in on: scan the code, prove it works, keep the recovery codes.
export async function mfaSetup(box, { onDone }) {
  let s;
  try { s = await post('/me/mfa/setup'); } catch (ex) { return mount(box, h('div', { class: 'error' }, ex.message)); }
  const code = codeInput();
  const err = h('div', { class: 'error', role: 'alert', hidden: true });
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true;
    try {
      const r = await post('/me/mfa/enable', { code: code.value });
      mount(box, h('div', { class: 'stack' }, h('h2', {}, 'Two-step sign-in is on'),
        h('p', { class: 'lede' }, 'Save these recovery codes somewhere safe, like a password manager. Each works once if you lose your phone. They will not be shown again.'),
        h('div', { class: 'card' }, r.recovery_codes.map((c) => h('div', { class: 'code', style: 'user-select:all;font-family:var(--mono,monospace);padding:2px 0' }, c))),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => copy(r.recovery_codes.join('\n'), 'Recovery codes copied') }, 'Copy codes'),
        h('button', { class: 'btn primary', type: 'button', onclick: onDone }, 'I have saved them')));
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  } },
  h('h2', {}, 'Turn on two-step sign-in'),
  h('p', { class: 'lede' }, 'Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy), then enter the 6-digit code it shows.'),
  h('div', { style: 'background:#fff;padding:12px;border-radius:12px;max-width:240px' }, qrSvg(s.otpauth_uri, 'Authenticator setup code')),
  h('p', { class: 'hint' }, 'Cannot scan? Enter this key by hand: ', h('b', { style: 'user-select:all;word-break:break-all' }, s.secret)),
  code, err, h('button', { class: 'btn primary', type: 'submit' }, 'Turn on'));
  mount(box, form);
}

// A card for the Account page.
export function mfaCard() {
  const box = h('div', { class: 'card' });
  const paint = async () => {
    let st;
    try { st = await get('/me/mfa'); } catch { return mount(box, h('p', { class: 'hint' }, 'Security settings are not available right now.')); }
    mount(box, h('h3', {}, 'Two-step sign-in'),
      h('p', { class: 'hint', style: 'margin-top:4px' }, st.enabled ? `On. ${st.recovery_codes_left} recovery code${st.recovery_codes_left === 1 ? '' : 's'} left. Needed for refunds and the team console.` : 'Adds a code from your phone to sign-in. Recommended for organisers who take payments, and required for the Tap In team.'),
      st.enabled
        ? h('button', { class: 'btn ghost small', style: 'margin-top:10px', type: 'button', onclick: () => {
          const c = codeInput();
          mount(box, h('h3', {}, 'Turn off two-step sign-in'), c, h('button', { class: 'btn danger small', style: 'margin-top:10px', type: 'button', onclick: async () => { try { await post('/me/mfa/disable', { code: c.value }); toast('Turned off'); paint(); } catch (ex) { toast(ex.message); } } }, 'Turn off'));
        } }, 'Turn off')
        : h('button', { class: 'btn primary small', style: 'margin-top:10px', type: 'button', onclick: () => mfaSetup(box, { onDone: paint }) }, 'Turn on'));
  };
  paint();
  return box;
}
