# 01. Technical audit

## 1. Summary

Tap In today is a **working entry-control product with a demo-grade commercial layer**. The door side is strong: tickets are cryptographically checked, duplicate entry is blocked atomically, scanners work offline with a documented consistency limit, and the team has a console with an audit log. The money side is not real: ticket checkout takes no payment, SMS is not connected, and there are no refunds, transfers, settlements or webhooks for tickets.

**Most urgent finding (F1):** the public "Get ticket" endpoint issues tickets for *paid* tiers without any payment. It is not covered by `PAYMENTS_MODE=off`. Combined with F2 (anyone who signs in can create and publicly list events), this is a fraud route on the live site today.

## 2. Architecture as built

| Layer | What is used | Notes |
|-------|--------------|-------|
| Hosting | Cloudflare Worker with static assets (`worker/wrangler.jsonc`) | One production deployment. Cron once a day (03:17 UTC) clears expired sessions, codes, rate-limit rows and old photos. Observability on, no alerting |
| Backend | JavaScript on the Worker, about 4,600 lines, no framework, **zero runtime dependencies** | Routes in `src/routes/*.js`, one route table in `src/index.js` |
| Database | Cloudflare D1 (SQLite), 13 migrations, applied by hand with wrangler | Single writer. See F10 |
| Web | Plain HTML, CSS and JavaScript, no build step | Pages for guests, organisers, gate, business, admin, app |
| Phone app | Capacitor shell (`mobile/`) that loads the website. Android builds as a **debug** APK on GitHub Actions. iPhone project exists, not built or signed | Native extras are limited to share, status bar, splash, haptics |
| Sign-in | Passwordless. Modes `demo`, `firebase` (email link through Firebase), `live` (not implemented) | No passwords exist, so "recover passwords" does not apply |
| Money | `PAYMENTS_MODE=off` in `wrangler.jsonc`: wallet, vendors and tills are withdrawn | Ticket sales are separate and are **not** covered by this switch (F1) |

## 3. Database and data model

Core tables: `users`, `sessions`, `otps`, `rate_events`, `events`, `zones`, `tiers`, `tier_zones`, `invites`, `passes`, `scans`, `stewards`, `guests`, `user_photos`, `app_logins`, `audit_log`, plus the demo money tables `wallets`, `vendors`, `ledger`.

- Invite codes, sign-in codes, gate keys and steward keys are stored only as keyed hashes (HMAC with a secret pepper). A database leak does not reveal a usable code. *Verified.*
- Pass tokens are derived from the pepper, not stored. *Verified.*
- Ticket capacity is enforced inside the insert statement, so two buyers cannot take the last ticket. *Verified (events suite).*
- A unique index on `scans` stops the same pass entering the same zone twice, atomically, even with two scanners online. *Verified (smoke and offline suites).*
- Money is stored in kobo (integers). *Read.*
- Selfie photos are stored as base64 JPEG inside D1 (`user_photos`). They are personal data (F12).
- There is no `payments`, `orders`, `refunds` or `transfers` table for tickets. The `ledger` table exists for the demo wallet only.

## 4. Authentication and sessions

- Sessions use an opaque token, stored hashed, in an `HttpOnly; SameSite=Lax; Secure` cookie. *Verified.*
- Email sign-in works through Firebase. Phone numbers are **refused** in `firebase` mode and SMS sending throws "not set up" in `live` mode (F4).
- Rate limits cover sign-in codes (12 per 15 minutes per address), gate keys and unreadable scans. *Verified.*
- Staff console: allow-list secret, verified modes only, 8-hour sessions, uniform 404, mandatory reasons, audit log. No MFA (F5).
- Account deletion and suspension exist, and share one code path. *Verified.*

## 5. Tickets, QR codes and verification

- **Static pass:** `TP-…` token, 50-bit MAC derived from the pepper. Verified at the gate before the database is touched.
- **Live pass (per-event option `secure_qr`):** server-made `TQ` code, or phone-made `TR` rolling code refreshed every 30 seconds, so screenshots go stale. *Verified.*
- **Guest tickets and invitations** (no account), imported tickets from other ticketers, wristbands. *Verified.*
- **Re-entry** is an explicit per-event switch. Used tickets are refused otherwise.
- Verification records are written on every scan, granted or denied, with the steward.
- The QR carries no personal data. The gate shows first name and initial, and a photo only when the organiser requires one.

## 6. Offline operation

