# 03. Architecture decision, Step 2 scope, estimate and dependencies

## 1. Architecture decision (needs your approval)

The dossier suggests TypeScript, React or Next.js, Node or NestJS, PostgreSQL, Redis and React Native, and says these are **not mandatory** where an existing architecture meets the requirements. The team must justify any major choice.

**Recommendation: keep the current stack for Steps 2 and 3, and decide again after the load test.**

| Reason to keep | Reason to revisit |
|----------------|-------------------|
| It works: 308 passing checks, real gate flows, offline mode | D1 is single-writer, so a big on-sale rush is the main risk (F10) |
| Zero runtime dependencies means a small attack surface and fast pages on cheap phones | Rich financial reporting and settlements are easier on PostgreSQL |
| Cloudflare gives global edge delivery, backups (Time Travel) and cheap scaling | A larger engineering team may prefer TypeScript and a framework |
| Rewriting would delay payments, the one thing that blocks launch | |

**Revisit triggers:** the Step 3 load test fails its target; reporting needs outgrow SQL on D1; or a hiring plan favours another stack. The payment layer in Step 2 will sit behind a small interface so the database can change later without touching checkout.

## 2. Step 2 scope (commercial readiness, weeks 3 to 8)

**Before the audit is even approved (P0, about half a day):** stop F1. Refuse `buy` for any tier with a price until real payment exists. Free tiers keep working. Also fill the organiser allow-list or switch new events to unlisted (F2). Both are small and reversible.

Then, in this order:

1. **Payment core.** Provider interface, Paystack first. Order and payment tables. Checkout creates a pending order, the provider's verified webhook confirms it, and only then are tickets issued. Duplicate webhooks do nothing twice. Failed payments issue nothing. No card data is stored.
2. **Refunds, ledger and settlements.** Refund requests and approvals, gross revenue, processing fee, platform commission, tax and organiser amount per sale, an append-only financial ledger, organiser views of pending, completed and disputed settlements.
3. **Verification.** SMS provider for phone sign-in and confirmations. Transactional email sender with the domain's SPF and DKIM set up.
4. **Security.** MFA or Cloudflare Access for staff and organisers, tamper-evident audit log, backup and restore drill.
5. **Delivery pipeline.** CI that runs all suites on every change, a staging Worker with its own database, error alerts and an uptime check.
6. **Legal.** Rewrite privacy and terms. Add refund, cookie, retention and breach policies, reviewed by a Nigerian data-protection adviser. No compliance claims without independent verification.
7. **Acceptance tests** for the dossier's scenarios 1 to 3, 11, 12, 14 and 16.

**Exit condition (dossier):** a real payment produces a valid ticket automatically, a failed or duplicated one does not, and the books reconcile.

## 3. Effort estimate

These are my estimates for one engineer working with AI assistance. They are planning figures, to be revised after you approve the scope.

| Work | Estimate |
|------|----------|
| P0 stop-gap | 0.5 day |
| Payment core (Paystack, webhooks, orders, tests) | 3 to 4 weeks |
| Refunds, ledger, commission, settlements, organiser views | 2 to 3 weeks |
| SMS and email delivery | 1 week (plus provider approval lead time) |
| MFA or Access, audit hash chain, backups | 1 week |
| CI, staging, alerts | 1 week |
| Legal documents and counsel review | 1 week of drafting, counsel time on top |
| Acceptance tests | 1.5 weeks, running alongside the above |
| **Step 2 total** | **about 10 to 12 engineer-weeks, fitting the dossier's weeks 3 to 8 only if provider approvals start now** |

**Running costs (not estimated here, they depend on volume and current published prices):** payment provider fee per transaction, SMS per message, WhatsApp per conversation, Cloudflare paid plan and D1 usage, email sending, penetration test, legal adviser, Apple Developer Program (published at about 99 US dollars a year) and Google Play (published at a one-time 25 US dollars). Confirm each before budgeting.

## 4. External dependency register

Lead times are the main schedule risk. Items marked **start now** take calendar time that no amount of coding can shorten.

| # | Dependency | Needed for | Who | Status | Note |
|---|-----------|------------|-----|--------|------|
| 1 | Payment provider business account and verification (Paystack, or Flutterwave) | All paid tickets | You | Not started | **Start now.** Usually needs company registration documents and a settlement bank account |
| 2 | Settlement bank account in the company's name | Payouts | You | Unknown | |
| 3 | SMS provider account and sender-ID registration (for example Termii or Africa's Talking) | Phone sign-in, confirmations | You | Not started | **Start now.** Sender registration in Nigeria can take time |
| 4 | Transactional email sender and DNS records for tap-in.world | Receipts, sign-in fallback | You and me | Not started | |
| 5 | WhatsApp Business Platform: verified Meta business, approved message templates | Ticket delivery, reminders | You | Not started | **Start now.** Step 3 |
| 6 | Nigerian data-protection and legal adviser | Policies, NDPA 2023 assessment, whether registration is required | You | Not started | **Start now** |
| 7 | Independent penetration-test vendor | Before major deployment | You | Not started | Step 3 |
| 8 | Cloudflare plan limits for D1 and Workers, and Access (if used for the console) | Scale, staff security | You | Unknown | |
| 9 | Apple Developer account, Google Play developer account, app signing keys | App store release | You | Not started | Step 4 |
| 10 | Apple Wallet and Google Wallet certificates | Wallet passes | You | Not started | Code is ready, secrets are not set |
| 11 | Photo and image licences for the website | Marketing site | You | Unconfirmed | Includes the concert photos and the talk-hall photo |
| 12 | Pricing decisions: commission, who pays fees, refund policy | Checkout and ledger | You | Open | See the decisions below |
| 13 | Pilot organisers and a support owner | Step 3 | You | Not started | |
| 14 | `.well-known` link files and app links | App deep links | Me, after item 9 | Waiting | |

## 5. Decisions needed from you to approve Step 2

1. **Stop-gap for F1:** may I make paid tickets unavailable until real payment works, and tighten new-organiser access (F2)? Recommended: yes.
2. **Payment provider:** Paystack first, with the layer built so Flutterwave can follow? Recommended: yes.
3. **Organiser access:** approve each new organiser by hand, or allow anyone with a verified account?
4. **Guest checkout:** allow buying with an email only, or always sign in first?
5. **Fees:** does the buyer or the organiser pay the platform fee by default, and what is the commission?
6. **Refunds:** the default policy (for example refundable until a set time before the event)?
7. **Stack:** accept the recommendation in section 1.

## 6. Acceptance-test map (dossier section 20)

| # | Scenario | Covered today? |
|---|----------|----------------|
| 1 | Customer buys a ticket | **No.** Only the unpaid demo purchase is tested |
| 2 | Failed payment issues no paid ticket | No |
| 3 | Duplicate payment notification issues one ticket | No |
| 4 | Valid ticket accepted | Yes |
| 5 | Invalid ticket rejected | Yes |
| 6 | Used ticket rejected | Yes |
| 7 | Transfer invalidates the old credential | No |
| 8 | Multiple scanners synchronise | Yes |
| 9 | Offline scanning within its limits | Yes |
| 10 | Conflicting offline entries identified | Yes |
| 11 | Organiser reconciles revenue | No |
| 12 | Refund updates financial and ticket records | No |
| 13 | Unauthorised staff cannot see restricted event data | Yes |
| 14 | Customers recover their accounts | Partly (email-link sign-in and deletion are tested, recovery flow is not named) |
| 15 | Administrators investigate security incidents | Partly (console and audit log tested, no incident workflow) |
| 16 | System recovers from service interruptions | No |
