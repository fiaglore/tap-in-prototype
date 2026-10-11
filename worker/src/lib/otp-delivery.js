// Sending one-time codes. This is the one place that talks to an SMS or email provider.
//
// OTP_MODE=demo  No message is sent. The route returns the code to the browser so the flow can be
//                tried end to end. Anyone can then sign in as any phone number, so demo mode is only
//                for trying the product, never for real events.
// OTP_MODE=live  A real provider must be wired in below. Until one is, this refuses to send rather
//                than quietly falling back to demo behaviour.
//
// OTP_MODE=firebase  Email only. Firebase Authentication emails a sign-in link (see lib/firebase.js).
//                     No domain needed. Phone numbers are refused until an SMS provider exists.
//
// To go live with a provider of your own, implement sendSms and sendEmail with your provider's API (for Nigerian numbers,
// Termii or Africa's Talking are common SMS choices; Resend or Postmark for email), store the API key
// with `wrangler secret put`, and set OTP_MODE to "live" in wrangler.jsonc.

import { HttpError } from './util.js';

async function sendSms(/* env, to, text */) {
  throw new HttpError(503, 'otp_provider_not_configured', 'Text message sending is not set up yet.');
}

async function sendEmail(/* env, to, subject, text */) {
  throw new HttpError(503, 'otp_provider_not_configured', 'Email sending is not set up yet.');
}

// "demo" | "firebase" | "live". Anything unrecognised falls back to demo only if unset; a typo is treated as demo too,
// which is why /api/config reports the mode so you can see what is running.
export const otpMode = (env) => {
  const m = String(env.OTP_MODE || 'demo').toLowerCase();
  return m === 'live' || m === 'firebase' ? m : 'demo';
};
export const isDemo = (env) => otpMode(env) === 'demo';
export const isFirebase = (env) => otpMode(env) === 'firebase';

export async function deliverOtp(env, { kind, to, code }) {
  if (isDemo(env)) return { demo: true };
  const text = `Your Tap In code is ${code}. It expires in 10 minutes. Do not share it.`;
  if (kind === 'phone') await sendSms(env, to, text);
  else await sendEmail(env, to, 'Your Tap In code', text);
  return { demo: false };
}
