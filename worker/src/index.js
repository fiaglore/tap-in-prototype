// Tap In: one Worker serves the API (/api/*) and, through the ASSETS binding, the website in /public.

import { HttpError, nowSec } from './lib/util.js';
import { checkOrigin, json } from './lib/http.js';
import { currentUser } from './lib/session.js';
import { otpMode } from './lib/otp-delivery.js';
import * as auth from './routes/auth.js';
import * as me from './routes/me.js';
import * as events from './routes/events.js';
import * as gate from './routes/gate.js';
import * as publicSale from './routes/public.js';
import * as stewards from './routes/stewards.js';
import * as guests from './routes/guests.js';
import * as attendance from './routes/attendance.js';
import * as walletPasses from './routes/wallet-passes.js';
import { walletConfig } from './lib/wallet.js';
import * as wallet from './routes/wallet.js';
import * as vendors from './routes/vendors.js';
import * as till from './routes/till.js';
import { PAYMENT_API, PAYMENT_PAGES, paymentsOff } from './lib/money.js';
import * as photo from './routes/photo.js';
import { routeByHost } from './lib/hosts.js';

// [method, path, auth, handler]. auth "user" needs a signed-in session; gate routes check their own key.
const ROUTES = [
  ['GET', '/api/config', 'none', ({ env }) => json({ otp_mode: otpMode(env), payments: !paymentsOff(env), wallet: walletConfig(env), configured: isConfigured(env), ...(otpMode(env) === 'firebase' && !env.FIREBASE_API_KEY ? { delivery_problem: 'FIREBASE_API_KEY is not set' } : {}), ...(isConfigured(env) ? {} : { problem: !env.SECRET_PEPPER ? 'SECRET_PEPPER is not set on the running Worker' : 'SECRET_PEPPER is set but shorter than 32 characters (length ' + String(env.SECRET_PEPPER).length + ')' }) })],
  ['POST', '/api/auth/otp/request', 'none', auth.otpRequest],
  ['POST', '/api/auth/otp/verify', 'none', auth.otpVerify],
  ['POST', '/api/auth/email-link/complete', 'none', auth.emailLinkComplete],
  ['POST', '/api/auth/app/redeem', 'none', auth.appRedeem],
  ['POST', '/api/auth/logout', 'none', auth.logout],

  ['GET', '/api/me', 'user', me.me],
  ['PATCH', '/api/me', 'user', auth.patchMe],
  ['DELETE', '/api/me', 'user', auth.deleteMe],
  ['GET', '/api/me/history', 'user', me.history],
  ['GET', '/api/me/photo', 'user', photo.getPhoto],
  ['PUT', '/api/me/photo', 'user', photo.putPhoto],
  ['DELETE', '/api/me/photo', 'user', photo.deletePhoto],
  ['POST', '/api/claim', 'user', me.claim],
  ['GET', '/api/me/passes/:id/live', 'user', me.liveCode],

  ['GET', '/api/events', 'user', events.listEvents],
  ['POST', '/api/events', 'user', events.createEvent],
  ['GET', '/api/events/:id', 'user', events.getEvent],
  ['PATCH', '/api/events/:id', 'user', events.patchEvent],
  ['PATCH', '/api/events/:id/tiers/:tierId', 'user', events.patchTier],
  ['DELETE', '/api/events/:id/tiers/:tierId', 'user', events.deleteTier],
  ['POST', '/api/events/:id/tiers', 'user', events.addTier],
  ['POST', '/api/events/:id/zones', 'user', events.addZone],
  ['PATCH', '/api/events/:id/zones/:zoneId', 'user', events.renameZone],
  ['DELETE', '/api/events/:id/zones/:zoneId', 'user', events.deleteZone],
  ['GET', '/api/events/:id/scans', 'user', events.listScans],
  ['POST', '/api/events/:id/gate-key', 'user', events.rotateGateKey],
  ['GET', '/api/events/:id/stewards', 'user', stewards.listStewards],
  ['POST', '/api/events/:id/stewards', 'user', stewards.createSteward],
  ['POST', '/api/events/:id/stewards/:stewardId/revoke', 'user', stewards.revokeSteward],
  ['GET', '/api/events/:id/report', 'user', stewards.eventReport],
  ['GET', '/api/events/:id/guests', 'user', guests.listGuests],
  ['POST', '/api/events/:id/guests', 'user', guests.addInvitations],
  ['POST', '/api/events/:id/guests/import', 'user', guests.importGuests],
  ['GET', '/api/events/:id/wristbands', 'user', guests.listWristbandPeople],
  ['POST', '/api/events/:id/wristbands', 'user', guests.makeWristbands],
  ['POST', '/api/events/:id/guests/:guestId/revoke', 'user', guests.revokeGuest],
  ['POST', '/api/invitation', 'none', guests.openInvitation],
  ['POST', '/api/invitation/rsvp', 'none', guests.rsvp],
  ['GET', '/api/invitation/wallet/:provider', 'none', walletPasses.invitationWallet],
  ['GET', '/api/me/passes/:id/wallet/:provider', 'user', walletPasses.passWallet],
  ['GET', '/api/events/:id/scans.csv', 'user', stewards.scansCsv],
  ['GET', '/api/events/:id/invites', 'user', events.listInvites],
  ['POST', '/api/events/:id/invites', 'user', events.createInvites],
  ['POST', '/api/events/:id/invites/:inviteId/revoke', 'user', events.revokeInvite],
  ['POST', '/api/events/:id/people', 'user', events.addPeople],
  ['GET', '/api/events/:id/attendees', 'user', events.listAttendees],
  ['POST', '/api/events/:id/passes/:passId/revoke', 'user', events.revokePass],

  ['GET', '/api/gate/info', 'none', gate.gateInfo],
  ['POST', '/api/gate/scan', 'none', gate.gateScan],
  ['GET', '/api/gate/list', 'none', gate.gateList],
  ['POST', '/api/gate/sync', 'none', gate.gateSync],
  ['POST', '/api/gate/walkin', 'none', gate.gateWalkin],
  ['GET', '/api/events/:id/visitors', 'user', guests.listVisitors],
  ['GET', '/api/events/:id/attendance', 'user', attendance.attendance],
  ['GET', '/api/events/:id/attendance.csv', 'user', attendance.attendanceCsv],
  ['POST', '/api/events/:id/visitors', 'user', guests.addVisitor],

  ['GET', '/api/wallet', 'user', wallet.wallet],
  ['POST', '/api/wallet/topup', 'user', wallet.topup],
  ['POST', '/api/wallet/pay-code', 'user', wallet.payCode],

  ['GET', '/api/vendors', 'user', vendors.listVendors],
  ['POST', '/api/vendors', 'user', vendors.createVendor],
  ['GET', '/api/vendors/:id', 'user', vendors.getVendor],
  ['PATCH', '/api/vendors/:id', 'user', vendors.patchVendor],
  ['POST', '/api/vendors/:id/till-key', 'user', vendors.rotateTillKey],
  ['POST', '/api/vendors/:id/refunds', 'user', vendors.refund],
  ['POST', '/api/vendors/:id/payout', 'user', vendors.payout],

  ['GET', '/api/till/info', 'none', till.tillInfo],
  ['POST', '/api/till/charge', 'none', till.tillCharge],

  ['GET', '/api/public/vendors', 'none', vendors.publicVendors],
  ['GET', '/api/public/events', 'none', publicSale.listUpcoming],
  ['GET', '/api/public/events/:id', 'none', publicSale.getEvent],
  ['POST', '/api/public/events/:id/buy', 'user', publicSale.buy]
];

