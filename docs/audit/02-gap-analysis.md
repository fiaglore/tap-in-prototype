# 02. Gap analysis and implementation tracker

Classification (dossier section 3): **A** production-ready, **B** functional but needs improvement, **C** partial, **D** missing.
Priority: **P0** do before anything else, **P1** Step 2 (commercial readiness), **P2** Step 3 (Nigerian launch), **P3** Step 4 (expansion).
The *Status* column is the live tracker. Update it as work lands. A row only moves to A when its acceptance test passes.

| # | Dossier section | Requirement | Class | Priority | Status | Notes |
|---|-----------------|-------------|-------|----------|--------|-------|
| 1 | 4.1 | Register and sign in securely (email) | B | P1 | Open | Email link works. Needs a transactional email sender and recovery wording |
| 2 | 4.1 | Phone number verification | D | P1 | Open | SMS is a stub (F4) |
| 3 | 4.1 | Password recovery | n/a | n/a | Closed | There are no passwords. Account recovery is by email link. Confirm this meets the dossier's intent |
| 4 | 4.1 | Browse and search events | B | P2 | Open | Search and filters exist on `/play/`. No category, price, country or region filters, no availability filter |
| 5 | 4.1 | Event details and ticket purchase | **C** | **P0/P1** | Open | Purchase exists but is unpaid (F1). Fix first |
| 6 | 4.1 | View and manage digital tickets | A | | Done | Passes, history, wallet add-ons |
| 7 | 4.1 | Transfer tickets, request refunds | D | P2 | Open | |
| 8 | 4.1 | Notifications, contact organiser/support | D | P2 | Open | F13 |
| 9 | 4.1 | Guest checkout (no app needed) | B | P1 | Open | Web checkout works, but needs sign-in before buying. Decide whether email-only guest checkout is wanted |
| 10 | 4.2 | Event discovery marketplace with categories, country/city, currency, time zones | C | P2 | Open | City, date and name only. NGN only. Africa/Lagos time |
| 11 | 4.3 | Ticket categories: early bird, regular, GA, VIP, VVIP, backstage, complimentary, reserved seating | C | P2 | Open | Free-form ticket types, capacity and sale window, complimentary invites. No reserved seating or early-bird automation |
| 12 | 4.3 | Unique ticket id, validity, entry permissions, not reusable after entry | A | | Done | Verified |
| 13 | 4.4 | Dynamic QR: signed, expiring, replay-safe, no personal data | A | | Done | Live and rolling codes. Verified |
| 14 | 4.5 | Authenticated ticket transfer that revokes the old credential | D | P2 | Open | |
| 15 | 5 | Organiser: create/edit events, tiers, quantities, sale periods | A | | Done | |
| 16 | 5 | Artwork upload, locations | D | P2 | Open | No event images or maps |
| 17 | 5 | Discount codes | D | P2 | Open | |
| 18 | 5 | Complimentary tickets, guest lists, invitations | A | | Done | |
| 19 | 5 | Manage scanning staff | A | | Done | Stewards with own keys, instant revoke |
| 20 | 5 | Financial reports, payouts, refunds | D | P1 | Open | Depends on payments |
| 21 | 5 | Analytics: sales, revenue, hourly sales, entries, refunds, payment failures | C | P2 | Open | Entries and attendance only. No sales analytics because nothing is paid |
| 22 | 5 | CSV and PDF reports | C | P2 | Open | CSV for scans and attendance. No PDF |
| 23 | 6.1 | Scanner app (phone camera, multi-gate, multi-staff) | A | | Done | Web scanner with service worker. Dedicated hardware scanners not tested |
| 24 | 6.2 | GREEN/RED/AMBER/BLUE results | B | P2 | Open | Granted and denied with reasons. No AMBER (needs attention) or BLUE (special access) states |
| 25 | 6.3 | Multi-gate with central attendance record | A | | Done | |
| 26 | 6.4 | Offline operation with sync and duplicate detection | B | P2 | Open | Works with documented limit. Add the dossier's consistency strategy (per-gate ranges or reserved permissions) and encrypted local store (F14) |
| 27 | 7 | Payment provider integration (Paystack, Flutterwave, Interswitch) | D | **P1** | Open | F3. Verified webhooks only. Never issue on redirect or screenshot |
| 28 | 7.4 | Secure checkout, confirmation, auto issuance, failed and duplicate payments, refunds, reconciliation | D | **P1** | Open | |
| 29 | 7.5 | Revenue split, commission, tax, ledger, settlement views | D | P1 | Open | The existing `ledger` is the demo wallet's |
| 30 | 8.1 | WhatsApp Business messaging | D | P2 | Open | Only share links today |
| 31 | 8.2 | SMS for verification, confirmations, reminders | D | P1/P2 | Open | |
| 32 | 8.3 | NGN default, transparent fees | B | P1 | Open | Naira shown. Fees not modelled |
| 33 | 8.4 | Low-bandwidth, cheap-device optimisation | B | P2 | Open | No framework, no runtime dependencies, small pages. App-mode lightening done. Never measured on a real low-end phone |
| 34 | 9 | Tap In Business: employees, visitors, permissions, reports | B | P3 | Open | Offices, visitors, attendance reports exist. Not yet a separate commercial product: no billing, plans or admin roles |
| 35 | 10 | Tap In Identity: memberships and credentials | D | P3 | Open | Not started. Needs the privacy assessment first |
| 36 | 11 | NFC and hardware | D | P3 | Open | Wristbands are printed QR, not NFC |
| 37 | 12 | Public API, keys, webhooks, sandbox, docs | D | P3 | Open | F15 |
| 38 | 13 | Encryption in transit and at rest | B | P1 | Open | In transit yes. At rest is Cloudflare's platform default. Confirm in writing |
| 39 | 13 | Secure hashing | A | | Done | Keyed hashes for all secrets. No passwords |
| 40 | 13 | MFA for privileged accounts | D | P1 | Open | F5 |
| 41 | 13 | RBAC and session management | B | P1 | Open | Roles: attendee, organiser, steward, staff. Organiser approval is open (F2) |
| 42 | 13 | API authentication and rate limiting | B | P2 | Open | Rate limits on sign-in and gate. Not on every route |
| 43 | 13 | Audit logging | B | P1 | Open | Staff actions only, not tamper-evident (F11) |
| 44 | 13 | Automated backups, disaster recovery | C | P1 | Open | F7 |
| 45 | 13 | Vulnerability monitoring, independent penetration test | D | P2 | Open | |
| 46 | 13 | Regulatory assessment (NDPA 2023, GDPR) and policies | C | P1 | Open | Privacy and terms exist but are "in development" text (F8) |
| 47 | 14 | Separate dev, staging and production; automated deploy, monitoring, logging | C | P1 | Open | F6 |
| 48 | 14 | Mobile apps (Android, iOS) | C | P3 | Open | Android debug build only. iOS unbuilt |
| 49 | 15 | Multi-currency, languages, regional tax | D | P3 | Open | |
| 50 | 16 | Commission, subscriptions, enterprise licensing | D | P1/P3 | Open | Pricing decision needed from you |
| 51 | 17 | Customer support: help centre, ticketing, disputes, refund management | C | P2 | Open | Team console resolves account problems. No help centre or ticket queue |
| 52 | 18 | Administrative control panel | B | P1/P2 | Open | Users, passes, invites, events, audit log. Missing: transactions, refunds, payouts, disputes, subscriptions, complaints |
| 53 | 20 | Automated acceptance tests for the 16 mandatory scenarios | C | P1 | Open | See the map in 03. 7 of 16 are covered, 2 partly, 7 not at all |
| 54 | 20 | Load testing | D | P2 | Open | F10 |

## Count

| Class | Rows |
|-------|------|
| A (production-ready) | 9 |
| B (improve) | 13 |
| C (partial) | 11 |
| D (missing) | 20 |
| n/a | 1 |
| **Total** | **54** |
