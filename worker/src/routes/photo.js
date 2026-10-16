// A person's own selfie. They can read, replace and delete it; nobody else can read it through the API.
// Door staff see it only inside a gate scan response (routes/gate.js), and only for events that ask for it.

import { HttpError, nowSec } from '../lib/util.js';
import { json, readJson } from '../lib/http.js';
import { checkPhoto, photoDataUrl } from '../lib/photo.js';
import { take } from '../lib/limits.js';

// GET /api/me/photo
export async function getPhoto({ env, user }) {
  const row = await env.DB.prepare('SELECT jpeg_b64, updated_at FROM user_photos WHERE user_id = ?1').bind(user.id).first();
  return json({ photo: row ? photoDataUrl(row.jpeg_b64) : null, updated_at: row ? row.updated_at : null });
}

// PUT /api/me/photo  { image }
export async function putPhoto({ request, env, user }) {
  const body = await readJson(request, 100_000);
  const p = checkPhoto(body.image);
  // Changing a photo is allowed, but not over and over: a swapped-in photo is the one way to defeat the check.
  if (!(await take(env.DB, 'photo:' + user.id, 6, 86400))) {
    throw new HttpError(429, 'rate_limited', 'You have changed your photo a lot today. Try again tomorrow.');
  }
  await env.DB.prepare(
    `INSERT INTO user_photos (user_id, jpeg_b64, bytes, updated_at, set_count) VALUES (?1, ?2, ?3, ?4, 1)
     ON CONFLICT (user_id) DO UPDATE SET jpeg_b64 = ?2, bytes = ?3, updated_at = ?4, set_count = set_count + 1`
  )
    .bind(user.id, p.b64, p.bytes, nowSec())
    .run();
  return json({ ok: true, updated_at: nowSec() }, 200);
}

// DELETE /api/me/photo
export async function deletePhoto({ env, user }) {
  await env.DB.prepare('DELETE FROM user_photos WHERE user_id = ?1').bind(user.id).run();
  return json({ ok: true });
}