const isConfigured = (env) => !!env.SECRET_PEPPER && env.SECRET_PEPPER.length >= 32;

function match(pattern, path) {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) {
      if (!b[i]) return null;
      params[a[i].slice(1)] = decodeURIComponent(b[i]);
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  let found = null;
  let pathExists = false;
  for (const [method, pattern, authLevel, fn] of ROUTES) {
    const params = match(pattern, path);
    if (!params) continue;
    pathExists = true;
    if (method === request.method) {
      found = { params, authLevel, fn };
      break;
    }
  }
  if (!found) throw pathExists ? new HttpError(405, 'method_not_allowed', 'Method not allowed.') : new HttpError(404, 'not_found', 'Not found.');
  if (paymentsOff(env) && PAYMENT_API.test(path)) throw new HttpError(404, 'payments_unavailable', 'Payments are not available yet.');

  checkOrigin(request);
  if (path !== '/api/config' && !isConfigured(env)) {
    throw new HttpError(
      503,
      'not_configured',
      'The server is missing its SECRET_PEPPER secret (at least 32 characters). See the README, "Set the secret".'
    );
  }

  let user = null;
  if (found.authLevel === 'user') {
    user = await currentUser(env, request);
    if (!user) throw new HttpError(401, 'unauthorised', 'Sign in to continue.');
  }
  return found.fn({ request, env, url, params: found.params, user });
}

// Remove expired rows. Runs from the daily cron trigger in wrangler.jsonc.
export async function purge(env) {
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM otps WHERE expires_at < ?1').bind(now - 86400),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now),
    env.DB.prepare('DELETE FROM app_logins WHERE expires_at < ?1').bind(now - 86400),
    env.DB.prepare('DELETE FROM rate_events WHERE at < ?1').bind(now - 86400),
    // Storage limitation: drop a selfie a month after it was last set unless its owner still needs it
    // (an active pass at an office, or at an event that is undated or recent).
    env.DB.prepare(
      `DELETE FROM user_photos WHERE updated_at < ?1 AND user_id NOT IN (
         SELECT p.user_id FROM passes p JOIN events e ON e.id = p.event_id
         WHERE p.status = 'active' AND (e.kind = 'workplace' OR e.starts_at IS NULL OR e.starts_at > ?2))`
    ).bind(now - 30 * 86400, now - 7 * 86400)
  ]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
      const hop = routeByHost(request, env, url);
      if (hop) return hop;
      // With payments off the vendor and till pages answer like any missing page.
      if (paymentsOff(env) && PAYMENT_PAGES.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL('/__payments_off__', url), request));
      if (url.pathname === '/e/' || url.pathname === '/e/index.html') return publicSale.salePageHtml(request, env);
      return env.ASSETS.fetch(request);
    }
    try {
      return await handleApi(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { code: err.code, message: err.message, ...(err.extra || {}) } }, err.status);
      }
      console.error('Unhandled error', err && err.stack ? err.stack : err);
      return json({ error: { code: 'server_error', message: 'Something went wrong on our side. Try again.' } }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purge(env));
  }
};
