// Signing in from the phone app, or from an installed web app.
// The emailed link opens in the browser, which cannot hand its session to the app. So the app keeps a random secret and
// sends only its SHA-256 (the "challenge") when it asks for the link. When the browser has finished, the app collects the
// sign-in by showing the secret. The secret stays on this device and is never in the link.
const KEY = 'tapin-app-login';
const TTL_MS = 65 * 60 * 1000; // a little longer than the emailed link itself lives (about an hour)
let memory = null;             // used when this device will not let us keep it in storage

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const inApp = () =>
  document.documentElement.classList.contains('is-native') ||
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  window.navigator.standalone === true;

function load() {
  let v = memory;
  try { v = JSON.parse(localStorage.getItem(KEY)) || v; } catch {}
  return v && typeof v.verifier === 'string' && Date.now() - v.at < TTL_MS ? v : null;
}
function save(v) {
  memory = v;
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {}
}

// A sign-in that is still waiting for its link to be opened, or null.
export const pending = () => load();

export function clear() {
  memory = null;
  try { localStorage.removeItem(KEY); } catch {}
}

// Start (or carry on) signing in for this email. Asking again for the same email keeps the same secret, so a resent link
// still works for the app that is already waiting. Throws where the browser has no crypto; the caller then signs in normally.
export async function begin(email) {
  const keep = load();
  if (keep && keep.email === email) return keep;
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const v = { verifier, challenge, email, at: Date.now() };
  save(v);
  return v;
}
