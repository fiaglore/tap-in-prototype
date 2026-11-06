# Implementation Tracker

A feature is **Done** only when it passes its acceptance test (dossier section 20). Status: Todo, In progress, Blocked (needs owner input), Done.

## Phase 0: Audit
| Item | Status |
|---|---|
| Technical audit and gap analysis (`docs/TECHNICAL_AUDIT.md`) | Done |
| P0: stop paid tickets being issued without payment (S1) | Done, tested |
| Fix clock-dependent test (invite code year) | Done |
| Confirm live-site configuration (secrets, D1 backups, domains) | Blocked: needs owner access/screenshots |

## Phase 1: Commercial readiness
Decisions (from the owner): neutral payment layer first, no provider chosen yet; organiser money settles by provider splits (Tap In never holds funds); fees configurable per event (`fee_mode` pass or absorb) with the commission set by `PLATFORM_COMMISSION_BPS` and `PLATFORM_FLAT_KOBO`.

| Item | Acceptance test (dossier 20) | Status |
|---|---|---|
| `orders`, `payment_events`, `order_ledger` tables (migration 0014) | n/a | Done |
| Provider interface and mock provider; checkout route; fee calculation | 1 | Done, tested |
| Verified webhook, replay-safe, idempotent issuance, wrong-amount hold | 2, 3 | Done, tested |
| Refund (full) revoking tickets and reversing the ledger | 12 | Done, tested |
| Ledger and organiser finance summary that reconciles | 11 | Done, tested |
| Real provider adapter (Paystack or Flutterwave) | live payment | Blocked: provider account and keys |
| Provider split/subaccount creation per organiser | settlement | Blocked: provider account |
| Checkout screens on the sales page (discount code, quote, redirect, wait for confirmation) | 1 | Done (needs a real provider to test end to end) |
| Partial refunds (per ticket, books stay balanced to the kobo) and chargebacks (open blocks refunds; lost reverses the books) | 12 | Done, tested. Payout statements wait on the provider |
| SMS (OTP, ticket confirmation) | 14 | Blocked: SMS provider |
| Tests run in CI (`.github/workflows/worker-tests.yml`) | n/a | Done |
| MFA (authenticator app, recovery codes): mandatory for staff, required for organiser refunds if turned on (mandatory with `REQUIRE_ORGANISER_MFA=1`) | 13, 15 | Done, tested |
| Staging environment config and operations runbook (`docs/RUNBOOK.md`) | 16 | Written; staging needs the owner to create its database; restore never practised |

Open business decisions: who bears the provider's processing fee (currently recorded as a Tap In cost, see `src/lib/fees.js`); commission rates (checkout stays closed until set); refund policy wording (needs legal review).

## Phase 2 items built early
| Item | Status |
|---|---|
| Ticket transfers (old pass revoked, new pass issued, organiser can switch off, 10 a day limit, refund follows the ticket) | Done, tested. Notifying both parties needs an SMS/email provider (Blocked); the transfer shows in the app instantly |
| Discount codes (percent or fixed, per ticket type, use limit, expiry, quote before paying) | Done, tested |
| Discovery filters (search, country, region, city, category, date, price, free, not sold out) and organiser category/country/region fields | Done, tested. Currency and time zone display still NGN and Lagos only |
| Organiser "Sales & discounts" tab (money summary, orders, refunds, discount codes, fees, transfers) | Done |

## Owner actions outstanding (reminder list)
1. Payment provider account (Paystack or Flutterwave): keys and webhook secret, then the real adapter and organiser split accounts.
2. Commission rates (`PLATFORM_COMMISSION_BPS`, `PLATFORM_FLAT_KOBO`), and who bears the provider's processing fee.
3. SMS provider (Termii or Africa's Talking), sender ID; WhatsApp Business verification and message templates; transactional email domain.
4. Legal and data-protection adviser (NDPA 2023, refund and cookie policies, data-processing agreements); penetration test.
5. Apple Developer and Google Play accounts.
6. Cloudflare: confirm production secrets, create the staging database, confirm D1 Time Travel, practise one restore.

## Phase 3 items
| Item | Status |
|---|---|
| Public API v1: keys with scopes, sandbox vs live, rate limit, events, attendance, payments (`docs/API.md`) | Done, tested |
| Outbound webhooks: signed, retried, `order.fulfilled` / `order.refunded` / `order.disputed` | Done, tested (cron every 15 minutes retries) |
| API key and webhook screens in the app/console | Todo (API works; keys are created by API call today) |
| Hosted OpenAPI file, per-key limits UI, creating orders via API | Todo |
| Business: employee and department records, check-out, incident reports, admin roles | Todo (existing: offices, doors, visitors, attendance) |
| Business subscriptions (Starter / Professional / Enterprise) | Blocked: needs the payment provider for billing and decisions on plan limits and prices |
| NFC / hardware | Not started. Needs hardware choices and a security design; see below |
| Tap In Identity | Not started on purpose: the dossier requires a separate privacy, consent and regulatory assessment first |
| Multi-currency, time zones, other countries | Not started: Phase 4, and a market must not open before payments, legal and support are ready |

NFC note: reading a plain NFC tag ID is not safe (IDs can be copied). A safe design uses secure credentials (for example a signed, expiring credential in Apple/Google Wallet "smart tap" or a secure-element card) checked by the same gate logic. That needs a hardware pilot (which reader, which phones) before code.

## Later phases
Phases 2 to 4 are listed in `docs/TECHNICAL_AUDIT.md` section 7 and are not started. Per the dossier, no phase starts until the previous one passes acceptance.
