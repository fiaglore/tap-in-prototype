// Email sign-in through Firebase Authentication's "email link" method, called over its public REST API.
// Firebase sends the email (from noreply@<project>.firebaseapp.com, so no domain of your own is needed).
// The person clicks the link, lands on /signin/ with a one-time oobCode, and this Worker trades that code
// for a confirmed email address by asking Google directly. Nothing from the browser is trusted on its own.

import { HttpError } from './util.js';

const BASE = 'https://identitytoolkit.googleapis.com/v1/accounts';

async function call(env, action, payload) {
  if (!env.FIREBASE_API_KEY) {
    throw new HttpError(503, 'otp_provider_not_configured', 'Email sign-in is not set up yet.');
  }
  let res;
  try {
    res = await fetch(`${BASE}:${action}?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw new HttpError(502, 'email_unreachable', 'Could not reach the email service. Try again.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const reason = (data && data.error && data.error.message) || 'UNKNOWN';
    console.error('Firebase ' + action + ' failed:', res.status, reason);
    throw mapError(reason);
  }
  return data;
}

function mapError(reason) {
  const r = String(reason);
  if (/OPERATION_NOT_ALLOWED/.test(r)) {
    return new HttpError(503, 'email_not_enabled', 'Email-link sign-in is switched off in Firebase. Enable it in Authentication > Sign-in method.');
  }
  if (/UNAUTHORIZED_DOMAIN|INVALID_CONTINUE_URI|MISSING_CONTINUE_URI/.test(r)) {
    return new HttpError(503, 'domain_not_authorised', 'This website address is not in Firebase Authentication > Settings > Authorized domains.');
  }
  if (/API_KEY|PERMISSION_DENIED|REQUEST_DENIED/.test(r)) {
    return new HttpError(503, 'bad_firebase_key', 'The Firebase API key is wrong or restricted.');
  }
  if (/TOO_MANY_ATTEMPTS|QUOTA/.test(r)) {
    return new HttpError(429, 'rate_limited', 'Too many emails requested. Wait a few minutes and try again.');
  }
  if (/INVALID_OOB_CODE|EXPIRED_OOB_CODE/.test(r)) {
    return new HttpError(400, 'link_invalid', 'That sign-in link has expired or was already used. Request a new one.');
  }
  if (/INVALID_EMAIL/.test(r)) return new HttpError(400, 'invalid_identifier', 'Enter a valid email address.');
  return new HttpError(502, 'email_failed', 'The email could not be sent. Try again in a moment.');
}

export async function sendSignInLink(env, email, continueUrl) {
  await call(env, 'sendOobCode', {
    requestType: 'EMAIL_SIGNIN',
    email,
    continueUrl,
    canHandleCodeInApp: true
  });
}

// Returns the email address Firebase confirms for this link. A link only works once.
export async function completeSignIn(env, email, oobCode) {
  const data = await call(env, 'signInWithEmailLink', { email, oobCode });
  return String(data.email || '').toLowerCase();
}
