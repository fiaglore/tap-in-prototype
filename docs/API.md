# Tap In public API (v1)

Base URL: `https://www.tap-in.world/api/v1`. JSON in, JSON out. Errors look like `{"error":{"code":"...","message":"..."}}`.

## Keys
Create keys in the app (or `POST /api/me/api-keys` while signed in): `{ "name": "Box office", "mode": "sandbox" | "live", "scopes": [...] }`. The key (`tk_test_...` or `tk_live_...`) is shown **once**; Tap In stores only a hash. Send it as `Authorization: Bearer <key>`. Revoke it any time. Up to 10 active keys per account. Creating a live key asks for your two-step code if you have two-step sign-in on.

| Scope | Allows |
|---|---|
| `events:read` | List and read your events |
| `events:write` | Create events |
| `attendance:read` | Attendees and entry scans |
| `payments:read` | Orders, payment status, money summary |

**Sandbox vs live.** A sandbox key only sees sandbox events (created with a sandbox key, never listed publicly, never real money). A live key only sees live events. Keys only ever see their own owner's data.

**Rate limit.** 120 requests a minute per key by default; over it you get `429 rate_limited`. Version changes will arrive as `/api/v2`; v1 will not change incompatibly.

## Endpoints
| Method and path | Scope | Returns |
|---|---|---|
| `GET /ping` | any | `{ok, mode, scopes, version}` |
| `GET /events` | events:read | Your events with counts |
| `POST /events` | events:write | Creates an event (same body as the console: `name`, `zones`, `tiers`, `starts_at`, `category`, `country`...). Returns the gate key once |
| `GET /events/:id` | events:read | One event with ticket types and areas |
| `GET /events/:id/attendees` | attendance:read | Ticket holders (name, contact, status, first entry; the owner already sees these in the console) |
| `GET /events/:id/scans?limit=` | attendance:read | Latest entry scans |
| `GET /events/:id/orders` | payments:read | Orders with status, buyer name and masked contact |
| `GET /events/:id/finance` | payments:read | Gross, amount owed to you, Tap In fee, provider fees, `reconciled` |
| `GET /orders/:id` | payments:read | Payment status: `pending`, `fulfilled`, `failed`, `expired`, `refunded`, `refund_due`, `review`; plus `refunded_kobo`, `dispute_status` |

All money is integer **kobo** (₦1 = 100). Naira only today.

**Ticket validation at the door** uses the scanner API with a per-event gate key (not an API key): `POST /api/gate/scan` with `Authorization: Bearer <gate key>` and `{token, zone_id}`. Use this for third-party scanning hardware.

## Webhooks (from Tap In to your server)
Register an HTTPS address: `POST /api/me/webhook-endpoints` `{ "url": "https://you.example.com/hooks/tapin", "mode": "live", "event_types": ["order.fulfilled"] }`. The signing secret (`whsec_...`) is returned once. Public `https://` addresses only (no IP addresses, ports or internal names). Up to 5 per account.

Events: `order.fulfilled` (paid and tickets issued), `order.refunded` (full or partial), `order.disputed` (bank dispute opened, won or lost). Payload:
```json
{ "id": "evt_...", "type": "order.fulfilled", "created": 1760000000, "livemode": true,
  "data": { "order_id": "...", "event_id": "...", "qty": 2, "status": "fulfilled", "currency": "NGN", "total_kobo": 1050000, "refunded_kobo": 0 } }
```
No buyer contact details are sent. Verify every call: header `Tap-In-Signature: t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(signing_secret, t + "." + rawBody)`. Reject if the signature is wrong or `t` is more than 5 minutes old. Reply `2xx` quickly. Failures are retried after 1, 2, 4, 8 and 16 minutes, then dropped; the same event can arrive more than once, so make your handler idempotent (use `data.order_id` and `id`).

## Not in v1 yet
Creating orders through the API (checkout stays in the Tap In page), membership verification (needs the Identity privacy assessment first), per-key custom limits in the UI, and a hosted OpenAPI file.
