# Tap In: Technical Audit and Gap Analysis (Phase 0)

Source: *Tap In Master Product Development Dossier*, sections 3 and 19 (Phase 0).
Method: read the code in this repository and ran its 20 automated test suites (about 330 checks). **Not verified:** the live deployment at tap-in.world, Cloudflare/Firebase settings, secrets, D1 backups and anything outside this repo. Claims below are about the code, not the live site.

Classification (dossier section 3): **A** production-ready, **B** works but needs change before launch, **C** partial, **D** missing.

## 1. What exists

| Layer | Finding |
|---|---|
| Hosting / runtime | One Cloudflare Worker (`worker/src`, about 4,600 lines) serves the API (`/api/*`) and static pages (`worker/public`). Cron once a day. Observability on. Hosts: `www.tap-in.world`, `business.tap-in.world`. |
| Database | Cloudflare D1 (SQLite), 13 migrations. Money in integer kobo. DB-level constraints settle races (one claim per invite, one entry per pass per zone, no negative balances). |
| Frontend | Plain JS pages, no framework: attendee app `/app/`, organiser console, gate scanner (PWA with service worker), Business console, visitor invite page, staff console `/admin/`, public sales page `/e/`, discovery `/play/`. |
| Mobile | Capacitor shell (`mobile/`) for Android and iOS. CI builds a debug Android APK only. No store release pipeline. |
| Auth | Email sign-in link via Firebase REST (live). Phone/SMS OTP exists in code but **no SMS provider is wired** (`otp-delivery.js` throws). Sessions: random 32-byte token, hash stored, HttpOnly cookie, 30 days. |
| Secrets handling | Invites, OTPs, gate keys, sessions stored only as HMAC/hash under `SECRET_PEPPER`. Good practice. |
| Tests | Real code against a SQLite stand-in for D1. Not run in CI (CI only builds the mobile app). |

## 2. Feature classification against the dossier

| Dossier area | Class | Evidence and gap |
|---|---|---|
| 4.1 Customer app: register, sign in | B | Email works. Phone needs an SMS provider. No password recovery needed (passwordless), but phone verification is absent. |
| 4.1 Guest checkout | C | Must sign in to buy (by design today). |
| 4.2 Event discovery | C | `/play/` lists listed events with search and a free/on-sale filter. Missing: country/region/category/date/price filters, categories, currencies, time zones. |
| 4.3 Ticket types and categories | B | Tiers with price, capacity, sales window, zones. Free-text tier names (no Early Bird/VIP/Reserved-seating model, no seat maps). |
| 4.4 Dynamic QR | B | Pass code is HMAC-checked and unforgeable; optional rotating 90-second live code (`secure_qr`) is good. Static code is the default. Symmetric HMAC means every verifier needs the server secret or an "offline key". |
| 4.5 Ticket transfers | D | No transfer flow. Invites can be bound to a phone, nothing more. |
| 5 Organiser dashboard | B | Create/edit events, tiers, zones, invites, guests, stewards, live numbers, scan CSV. Missing: artwork upload, discount codes, complimentary/guest-list import UI parity, financial reports, payouts, refunds, PDF reports. |
| 6 Scanner and access control | A/B | Gate app with GREEN/RED/AMBER style results, zones, multiple stewards, photo check, offline cache and sync with `offline_duplicate` flagging. Offline limits are documented honestly in code comments. Needs real-device and load testing. |
| 7 Payments (tickets) | **D, and a defect** | No provider integration, no webhooks, no order/payment table, no refunds, no reconciliation. See P0 below. Wallet/vendor/till payments exist but are demo-only and switched off. |
| 7.5 Revenue distribution, ledger, settlements | D | The wallet `ledger` is for the demo wallet only. |
| 8.1 WhatsApp | D | Only a "share on WhatsApp" link. No Business Platform. |
| 8.2 SMS | D | Not connected. |
| 8.3 Currency | C | NGN only, formatted in the UI. |
| 9 Tap In Business | B/C | Offices as events with doors and access groups, visitors (invited and walk-in), attendance reports and CSV, business subdomain. Missing: employee/department records, check-out, host notifications, incident reports, admin roles. |
| 10 Tap In Identity | D | Not started (and the dossier requires a separate privacy assessment first). |
| 11 NFC / hardware | D | Only Apple/Google Wallet passes (need credentials). No NFC reading. |
| 12 Public API | D | Internal cookie API only. No API keys, versioning, sandbox, rate-limit tiers, webhooks. |
| 13 Security | B | Strong basics (hashing, CSP, same-site checks, rate limits, audit log for staff console). Missing: MFA for privileged accounts, tamper-evident (hash-chained) audit log, backups/DR documentation, dependency and vulnerability monitoring, penetration test. |
| 13 Legal | C | Privacy page and terms exist. Missing: refund, cookie, retention, breach-response policies and data-processing agreements. Needs legal review. |
| 16 Commercial model | D | No commission, fee, subscription or plan logic. |
| 17 Support | C | Staff console covers people/passes/invites/events. No help centre, tickets, disputes or refunds. |
| 18 Admin panel | B | Present with allow-list and 8-hour sign-in window and audit log. Missing: transactions, payouts, disputes, subscriptions, MFA. |
| Environments | C | One production Worker. No staging/dev environments or automated deploy. |