A scanner downloads the event list every minute, decides scans itself with the server's rules when offline, queues them, and syncs later. A test checks the offline rules match the server rules. Two scanners offline at the same time cannot see each other; a double entry is recorded as `offline_duplicate` and flagged in the report. This matches the dossier's own "critical limitation" wording and the product does not claim real-time shared visibility. *Verified (offline suite).* Gaps: no per-gate ticket ranges or reserved permissions (the dossier's consistency strategies), and no encrypted local database on the scanner phone (F14).

## 7. Organiser and business functions

Present: create and edit events, zones, ticket types with price, capacity, sale window and time rules; invites and complimentary codes; guest lists and CSV import; stewards (scanners) with their own keys; live numbers, scan log, attendance and scan CSVs; photo requirement; Tap In for Business (offices, visitors, attendance). Not present: discount codes, PDF reports, revenue analytics (nothing is paid), refunds, transfers, settlements, reserved seating.

## 8. APIs and third-party integrations

- 94 internal routes in one table. They are for Tap In's own pages and are undocumented. There is **no public API, no API keys, no webhooks, no sandbox**.
- Third parties actually used: Cloudflare (hosting, D1), Firebase Authentication (email link), Google Fonts (page fonts), Apple Wallet and Google Wallet pass code exists and stays hidden until certificates and keys are set as secrets (not set).
- Not integrated: any payment provider, SMS, WhatsApp, email-sending service, NFC.

## 9. Hosting, deployment and monitoring

- One environment. Deploys run from a developer session with `wrangler deploy`, migrations applied by hand first. No staging, no preview deploys. (F6)
- The only GitHub workflow builds the Android app. **The 20 test suites do not run in CI.**
- Logs go to Cloudflare observability. No alerts, uptime check or error tracking. (F6)
- Backups rely on Cloudflare D1 Time Travel. Retention and a restore drill are unverified. No scheduled export. (F7)

## 10. Security review

Strong: keyed hashing of every secret, derived pass tokens, per-IP and per-identity rate limits, strict Content-Security-Policy and other headers, no runtime dependencies (small attack surface), account deletion, uniform refusals on the staff console.

Weak or missing: see findings. No independent penetration test has been done.

## 11. What is demo-only or non-production

| Item | Where | Effect |
|------|-------|--------|
| Ticket checkout "Demo checkout, no real payment" | `src/routes/public.js` `buy`, `public/e/sale.js` | Issues tickets free |
| Wallet, vendors, tills | `src/routes/wallet.js`, `vendors.js`, `till.js` | Play money. Withdrawn by `PAYMENTS_MODE=off` |
| `OTP_MODE=demo` | `src/lib/otp-delivery.js` | Shows the code on screen. Production uses `firebase` |
| Privacy and terms text | `public/privacy`, `public/terms` | Say "in development" and "demo mode" |
| Android debug build | `.github/workflows/mobile.yml` | Not signed for release |

## 12. Findings

Severity: **Critical** can cause direct loss now, **High** blocks launch, **Medium** should be fixed before launch, **Low** should be tracked.

| ID | Severity | Finding | Evidence | Recommended action |
|----|----------|---------|----------|--------------------|
| F1 | **Critical** | `POST /api/public/events/:id/buy` issues tickets for paid tiers with no payment. `PAYMENTS_MODE=off` only blocks wallet, vendor and till routes (`PAYMENT_API` regex in `src/lib/money.js`) | Code read. The events and play suites buy tickets with no payment step. Priced tiers are created by default in the play suite | Stop-gap now: refuse purchases of any tier with `price_kobo > 0` until a verified payment exists. Real fix is Step 2 |
| F2 | **High** | `ORGANISER_IDENTIFIERS` is empty in production config, so any signed-in person can create events, and events are public on `/play/` by default | `wrangler.jsonc`, `events.js` `assertOrganiser` and `listed` default | Fill the organiser allow-list, or approve new organisers, or default new events to unlisted. The team console can already unlist |
| F3 | **High** | No ticket payment pipeline: no provider, webhook, order, refund, ledger, commission or settlement for tickets | No such tables or routes | Build in Step 2 |
| F4 | Medium | Phone sign-in is unavailable. SMS sending is a stub. Email works through Firebase links only | `otp-delivery.js`, `firebase.js` | Add an SMS provider in Step 2. Add a transactional email sender |
| F5 | Medium | No multi-factor authentication for organisers or staff. Staff security is email link plus allow-list | Read | Add MFA or Cloudflare Access in front of `/admin/*` |
| F6 | Medium | No CI for tests, no staging environment, hand-run migrations, no alerting | `.github/workflows` has only the mobile build | Add CI, a staging Worker with its own D1, and alerts |
| F7 | Medium | Backup and restore not verified or documented | No export job | Document D1 Time Travel, run a restore drill, add a scheduled export |
| F8 | Medium | Legal text says "in development" and "demo mode". The dossier's cookie, refund, retention and breach policies are missing | `public/privacy`, `public/terms` | Counsel review in Step 2 |
| F9 | Low (fixed) | The smoke test hard-coded the year 26 in invite codes, so it failed once the sample event moved into 2027. Not a product bug | `test/smoke.mjs` | Fixed in this audit. Expected year is now computed |
| F10 | Medium (unverified) | D1 is single-writer. Behaviour under a real on-sale rush (thousands of buyers a minute) is untested | No load test exists | Load test in Step 3 and decide whether D1 suffices |
| F11 | Medium | Staff audit log is append-only by design (no route edits it) but is not tamper-evident at the database level. The dossier asks for immutable or tamper-evident | `audit_log` table | Add a hash chain, or ship the log to external storage |
| F12 | Medium | Selfie photos (base64 in D1) are sensitive. Consent text and an automatic purge exist, but no data-protection impact assessment | `photo.js`, purge in `index.js` | Privacy assessment and retention rule |
| F13 | Low | No notifications: no event reminders, payment confirmations or organiser messages | grep shows none | WhatsApp and SMS in Step 3 |
| F14 | Low | Scanner phones keep the event list in the browser's ordinary storage, not an encrypted store. Android app is debug-signed, iPhone unbuilt | `gate.js`, `mobile.yml` | Encrypt local data or limit what is kept. Signing keys and store accounts in Step 4 |
| F15 | Low | No public API, API keys, webhooks, sandbox or API docs | Routes list | Step 4 |

## 13. What passes today

The existing automated suite: 20 files, 308 checks, all passing. Coverage includes sign-in, sessions, invites, claiming, gate scanning, live codes, offline sync, duplicate scans, stewards, guest lists, visitors, wristbands, attendance, account deletion and the staff console. It does **not** cover payments for tickets (none exist), load, or security testing by a third party.
