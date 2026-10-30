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

## Tap In for Business (offices)

Offices are sold as a separate product, **Tap In for Business**: the landing page is `/business/` and its console is `/offices/`. The homepage is about event ticketing and entry; it links to Business once, near the bottom.


An office is an event with `kind = "workplace"`, so it reuses passes, doors (zones), the gate scanner and the scan log.

- **Doors and access groups.** Offices have their own console at `/offices/`, separate from the organiser (`/organiser/`, events only). Each access group (Staff, Contractor, Visitor) opens certain doors and can be limited to days and hours, read in Lagos time (`events.tz_offset_min`, default +60). Overnight shifts are not supported yet.
- **Adding people.** `POST /api/events/:id/people` takes `{ tier_id, people: [{ contact, name? }], access_until? }`. Each person gets an invite tied to their own phone or email, which appears in their Tap In app after they sign in. Bad and duplicate contacts are reported back, not fatal.
- **Visitors and contractors.** `access_until` is copied onto the pass when it is claimed; the gate refuses it afterwards (`expired`). Outside a group's hours the gate answers `outside_hours`.
- **Offboarding.** Cancelling a pass (Who has access) shuts the door at the next scan.
- Staff can enter again and again; offices ignore the event "re-entry" rule.

Migration `0003_workplaces.sql` adds the columns. Apply it with `npm run db:migrate:remote` before deploying.

## Events and concerts (phase 2)

- **Ticket limits.** A ticket type can have a limit (the most tickets that may be issued; cancelled invites free their place). It is checked inside the database insert, so two buyers cannot both take the last ticket, and a batch that does not fit issues nothing (`409 sold_out`). Organisers change limits and prices in the Tickets tab (`PATCH /api/events/:id/tiers/:tierId`); a limit cannot go below what is already issued. The public page shows "Sold out", and "Only N left" once it is 20 or fewer, and never the real counts.
- **Sales window.** `sales_start` and `sales_end` limit when the public page sells (`sales_not_open`, `sales_closed`). Organisers can still issue codes themselves outside it. `sales_start` cannot be later than the event's date (`sales_open_after_event`), when creating, editing the window, or moving the event earlier; the date boxes in the console enforce it too.
- **Live QR.** Turn on `secure_qr` for an event and the app never receives the permanent pass code. It asks `GET /api/me/passes/:id/live` every 20 seconds for a code that is good for about 90 seconds, so a screenshot is useless almost at once. The gate refuses the permanent code on such an event (`static_pass`) and old codes (`stale_code`). Phones need a connection at the gate, so it is off by default.

Migration `0005_event_sales.sql` adds the columns.

## The Play page (public events)

`/play/` lists upcoming events, and each card opens that event's own ticket page (`/e/?id=...`). `GET /api/public/events` returns only events with `listed = 1` that are upcoming (until about 12 hours after they start; undated events stay), soonest first, up to 60, with just a name, venue, city, date, sales state, a sold-out flag and the cheapest price. No codes, keys or counts. New events are listed by default and the organiser can untick "Show on the public Play page" for a private event (in the create form, or later in the event's Gate key & rules tab). Offices are never listed, and events that existed before migration `0007_listed_events.sql` stay unlisted until their organiser turns it on. The organiser console shows its sign-in at the top of the page.

## Selfie on the pass

A pass is only as good as the check at the door, and a name alone cannot be matched to a face. With **Selfie check** on (a setting per event or office; offices default to on), a person adds a selfie when they claim a pass, and door staff see it next to their name on every scan.

- **Capture.** In the app (and on the ticket page) the browser opens the camera, crops the picture square, shrinks it to 256px and re-encodes it as a JPEG (which drops camera metadata such as GPS). If the camera is unavailable there is a file-picker fallback. `js/selfie.js`.
- **Claiming.** If the event asks for a photo and the person has none, `/api/claim` and the public buy endpoint answer `428 photo_required` *without* using up the invite; the app takes the selfie and retries.
- **At the gate.** The scan response carries `photo` (a data URL) for every scan of a known pass at that event, refusals included, because a refused "already used" scan shown with the face is how staff spot a shared screenshot. `photo_new` flags a photo added or changed in the last 24 hours, and `photo_missing` flags a pass with no photo (so staff check ID instead).
- **Storage and privacy.** One small photo per person in `user_photos` (base64 text, 60 KB limit, validated server-side: JPEG only, 96 to 640 px, no EXIF/XMP/comment segments). It is returned only to its owner (`GET/PUT/DELETE /api/me/photo`) and inside a gate scan for an event that asks for it. Organisers see only whether a photo is on file; it is never listed, exported or shown to other events. People can delete theirs any time (Me tab). Changing it is limited to 6 a day, and the daily clean-up deletes a photo a month after it was last set unless its owner still has an active office pass or a recent event pass.

