// Office self check-in, opened from the QR on the screen at the office (the code is in the address after the #).
// Steps: confirm location, then (only if asked) a live selfie, then the receipt.
import { h, mount, when } from '/js/dom.js';
import { post } from '/js/api.js';
import { selfieModal } from '/js/selfie.js';

const root = document.getElementById('root');
const token = decodeURIComponent(location.hash.slice(1));

const head = (title, sub) => [h('div', { class: 'inv-head' }, h('p', { class: 'eyebrow' }, 'Tap In for Business'), h('h1', {}, title), sub && h('p', { class: 'muted' }, sub))];
const fail = (title, msg, retry) => mount(root, ...head(title), h('div', { class: 'card' }, h('p', {}, msg), retry && h('button', { class: 'btn primary block', style: 'margin-top:14px', type: 'button', onclick: retry }, 'Try again')));

// The phone's position, with its accuracy. Resolves { lat, lng, accuracy } or throws a message to show.
function where() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share its location.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Location is switched off for this page. Allow it in your browser settings, then try again.' : 'Your location could not be found. Try again near a window.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

function receipt(r) {
  document.title = 'Attendance recorded · Tap In';
  mount(root, ...head('Attendance recorded', r.office),
    h('div', { class: 'card', style: 'text-align:center' },
      r.selfie && h('img', { src: r.selfie, alt: 'Your check-in selfie', width: '120', height: '120', style: 'border-radius:50%;object-fit:cover;margin-bottom:10px' }),
      h('h2', {}, r.name || 'You'),
      h('p', { class: 'muted' }, [r.employee_ref, r.department].filter(Boolean).join(' · ')),
      h('p', { style: 'margin-top:10px' }, when(r.at, { dateStyle: 'medium', timeStyle: 'medium' })),
      r.already && h('p', { class: 'hint', style: 'margin-top:8px' }, 'You had already checked in today.'),
      h('p', { class: 'hint', style: 'margin-top:8px' }, 'Your location and selfie are used only to confirm this check-in. The selfie is deleted after 30 days.')));
}

let selfie = null;
async function run() {
  mount(root, ...head('Checking you in', 'Confirming where you are…'));
  let pos;
  try { pos = await where(); } catch (ex) { return fail('Location needed', ex.message, run); }
  try {
    let r = await post('/checkin', { token, ...pos, ...(selfie ? { selfie } : {}) });
    if (r.needs_selfie) {
      // Asked now and then, at random. The selfie is taken live (no photo library) and only used for this check-in.
      selfie = await selfieModal({ title: 'Quick selfie', liveOnly: true, note: 'A live selfie is needed to finish checking in today. Photos from your gallery are not accepted.', consent: 'This selfie is used only to confirm this check-in. Your office admin can see it, nobody else can, and it is deleted after 30 days. It is not used for automatic face recognition. ' });
      if (!selfie) return fail('Selfie needed', 'This check-in needs a selfie. Nothing has been recorded yet.', run);
      r = await post('/checkin', { token, ...pos, selfie, challenge: r.challenge });
    }
    receipt(r);
  } catch (ex) {
    if (ex.status === 401) return mount(root, ...head('Sign in first'), h('div', { class: 'card' }, h('p', {}, 'Sign in to the Tap In app, then scan the screen at the office again.'), h('a', { class: 'btn primary block', style: 'margin-top:14px', href: '/app/' }, 'Open Tap In')));
    selfie = null;
    // A stale code cannot be retried from here: the person needs to scan the screen again.
    fail(ex.code === 'stale_code' ? 'Code expired' : ex.code === 'outside_location' ? 'Not at the office' : 'Could not check in', ex.message, ex.code === 'stale_code' ? null : run);
  }
}

if (!token) fail('Scan the code at the office', 'Open your phone camera and scan the QR code on the screen at your office.');
else run();
