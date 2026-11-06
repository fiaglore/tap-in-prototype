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
| Checkout screens on the sales page (redirect, poll order) | 1 | Todo |
| Partial refunds, disputes/chargebacks, payout statements | 12 | Todo |
| SMS (OTP, ticket confirmation) | 14 | Blocked: SMS provider |
| Tests run in CI (`.github/workflows/worker-tests.yml`) | n/a | Done |
| MFA for organiser/staff/admin | 13, 15 | Todo |
| Staging environment, backup and recovery runbook | 16 | Todo (needs Cloudflare access) |

Open business decisions: who bears the provider's processing fee (currently recorded as a Tap In cost, see `src/lib/fees.js`); commission rates (checkout stays closed until set); refund policy wording (needs legal review).

## Phase 2 items requested early
| Item | Status |
|---|---|
| Ticket transfers (revoke old pass, issue new, notify both) | Todo |
| Discount codes | Todo |
| Discovery filters (country, city, category, date, price) | Todo |

## Later phases
Phases 2 to 4 are listed in `docs/TECHNICAL_AUDIT.md` section 7 and are not started. Per the dossier, no phase starts until the previous one passes acceptance.