**What it does not do.** It does not prove the photo is of the account holder or that a real person took it (there is no liveness check), so someone who deliberately uploads another person's face can still pass it on. It makes casual sharing, screenshots and resale visible and awkward, and the "photo changed recently" flag makes a last-minute swap stand out. A face photo is sensitive personal data: tell people why you collect it, and take advice on Nigerian data-protection rules before relying on it.

Migration `0006_photos.sql` adds `events.require_photo` and the `user_photos` table.

## Payments (phase 3: customers and vendors)

**Withdrawn for now.** `PAYMENTS_MODE` is `off` in `wrangler.jsonc` until a licensed payment partner is signed: the wallet tab is hidden in the app, `/vendor/` and `/till/` answer with the not-found page, and every wallet, vendor and till API route returns `404 payments_unavailable`. Ticketing is unaffected. Set it back to `demo` to bring the demo back.

**Demo money only.** In `demo` mode wallets hold play money, top-ups and payouts are only recorded, and nothing real moves. In `live` mode the server refuses top-ups and payouts (`501 payments_not_connected`) until a payment provider is wired in. Holding or moving real customer money in Nigeria also has regulatory requirements (licensing, KYC, settlement through a licensed partner), so take advice before going live.

- **Customer** (`/app/`, Wallet tab): a balance, demo top-ups, and "Pay a vendor". The customer enters an amount and shows a pay code (QR). The amount is inside the signed code, so the vendor can only charge exactly that, the code works once, and it expires after about 5 minutes.
- **Vendor** (`/vendor/`): create a business and get a till key (shown once, stored only as a hash). See sales, refund a payment (once, out of the business balance), record a payout, make a new till key, and choose whether to appear in the public "Tap In enabled" list.
- **Till** (`/till/`): a device enters the till key, then scans or types the customer's pay code. The till never sees the customer's balance.
- **API:** `GET /api/wallet`, `POST /api/wallet/topup`, `POST /api/wallet/pay-code`; `GET/POST /api/vendors`, `GET/PATCH /api/vendors/:id`, `POST /api/vendors/:id/{till-key,refunds,payout}`; `GET /api/till/info`, `POST /api/till/charge`; `GET /api/public/vendors`.
- **Money safety.** Amounts are integer kobo. Every movement is one database batch (one transaction) with its ledger row. Balances have `CHECK (>= 0)`, so the database itself refuses an overdraft, even when two payments race. A unique index makes a pay code chargeable once, and another allows one refund per payment. A test checks that wallets + vendor balances + payouts always equal top-ups.

Migration `0004_payments.sql` creates `wallets`, `vendors` and `ledger`.

## Editing an event after setup

Console tab **Edit details** (events and offices):
- Name, venue, city and date (`PATCH /api/events/:id`). The invite-code prefix stays as it was, so codes issued
  before a rename keep working.
- Areas (doors): add, rename, and remove until someone has been scanned there and as long as no ticket type is left
  without an area (`POST /api/events/:id/zones`, `PATCH|DELETE /api/events/:id/zones/:zoneId`).
- Ticket types (access groups): rename, change which areas they open and, for offices, the days and hours
  (`PATCH /api/events/:id/tiers/:tierId`); add new ones with price and limit (`POST /api/events/:id/tiers`); remove one
  only while nothing has been issued for it (`DELETE …/tiers/:tierId`). Area and hour changes apply at the next scan.

## Attendance (Tap In for Business)

