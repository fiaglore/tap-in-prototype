// Ticket transfers (dossier 4.5): verify the original ticket, revoke it, issue a replacement to the recipient, record it.
// The old pass is revoked and a NEW pass id is issued, so the old QR code (or a screenshot of it) stops working at once.
import { HttpError, newId, nowSec, parseIdentifier } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { hashInvite, inviteHint, makeInviteCode, tierCode } from '../lib/codes.js';
import * as limits from '../lib/limits.js';

// POST /api/me/passes/:id/transfer  { to: "phone or email" }
export async function transferPass({ request, env, user, params }) {
  const b = await readJson(request);
  const to = parseIdentifier(b.to);
  if (!to) throw new HttpError(400, 'invalid_recipient', 'Enter the phone number or email of the person receiving the ticket.');
  if ([user.phone, user.email].includes(to.value)) throw new HttpError(400, 'transfer_to_self', 'That is your own phone number or email.');
  if (await limits.isFull(env.DB, 'transfer:' + user.id, 10, 86400)) throw new HttpError(429, 'rate_limited', 'Too many transfers today. Try again tomorrow.');

  const p = await env.DB.prepare(
    `SELECT p.id, p.event_id, p.tier_id, p.expires_at, p.order_id, e.kind, e.allow_transfers, e.prefix, e.starts_at, t.name AS tier_name
     FROM passes p JOIN events e ON e.id = p.event_id JOIN tiers t ON t.id = p.tier_id
     WHERE p.id = ?1 AND p.user_id = ?2 AND p.status = 'active'`
  ).bind(String(params.id).slice(0, 40), user.id).first();
  if (!p) throw new HttpError(404, 'not_found', 'Ticket not found.');
  if (p.kind !== 'event') throw new HttpError(409, 'not_transferable', 'Office and campus passes cannot be transferred.');
  if (!p.allow_transfers) throw new HttpError(409, 'transfers_off', 'The organiser has turned off ticket transfers for this event.');
  const used = await env.DB.prepare(`SELECT COUNT(*) AS n FROM scans WHERE pass_id = ?1 AND result = 'granted'`).bind(p.id).first();
  if (used.n > 0) throw new HttpError(409, 'already_used', 'This ticket has already been used, so it cannot be transferred.');

  const recipient = await env.DB.prepare(`SELECT id FROM users WHERE ${to.kind === 'phone' ? 'phone' : 'email'} = ?1 AND suspended_at IS NULL`).bind(to.value).first();
  const old = await env.DB.prepare('SELECT invite_id FROM passes WHERE id = ?1').bind(p.id).first();

  // Revoke the original first, and only one request can win this: a double-tap or two devices cannot send the ticket twice.
  const rev = await env.DB.prepare(`UPDATE passes SET status = 'revoked' WHERE id = ?1 AND status = 'active' AND user_id = ?2`).bind(p.id, user.id).run();
  if (rev.meta.changes !== 1) throw new HttpError(409, 'already_transferred', 'This ticket was already transferred.');

  const now = nowSec();
  const code = makeInviteCode({ prefix: p.prefix, year2: String(new Date((p.starts_at || now) * 1000).getUTCFullYear()).slice(-2), tier: tierCode(p.tier_name) });
  const inviteId = newId(12);
  const newPassId = newId(10);
  const transferId = newId(12);
  try {
    const stmts = [
      env.DB.prepare(`UPDATE invites SET status = 'revoked' WHERE id = ?1`).bind(old.invite_id),
      env.DB.prepare(
        `INSERT INTO invites (id, event_id, tier_id, code_hash, code_hint, label, bound_identifier, status, claimed_by, claimed_at, order_id, access_until, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'Transfer', ?6, ?7, ?8, ?9, ?10, NULL, ?11`
      ).bind(inviteId, p.event_id, p.tier_id, await hashInvite(env.SECRET_PEPPER, code), inviteHint(code),
        recipient ? null : to.value, recipient ? 'claimed' : 'unused', recipient ? recipient.id : null, recipient ? now : null, p.order_id, now)
    ];
    if (recipient) {
      stmts.push(env.DB.prepare(`INSERT INTO passes (id, event_id, tier_id, user_id, invite_id, status, created_at, expires_at, order_id) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8)`)
        .bind(newPassId, p.event_id, p.tier_id, recipient.id, inviteId, now, p.expires_at ?? null, p.order_id));
    }
    stmts.push(env.DB.prepare(
      `INSERT INTO transfers (id, event_id, from_user_id, to_identifier, to_user_id, old_pass_id, new_pass_id, invite_id, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    ).bind(transferId, p.event_id, user.id, to.value, recipient ? recipient.id : null, p.id, recipient ? newPassId : null, inviteId, recipient ? 'completed' : 'waiting', now));
    await env.DB.batch(stmts);
  } catch (e) {
    // Put the sender's ticket back rather than leave it in nobody's hands.
    await env.DB.batch([
      env.DB.prepare(`UPDATE passes SET status = 'active' WHERE id = ?1`).bind(p.id),
      env.DB.prepare(`UPDATE invites SET status = 'claimed' WHERE id = ?1`).bind(old.invite_id)
    ]);
    throw e;
  }
  await limits.record(env.DB, 'transfer:' + user.id);
  return json({ transfer: { id: transferId, status: recipient ? 'completed' : 'waiting', to: to.value } }, 201);
}

// GET /api/me/transfers  -> tickets I sent
export async function myTransfers({ env, user }) {
  const rows = (await env.DB.prepare(
    `SELECT t.id, t.to_identifier, t.status, t.created_at, e.name AS event_name
     FROM transfers t JOIN events e ON e.id = t.event_id WHERE t.from_user_id = ?1 ORDER BY t.created_at DESC LIMIT 50`
  ).bind(user.id).all()).results;
  return json({ transfers: rows });
}