## 3. Security findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| S1 | **P0** | `POST /api/public/events/:id/buy` minted and claimed tickets for **paid** tiers with no payment (a "demo checkout" left in the production route). Anyone signed in could get free tickets to any listed event. | **Fixed in this milestone.** Paid tiers now return 402 `payment_not_connected` unless `TICKET_CHECKOUT=demo` (tests only; production var is `off`). Regression test added. Free tiers still work. |
| S2 | P1 | No MFA for organiser, staff-console or any privileged account. | Open (Phase 1) |
| S3 | P1 | Staff console allow-list is a secret list of identifiers; audit log is append-only by convention, not tamper-evident. | Open (Phase 1) |
| S4 | P1 | Tests do not run in CI; deploy is manual. | Open (Phase 1) |
| S5 | P1 | No documented backup/restore or disaster-recovery procedure for D1. (Cloudflare D1 offers Time Travel; the settings and a tested restore are not in the repo.) | Open (Phase 1) |
| S6 | P2 | `_headers` CSP and security headers are good. Phone OTP, once an SMS provider is added, needs per-number and per-IP SMS-pumping limits. | Open |
| S7 | P2 | `FIREBASE_API_KEY` is committed in `wrangler.jsonc`. This is a public web key by design (restrict it by domain in Google Cloud). | Note |
| S8 | P2 | Selfie photos are stored as base64 text in D1. Acceptable at current scale; move to object storage (R2) before volume. | Open |
| S9 | P2 | Independent penetration test not commissioned (dossier 13). | Outstanding (business) |

## 4. Reliability and scale notes

- D1 is a single-region SQLite database. A large event gate (thousands of scans per minute) needs load testing; the offline cache in the gate app is the real mitigation. No performance targets exist yet (dossier 20 asks for them).
- Duplicate-entry handling across offline scanners is "record, then flag on sync" (honest, matches dossier 6.4). A pre-assigned-gate or ticket-range strategy is not implemented.

## 5. Architecture recommendation

**Keep Cloudflare Workers + D1.** The dossier lists PostgreSQL/NestJS/React as suggestions, not requirements, and says to preserve working functionality. Rebuilding would cost months and discard about 330 passing checks. Revisit when one of these is true: D1 write limits are hit, multi-region data residency is needed, or the Business product needs relational reporting that D1 cannot serve. Add: **Cloudflare Queues** (payment webhooks, notifications), **R2** (artwork, photos, exports), **Durable Objects only if** a single hot event needs strict global ordering, and a **staging Worker + D1** environment.

Payment architecture (to build in Phase 1): `orders` and `payments` tables, a provider interface (`initialize`, `verify`, `refund`, `parseWebhook`), a webhook endpoint that checks the provider signature, idempotent ticket issuance keyed on the provider reference, and a double-entry `ledger` for gross, processor fee, platform commission, tax and organiser payable.

## 6. External dependency register (things the business owner must provide)

| Need | Why | Owner action |
|---|---|---|
| Payment provider account (Paystack and/or Flutterwave) with live keys and webhook secret | Real ticket payments | Open a business account, complete KYC; supply keys as Worker secrets |
| Settlement bank account and agreement on who holds organiser funds | Organiser payouts | Decide model with provider/legal (see tracker, open questions) |
| SMS provider (Termii or Africa's Talking) and Sender ID registration | Phone verification, ticket SMS | Account, sender ID approval (NCC rules) |
| WhatsApp Business Platform account, verified Meta business, message templates | Ticket delivery, reminders | Meta business verification, template approval |
| Transactional email domain (Resend/Postmark) | Receipts, tickets (Firebase link email only today) | Domain DNS access |
| Apple Developer and Google Play accounts | Store releases, Apple/Google Wallet | Accounts and certificates |
| Legal counsel and data-protection adviser | NDPA 2023 (NDPC registration), terms, refund policy, DPAs | Engage; do not claim compliance before independent review |
| Penetration test vendor | Dossier section 13 | Commission before major launch |
| Cloud accounts: Cloudflare (existing), staging environment | Environments | Confirm access |

## 7. Roadmap (revised from dossier section 19)

Estimates are rough and assume one to two engineers; they should be revised once the open questions in the tracker are answered.

| Phase | Scope | Exit condition |
|---|---|---|
| 0 | This audit, P0 fix | Done |
| 1 | Orders and payments (provider abstraction, verified webhooks, idempotent issuance, refunds, ledger, reconciliation), SMS/email delivery, MFA for privileged users, CI for tests, staging, backup doc | A real payment issues exactly one valid ticket automatically; failed or duplicate notifications issue none |
| 2 | Nigerian launch: bank transfer/USSD via provider, WhatsApp, ticket transfer, discount codes, organiser payouts and financial reports, discovery filters and categories, support tooling, load test | Real events run and payments reconcile with attendance |
| 3 | Public API, subscriptions and plans, Business additions, NFC pilot, native-app polish | Per dossier 19 |
| 4 | Multi-currency, other markets, compliance | Per dossier 15 and 19 |