Console tab **Attendance** (offices): pick a range (this week, last 7 days, last week, this month, last month, or any
dates up to 92 days) and a grace period. Days are in the office's time zone.
- Per person: days in against days expected (their group's working days), attendance %, late days (first scan after
  the group's start time plus the grace), average arrival, and, for 14 days or fewer, the arrival time each day.
  Groups with no set hours are never late. There is no exit scan, so "last seen" is the last door used, not a leaving time.
- Per day: expected, in, late, visitors. Visitors (invited and walk-in) are listed separately.
- People given access who have not added their pass yet are counted separately, not as absent.
- CSV: `/api/events/:id/attendance.csv?type=daily|summary|visitors&from=YYYY-MM-DD&to=YYYY-MM-DD&grace=15`
  (daily rows, one row per person, or the visitor log), formula-safe.

## Visitors (Tap In for Business)

Visitors are guests of kind `visitor` (migration 0010 adds `host`, `purpose`, `valid_from`, `valid_until`, `walk_in`).
- **One-tap visitor link** (console tab **Visitors**): name, phone or email, who they are visiting, reason, the visit
  window (default: the rest of today, office time) and the group (which doors). The visitor opens `/i/#<token>` (no app,
  no account) and shows the QR. The gate refuses it before the window (`outside_hours`) and after it (`expired`).
- **Walk-in check-in** (door scanner, offices only): name, who they are visiting, phone (optional), reason, group.
  `POST /api/gate/walkin` records the visitor, lets them in at that door against the signed-in steward, and returns a
  link valid to the end of the day (with a "Send their pass on WhatsApp" button). Walk-ins need a connection.
- The Visitors tab lists today, upcoming and the past 30 days, with who they visited, how they came (invited or walk-in)
  and when they arrived. Host notifications need an SMS or email provider, which is not connected yet.

## Apple Wallet and Google Wallet

"Add to Apple Wallet" and "Save to Google Wallet" appear on Tap In passes, invitations and visitor passes once the
credentials below are set as Worker secrets (`npx wrangler secret put NAME`); until then they are hidden and the
endpoints answer `404 wallet_not_set_up`. The wallet pass carries the same code as the Tap In pass, so the gate needs
no changes. Live-QR events are not offered (a wallet pass cannot change its code every 30 seconds).

**Apple** (needs an Apple Developer account):
1. Certificates, Identifiers & Profiles: create a Pass Type ID (e.g. `pass.world.tap-in`), then a Pass Type ID
   certificate for it, and download Apple's WWDR intermediate certificate (G4).
2. Export the certificate and key as PEM: `openssl pkcs12 -in pass.p12 -clcerts -nokeys -out pass-cert.pem` and
   `openssl pkcs12 -in pass.p12 -nocerts -nodes -out pass-key.pem`; `openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem`.
3. Secrets: `APPLE_PASS_TYPE_ID`, `APPLE_TEAM_ID`, `APPLE_PASS_CERT` (pass-cert.pem), `APPLE_PASS_KEY` (pass-key.pem,
   PKCS #8 or PKCS #1), `APPLE_WWDR_CERT` (wwdr.pem).

The `.pkpass` (`src/lib/wallet.js`, `zip.js`, `cms.js`) is a stored ZIP with a SHA-1 manifest and a detached CMS
signature made with WebCrypto; `test/wallet.mjs` verifies it with openssl using a throwaway certificate.

**Google** (needs a Google Wallet issuer account, approved by Google for public use):
1. In the Google Pay & Wallet Console, note the Issuer ID. In Google Cloud, create a service account, enable the
   Google Wallet API, add the service account as a user of the issuer, and download its JSON key.
2. Secrets: `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SERVICE_ACCOUNT` (the whole JSON key).
The link is a signed "save to wallet" JWT that carries a generic class and object; no other API call is needed.

## Gate team and the event report

- **Gate team** (console tab; "Door staff" for offices): the organiser adds each steward by name and gets a one-time
  scanner link and QR code (`/gate/#k=ST-…`). Opening it signs that phone's scanner in as the steward and keeps it
  signed in. Only a scrambled copy of the key is stored, and removing a steward stops their scanner at the next scan.
  Every scan records `steward_id`; the shared gate key still works as a backup and its scans show as "Shared gate key".
- **Report** (console tab): tickets issued and used, no-shows, refusals grouped as fake / reused / screenshot /
  cancelled / wrong area / wrong time, an estimated "value protected" (fake + reused + screenshot attempts × average
  paid ticket price), the busiest minute, entries over time, each steward's lane (admits, refusals, busiest minute,
  average per busy minute), and "worth a look" prompts (shared-key scans, a steward who never refuses while others do,
  tickets shown again 3+ times, bursts of fake codes). Printable, and `/api/events/:id/scans.csv` exports every scan
  (no phone numbers or emails; formula-safe cells).

## Guest lists: invitations and imported tickets

Both live in the `guests` table (migration 0009) and need no Tap In account. Console tab: **Guest list**.

- **Invitations** (weddings, parties, launches). The host adds guests, one per line: name, phone or email, party
  size (1 to 20), table. Each guest gets a link (`/i/#<token>`, sent by copy, WhatsApp, or the CSV of links). The
  invitation page shows the event, their party and table, takes the RSVP (yes with how many, or no), and shows the
  entry QR (`TG-…`). One scan lets the whole party in (the RSVP number if they answered, otherwise the party size).
  Link and code are derived from the guest id with HMAC, so nothing secret is stored; cancelling the guest stops both.
  New event form: "Start from the private-event setup" pre-fills one entrance, a free Guest ticket, unlisted.
- **Imported tickets** (sold on another platform, Instagram, bank transfer). Paste or upload a CSV; columns are found by
  header (code / barcode / reference, name, ticket type) or assumed in that order. Codes are stored as
  HMAC(pepper, event + code), normalised for case, spaces and dashes, and are only valid at that event. A ticket type
  named in the list is matched to the event's; otherwise the chosen default is used. Repeats are skipped.
- At the gate, the scanner accepts Tap In passes, invitation codes and imported codes, with the same rules (area,
  re-entry, single use, cancelled). The camera also reads common barcodes (Code 128, EAN-13, PDF417 and others) where
  the phone supports them. Guests are counted in the overview, report and CSV.

## Offline gates

- **Passes.** The app keeps the signed-in person's passes on the phone (cleared on sign out) and a service worker
  (`/app/sw.js`) keeps the app itself, so passes open with no signal. Live passes come with a rolling key
  (`roll_key` in `/api/me`); the phone makes a new `TR-…` code every 30 seconds from it, corrected by the server time,
  so screenshots still go stale with no connection. Key chain: event offline key = HMAC(pepper, "offline|" + event),
  pass key = HMAC(event key, "pass|" + pass), code mac = HMAC(pass key, "roll|" + window). The gate accepts `TQ`
  (server-made) and `TR` codes.
- **Scanners.** A signed-in scanner downloads the event's list every minute (`GET /api/gate/list`: rules, tickets with
  first name and initial, entries so far, imported-code hashes, the event offline key) and keeps it on the phone, with
  a service worker (`/gate/sw.js`) for the page. With no signal (or no answer within 6 seconds) it decides each scan
  itself with the server's rules (`public/js/offline.js` mirrors `codes.js` and `schedule.js`, and a test checks they
  agree), queues it, and sends the queue with `POST /api/gate/sync` when the signal returns. Offline scans are stored
  with an `OF` id prefix and the steward; resending is harmless.
