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
| Item | Acceptance test (dossier 20) | Status |
|---|---|---|
| Provider-agnostic payment layer, `orders`/`payments` tables | 1, 2, 3 | Blocked: provider choice |
| Verified webhooks, idempotent ticket issuance | 3 | Blocked: provider choice |
| Refunds updating ticket and financial records | 12 | Blocked: provider choice |
| Ledger: gross, processor fee, commission, tax, organiser payable | 11 | Blocked: fee/commission decisions |
| SMS (OTP, ticket confirmation) | 14 | Blocked: SMS provider |
| MFA for organiser/staff/admin | 13, 15 | Todo |
| Run tests in CI, add staging environment | n/a | Todo |
| Backup and recovery documentation, tested restore | 16 | Todo (needs Cloudflare access) |

## Later phases
Phases 2 to 4 are listed in `docs/TECHNICAL_AUDIT.md` section 7 and are not started. Per the dossier, no phase starts until the previous one passes acceptance.
