# Operations runbook: environments, deployment, backup and recovery

Written from the code in this repository. Items marked **VERIFY** need someone with Cloudflare access to confirm them against the live account; they have not been checked.

## 1. Environments

| Environment | Worker | Database | Money | Who uses it |
|---|---|---|---|---|
| Production | `tap-in` (`www.tap-in.world`, `business.tap-in.world`) | D1 `tap-in-db` | Real, once a provider is connected | Customers |
| Staging | `tap-in-staging` (`--env staging`) | D1 `tap-in-staging` (empty, test data only) | Test provider only (`TICKET_CHECKOUT=mock`) | The team |
| Local | `npm run dev` | local SQLite | None | Developers |

Rules: staging and production use **different** `SECRET_PEPPER` values. Never copy production data into staging. Never put live payment keys in staging. Production must keep `TICKET_CHECKOUT` at `off` or `live`, never `demo` or `mock`.

One-time staging setup is in the comment block in `worker/wrangler.jsonc`.

## 2. Deploying

1. Open a pull request. The **Worker tests** workflow must pass (`.github/workflows/worker-tests.yml`).
2. Deploy to staging: `cd worker && npx wrangler d1 migrations apply tap-in-staging --remote --env staging && npx wrangler deploy --env staging`.
3. Check staging by hand: sign in, create an event, buy a free ticket, take a mock payment, scan a pass.
4. Production: take a backup first (section 3), then `npx wrangler d1 migrations apply tap-in-db --remote && npx wrangler deploy`.
5. **Apply migrations before deploying code that needs them.** Migration `0017_session_scope.sql` adds a column that every sign-in check reads: deploying the code first signs everyone out and breaks the site until the migration runs.
6. Migration `0018_business.sql` (departments, incidents, team access, visitor check-out) is needed by the Business console screens and by the attendance report: apply it before deploying code that reads it.
7. Migrations only ever add. If a migration must be undone, restore (section 4) rather than editing it.

Rollback of code only: `npx wrangler rollback` (Cloudflare keeps recent versions). Rollback does not undo database changes.

## 3. Backups

- **D1 Time Travel** keeps a point-in-time history of the database. Retention depends on the Cloudflare plan (**VERIFY**: 7 days on Free, 30 days on Paid). Check it: `npx wrangler d1 time-travel info tap-in-db`.
- **Manual export before every production deploy and weekly:** `npx wrangler d1 export tap-in-db --remote --output=tap-in-$(date +%F).sql`. Store the file in encrypted storage that is **not** on the same Cloudflare account. The export contains personal data and hashed secrets: treat it as confidential, and delete old copies according to the retention policy.
- Secrets are not in the database. Keep an offline record of which secrets exist (names, not values) and who can reset them: `SECRET_PEPPER`, `STAFF_IDENTIFIERS`, `ORGANISER_IDENTIFIERS`, `PAYMENT_WEBHOOK_SECRET`, the provider secret key, `APPLE_*`, `GOOGLE_*`.
- **`SECRET_PEPPER` is critical.** Every invite, one-time code, session, gate key and pass check is keyed by it, and two-step secrets are encrypted under it. If it is lost or changed, all existing passes stop verifying and all sessions and two-step enrolments are invalid. Store a copy in the company password manager.

## 4. Recovery

**A. Bad data change or bad migration (database is up):**
1. Stop writes if possible: deploy a maintenance version or set `TICKET_CHECKOUT` to `off`.
2. Find the time just before the problem and restore: `npx wrangler d1 time-travel restore tap-in-db --timestamp=<UNIX_OR_ISO_TIME>`. Wrangler prints the bookmark to undo the restore.
3. Re-deploy the last good code (`npx wrangler rollback`).
4. Reconcile payments for the gap (section 5).

**B. Database lost or corrupt beyond Time Travel:** create a new D1 database, apply all migrations, import the latest export (`npx wrangler d1 execute <db> --remote --file=backup.sql`), update `database_id` in `wrangler.jsonc`, deploy.

**C. Cloudflare outage:** nothing to do on our side; passes already on phones keep working offline for secure-QR events, and the gate scanner works from its cached list. Tell organisers to use the gate app's offline mode.

**D. Practice it.** Restore into staging at least once a quarter and record the date here: _last tested: never_ (**not yet done**).

## 5. After any outage or restore: reconcile payments

1. In the payment provider's dashboard, list successful charges for the gap.
2. For each, the provider can **resend the webhook**; Tap In handles replays safely (no duplicate tickets).
3. Check `GET /api/events/:id/finance` for each affected event: `reconciled` must be true.
4. Orders in `refund_due` or `review` need a person: refund or approve in the provider dashboard and note the outcome.

## 6. Security incident (summary)

1. Contain: rotate `SECRET_PEPPER`? **No** (that logs everyone out and voids every pass). First: suspend affected accounts from the team console, rotate the affected gate keys, rotate the provider and webhook secrets, set `TICKET_CHECKOUT` to `off` if payments are involved.
2. Investigate with the team console audit log and Cloudflare logs (observability is enabled).
3. Under the Nigeria Data Protection Act 2023 a personal-data breach may have to be reported to the NDPC within 72 hours. Involve the data-protection adviser at once. **This is a legal duty to confirm with counsel; it is not legal advice.**