- **Limits.** Scanners that are offline at the same time cannot see each other's entries: a ticket let in at two of
  them is recorded with reason `offline_duplicate` and flagged in the report. Offline, a plain `TP`/`TG` code is
  accepted if its ticket is on the list (its mac needs the server's secret), and server-made `TQ` codes are refused as
  out of date (the app shows `TR` codes). Photos are not downloaded; offline scans at photo events say "check ID".
  Removing a steward takes effect at their next sync.

## Link previews, privacy and terms

- Every public page has Open Graph tags and the share image `public/og.png` (1200x630). Static pages point at
  `https://www.tap-in.world` (the custom domain; `tap-in.world` redirects to it). Change them if the domain changes.
- Ticket sales pages (`/e/?id=…`) get the event's name, place and date written into their title and preview tags by
  the Worker (`salePageHtml` in `src/routes/public.js`), using the host the link was opened on.
- `/privacy/` and `/terms/` are plain pages linked from the footers, every sign-in form and the app's Me tab.
  They describe what the code actually stores; update them whenever that changes. Contact: hello@tap-in.world.

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

**Email without a domain (Firebase).** Set `OTP_MODE` to `firebase` and `FIREBASE_API_KEY` to your Firebase Web API key. Firebase emails a sign-in link (not a 6-digit code); the link opens `/signin/`, and the Worker confirms it with Google. Phone numbers are refused in this mode. In Firebase: Authentication > Sign-in method > enable *Email link (passwordless)*, and add `www.tap-in.world` (and any other host you use) under Settings > Authorized domains.

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
