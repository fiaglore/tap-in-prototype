// Sending one-time codes. This is the one place that talks to an SMS or email provider.
//
// OTP_MODE=demo  No message is sent. The route returns the code to the browser so the flow can be
//                tried end to end. Anyone can then sign in as any phone number, so demo mode is only
//                for trying the product, never for real events.
// OTP_MODE=live  A real provider must be wired in below. Until one is, this refuses to send rather
//                than quietly falling back to demo behaviour.
//
// To go live, implement sendSms and sendEmail with your provider's API (for Nigerian numbers,
// Termii or Africa's Talking are common SMS choices; Resend or Postmark for email), store the API key
// with `wrangler secret put`, and set OTP_MODE to "live" in wrangler.jsonc.

import { HttpError } from './util.js';

async function sendSms(/* env, to, text */) {
  throw new HttpError(503, 'otp_provider_not_configured', 'Text message sending is not set up yet.');
}

async function sendEmail(/* env, to, subject, text */) {
  throw new HttpError(503, 'otp_provider_not_configured', 'Email sending is not set up yet.');
}

export const isDemo = (env) => (env.OTP_MODE || 'demo') !== 'live';

export async function deliverOtp(env, { kind, to, code }) {
  if (isDemo(env)) return { demo: true };
  const text = `Your Tap In code is ${code}. It expires in 10 minutes. Do not share it.`;
  if (kind === 'phone') await sendSms(env, to, text);
  else await sendEmail(env, to, 'Your Tap In code', text);
  return { demo: false };
}
