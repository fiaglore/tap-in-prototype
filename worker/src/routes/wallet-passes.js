// "Add to Apple Wallet" / "Save to Google Wallet" for Tap In passes, invitations and visitor passes.
// Live (rotating) passes stay in the Tap In app: a wallet pass cannot change its code every 30 seconds.
import { HttpError, nowSec } from '../lib/util.js';
import { json } from '../lib/http.js';
import { guestToken, passToken } from '../lib/codes.js';
import { applePass, googleSaveUrl, walletConfig } from '../lib/wallet.js';
import { invitationFor } from './guests.js';

const IMAGES = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png'];
async function images(env, url) {
  return Promise.all(IMAGES.map(async (name) => {
    const res = await env.ASSETS.fetch(new Request(new URL('/wallet/' + name, url)));
    if (!res.ok) throw new HttpError(500, 'wallet_images_missing', 'Wallet images are missing from the site.');
    return { name, data: new Uint8Array(await res.arrayBuffer()) };
  }));
}
function need(env, provider) {
  if (!walletConfig(env)[provider]) throw new HttpError(404, 'wallet_not_set_up', provider === 'apple' ? 'Apple Wallet is not set up yet.' : 'Google Wallet is not set up yet.');
}
async function deliver(env, url, provider, d) {
  if (provider === 'apple') {
    const body = await applePass(env, d, await images(env, url));
    return new Response(body, { headers: { 'Content-Type': 'application/vnd.apple.pkpass', 'Content-Disposition': `attachment; filename="tap-in-${d.serial}.pkpass"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  return json({ url: await googleSaveUrl(env, d, url.origin) });
}

// GET /api/me/passes/:id/wallet/:provider
export async function passWallet({ env, user, params, url }) {
  const provider = params.provider;
  if (provider !== 'apple' && provider !== 'google') throw new HttpError(404, 'not_found', 'Not found.');
  need(env, provider);
  const p = await env.DB.prepare(
    `SELECT p.id, p.status, p.expires_at, e.name AS event_name, e.kind, e.venue, e.city, e.starts_at, e.secure_qr, t.name AS tier, u.name AS holder
     FROM passes p JOIN events e ON e.id = p.event_id JOIN tiers t ON t.id = p.tier_id JOIN users u ON u.id = p.user_id WHERE p.id = ?1 AND p.user_id = ?2`
  ).bind(String(params.id).slice(0, 40), user.id).first();
  if (!p) throw new HttpError(404, 'not_found', 'Pass not found.');
  if (p.status !== 'active' || (p.expires_at && p.expires_at <= nowSec())) throw new HttpError(409, 'pass_not_active', 'This pass is not active.');
  if (p.secure_qr) throw new HttpError(409, 'live_pass', 'This event uses a live code that changes every 30 seconds, so the pass stays in the Tap In app.');
  return deliver(env, url, provider, {
    serial: p.id, kind: p.kind === 'workplace' ? 'office' : 'event', title: p.event_name, holder: p.holder || 'Guest', type: p.tier,
    code: await passToken(env.SECRET_PEPPER, p.id), venue: p.venue, city: p.city, starts_at: p.starts_at, valid_until: p.expires_at
  });
}

// GET /api/invitation/wallet/:provider?t=<invitation link token>  (invitations and visitor passes, no account)
export async function invitationWallet({ request, env, params, url }) {
  const provider = params.provider;
  if (provider !== 'apple' && provider !== 'google') throw new HttpError(404, 'not_found', 'Not found.');
  need(env, provider);
  const g = await invitationFor(request, env, url.searchParams.get('t'));
  const visitor = g.kind === 'visitor';
  return deliver(env, url, provider, {
    serial: g.id, kind: visitor ? 'visitor' : 'invite', title: g.event_name, holder: g.name, type: visitor ? g.tier : null,
    code: await guestToken(env.SECRET_PEPPER, g.id), venue: g.venue, city: g.city, starts_at: visitor ? null : g.starts_at,
    party: g.rsvp === 'yes' && g.attending ? g.attending : g.party_size, table: g.table_label, host: g.host, valid_from: g.valid_from, valid_until: g.valid_until
  });
}
