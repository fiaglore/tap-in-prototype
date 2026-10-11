# Tap In server

One Cloudflare Worker serves both the website (`public/`) and the API (`/api/*`). Data lives in a D1 (SQLite) database.

| Page | Path | Who it is for |
|------|------|---------------|
| Landing | `/` | Everyone |
| Attendee app | `/app/` | Short onboarding, register, add an invite code, "Around me" view of your passes, show a pass (QR), customise your card |
| Organiser console | `/organiser/` | Sidebar console: create events, generate invite codes, attendees, live numbers, gate key |
| Gate scanner | `/gate/` | Door staff: scan or type a pass, see admit / do not admit |

The card design (colours, finish, pattern, name) is appearance only and is saved in the browser on that device, not on the server.

## How codes are generated on the back end

Everything random comes from the Workers Web Crypto source (`crypto.getRandomValues`), never `Math.random`. Nothing secret is stored in the clear: the database holds HMAC-SHA-256 hashes keyed with a server-only secret (`SECRET_PEPPER`), so a leaked database cannot be turned back into working codes or tested offline.

| Thing | Format | How it is made | What is stored |
|-------|--------|----------------|----------------|
| Invite code | `PGF-26-VIP-7K4Q-9XM2` | Event prefix (initials of the event name), 2-digit year, ticket-type code, then 8 random characters from a 32-character alphabet with no look-alikes (40 bits). Duplicates are caught by a UNIQUE index and regenerated. | `HMAC(pepper, "invite|" + normalised code)` and the last 4 characters as a hint. The plain code is returned once, when generated. |
| Sign-in code (OTP) | 6 digits | Rejection sampling over random bytes, so every digit is equally likely. Valid 10 minutes, 5 guesses, 3 requests per 15 minutes per phone or email. | `HMAC(pepper, identifier + code)`. A new request cancels the old code. |
| Pass | `TP-XXXXX-XXXXX-XXXXX-XXXXX` | `TP` + the pass's random 10-character id + a 10-character check value (first 50 bits of `HMAC(pepper, "pass|" + id)`). Shown as a QR code. | Only the id. The check value is recomputed at the gate, so a forged or edited pass is rejected before the database is touched. |
| Gate key | `GK-XXXX-...` (6 groups) | 24 random characters (120 bits). | Hash and last 4 characters. Rotating it retires the old key instantly. |
| Session | cookie `tapin_session` | 32 random bytes, HttpOnly, SameSite=Lax, 30 days. | Hash only. |

Why a keyed hash and not a plain one: a 6-digit code has only a million possibilities and a 40-bit invite is small enough to enumerate, so plain SHA-256 values could be cracked in seconds if the database leaked. With the secret key they cannot be.

Typing is forgiving: codes are normalised (case, spaces and dashes ignored, `O` read as `0`, `I`/`L` read as `1`) before hashing.

### Race safety

Two people claiming one code, or two gates scanning one pass, are settled by the database, not by application checks:

- Claim: one batch inserts the pass only if the invite is still unused and marks it claimed. `passes.invite_id` is UNIQUE.
- Entry: a partial unique index allows one granted entry per pass per area (unless the event allows re-entry). The second scan hits the constraint and is answered "already used".

## API

Cookie-authenticated unless noted. JSON in, JSON out. Errors look like `{"error":{"code","message"}}`.

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/config` | Mode and whether the server is configured (no auth) |
| `POST /api/auth/otp/request` `{identifier}` | Send a sign-in code (demo mode returns `dev_code`) |
| `POST /api/auth/otp/verify` `{identifier, code}` | Sign in or register; sets the session cookie |
| `POST /api/auth/logout`, `PATCH /api/me`, `GET /api/me`, `GET /api/me/history` | Account |
| `POST /api/claim` `{code}` or `{invite_id}` | Turn an invite into a pass |
| `GET/POST /api/events`, `GET/PATCH /api/events/:id` | Organiser: events |
| `POST /api/events/:id/invites` `{tier_id, count, label?, bound_to?, expires_at?}` | Generate codes (up to 500 per call) |
| `GET /api/events/:id/invites`, `.../invites/:id/revoke` | List and cancel |
| `GET /api/events/:id/attendees`, `POST .../passes/:id/revoke` | Attendees |
| `POST /api/events/:id/gate-key` | Rotate the gate key |
| `GET /api/gate/info`, `POST /api/gate/scan` `{token, zone_id}` | Gate, with `Authorization: Bearer <gate key>` |

## Deploy

The database `tap-in-db` already exists and has the schema applied (migration `0001_init.sql`). To put the Worker and site live:

```bash
cd worker
npm install
npx wrangler login
openssl rand -base64 48 | npx wrangler secret put SECRET_PEPPER   # set once; never change it casually
npx wrangler deploy
```

Or connect the GitHub repo in the Cloudflare dashboard (Workers Builds), set **Root directory** to `worker`, and add `SECRET_PEPPER` under Settings, Variables and Secrets.

**Keep `SECRET_PEPPER` safe.** Changing or losing it invalidates every invite code, pass, gate key and sign-in code already issued. The server refuses to run (503) until it is set.

New migrations go in `migrations/` and are applied with `npm run db:migrate`.

## Going live with real sign-in codes

`OTP_MODE` is `demo` in `wrangler.jsonc`: no message is sent and the code is shown on screen. That is fine for trying the product, but anyone could then sign in as any phone number or email. Before real use, implement `sendSms` / `sendEmail` in `src/lib/otp-delivery.js` with a provider (for Nigeria, a local SMS aggregator or Termii/Twilio; Resend or Postmark for email), set `OTP_MODE` to `live`, and keep the secret keys as Worker secrets. In `live` mode the server refuses to send until a provider is wired in; it never falls back to demo.

To limit who can create events, set `ORGANISER_IDENTIFIERS` to a comma-separated list of phone numbers (+234...) or emails.

## Limits worth knowing

- A phone cannot act as a tap-to-enter NFC card from a web page. Today the gate reads the QR (camera on supported browsers, USB scanner, or typed code). Tap-to-enter needs a native app.
- Passes are a static QR: a screenshot works until the holder is scanned in. Rotating, time-limited QR codes are a sensible next step.
- Rate limits use the database, which is good enough for one event; very large events should move them to Durable Objects or Cloudflare's rate-limiting rules.

## Develop and test

```bash
node test/smoke.mjs         # 50 checks against the real Worker code using a SQLite stand-in for D1
node test/dev-server.mjs    # whole site on http://localhost:8787 (same code, in-memory database)
npx wrangler dev            # the real runtime (needs npm install)
```
