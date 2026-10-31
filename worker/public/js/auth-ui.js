// Sign-in / register flow shared by the attendee app and the organiser console.
// Steps: identifier -> 6-digit code -> (first time only) name. Resolves with the signed-in user.
import { h, mount } from './dom.js';
import { get, patch, post } from './api.js';
import { begin as beginAppLogin, clear as clearAppLogin, inApp, pending as pendingAppLogin } from './applogin.js';

export function signInFlow(root, { title, lede, onDone }) {
  let identifier = '';
  let config = { otp_mode: 'demo', configured: true };
  const emailOnly = () => config.otp_mode === 'firebase';

  // In the phone app the emailed link opens in the browser. This waits for the browser to finish, then signs the app in.
  let poll = null;
  const stopPoll = () => {
    if (!poll) return;
    poll.stopped = true; clearTimeout(poll.timer);
    document.removeEventListener('visibilitychange', poll.wake); window.removeEventListener('focus', poll.wake);
    poll = null;
  };
  function startPoll(app) {
    stopPoll();
    const p = (poll = { stopped: false, timer: 0, busy: false });
    const tick = async () => {
      clearTimeout(p.timer);
      if (p.stopped || p.busy) return;
      const waited = Date.now() - app.at;
      if (waited > 65 * 60 * 1000) { stopPoll(); clearAppLogin(); stepIdentifier('That sign-in link has expired. Enter your email to get a new one.'); return; }
      if (!document.hidden) {
        p.busy = true;
        try {
          const r = await post('/auth/app/redeem', { verifier: app.verifier });
          if (p.stopped) return;
          if (r.user) { stopPoll(); clearAppLogin(); if (r.is_new || !r.user.name) stepName(r.user); else onDone(r.user); return; }
        } catch (ex) {
          if (ex.status === 400) { stopPoll(); clearAppLogin(); stepIdentifier('Something went wrong. Enter your email to try again.'); return; }
        } finally { p.busy = false; }
      }
      p.timer = setTimeout(tick, waited < 120000 ? 2500 : waited < 600000 ? 5000 : 15000);
    };
    p.wake = () => { if (!document.hidden) tick(); };   // coming back to the app checks straight away
    document.addEventListener('visibilitychange', p.wake); window.addEventListener('focus', p.wake);
    p.timer = setTimeout(tick, 1500);
  }

  function stepIdentifier(err = '') {
    stopPoll();
    const input = h('input', { class: 'input', id: 'ident', type: emailOnly() ? 'email' : 'text', inputmode: 'email', autocomplete: 'username', placeholder: emailOnly() ? 'you@example.com' : '0803 412 7790 or you@example.com', value: identifier, 'aria-describedby': 'ident-hint' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, emailOnly() ? 'Email me a sign-in link' : 'Send me a code');
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        identifier = input.value.trim();
        try {
          let app = null;
          if (emailOnly() && inApp()) { try { app = await beginAppLogin(identifier.toLowerCase()); } catch {} }
          const r = await post('/auth/otp/request', app ? { identifier, app_challenge: app.challenge } : { identifier });
          if (r.channel === 'email-link') {
            try { localStorage.setItem('tapin-signin', JSON.stringify({ email: identifier.toLowerCase(), ret: location.pathname })); } catch {}
            stepLink(r, '', app);
          } else stepCode('', r);
        } catch (ex) {
          stepIdentifier(ex.message);
        }
      }
    },
      h('div', { class: 'field' }, h('label', { for: 'ident' }, emailOnly() ? 'Email address' : 'Phone number or email'), input,
        h('p', { class: 'hint', id: 'ident-hint' }, emailOnly() ? 'We email you a link that signs you in. We only use your email to sign you in and match invites sent to you.' : 'Nigerian numbers work with or without the 0. We only use this to sign you in and match invites sent to you.')),
      err && h('div', { class: 'error', role: 'alert' }, err),
      h('div', { style: 'margin-top:16px' }, btn),
      h('p', { class: 'hint', style: 'margin-top:12px' }, 'By continuing you agree to the ', h('a', { href: '/terms/', target: '_blank', rel: 'noopener' }, 'terms'), ' and the ', h('a', { href: '/privacy/', target: '_blank', rel: 'noopener' }, 'privacy policy'), '.'));
    mount(root, h('h2', {}, title), lede && h('p', { class: 'muted', style: 'margin-top:6px' }, lede), form);
    input.focus();
  }

  function stepCode(err = '', sent = {}) {
    stopPoll();
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
    mount(root, sent.dev_code
      ? [h('h2', {}, 'Enter your code'), h('p', { class: 'muted', style: 'margin-top:6px' }, 'Your code for ' + identifier + ' is below. It works for 10 minutes.')]
      : [h('h2', {}, 'Check your ' + (sent.channel === 'email' ? 'email' : 'messages')), h('p', { class: 'muted', style: 'margin-top:6px' }, 'We sent a code to ' + identifier + '. It works for 10 minutes.')], form);
    input.focus();
  }

  function stepLink(sent, note = '', app = null) {
    stopPoll();
    const resend = h('button', { class: 'btn ghost block', type: 'button', onclick: async (e) => {
      e.target.disabled = true;
      try { await post('/auth/otp/request', app ? { identifier, app_challenge: app.challenge } : { identifier }); stepLink(sent, 'Sent again. Check your spam folder too.', app); } catch (ex) { stepLink(sent, ex.message, app); }
    } }, 'Send it again');
    mount(root, h('h2', {}, 'Check your email'),
      h('p', { class: 'muted', style: 'margin-top:6px' }, app
        ? 'We sent a sign-in link to ' + identifier + '. Open it, then come back to this app and you will be signed in here. The link works once and expires in about an hour.'
        : 'We sent a sign-in link to ' + identifier + '. Open it on this device and you will be signed in. The link works once and expires in about an hour.'),
      app && h('p', { class: 'hint', role: 'status', style: 'margin-top:12px' }, 'Waiting for you to open the link…'),
      note && h('div', { class: 'notice', role: 'status' }, note),
      h('p', { class: 'hint', style: 'margin-top:12px' }, 'Nothing there? Look in spam or promotions. The sender is Firebase / noreply.'),
      h('div', { style: 'margin-top:16px' }, resend),
      h('p', { class: 'hint', style: 'margin-top:10px;text-align:center' }, 'Wrong email? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); stepIdentifier(); } }, 'Change it')));
    if (app) startPoll(app);
  }

  function stepName(user, err = '') {
    stopPoll();
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

  get('/config').then((c) => { config = c; }).catch(() => {}).finally(() => {
    // The app may have been closed while the person went to their email: carry on waiting for the same link.
    const waiting = emailOnly() && inApp() ? pendingAppLogin() : null;
    if (waiting) { identifier = waiting.email; stepLink({ channel: 'email-link' }, '', waiting); } else stepIdentifier();
  });
}
