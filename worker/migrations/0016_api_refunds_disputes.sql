-- Public API keys, outbound webhooks, partial refunds and chargebacks.

-- API keys. The key itself is shown once; only a keyed hash is stored. mode "sandbox" keys only see sandbox events.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  key_hint     TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('sandbox', 'live')),
  scopes       TEXT NOT NULL,                 -- JSON array: events:read events:write attendance:read payments:read
  rate_per_min INTEGER NOT NULL DEFAULT 120,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys (owner_id, created_at DESC);

ALTER TABLE events ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0;

-- Outbound webhooks: Tap In calls the customer's HTTPS URL when something happens. The signing secret is stored encrypted.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('sandbox', 'live')),
  event_types TEXT NOT NULL,                  -- JSON array, or ["*"]
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_owner ON webhook_endpoints (owner_id, status);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL,
  last_code   INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries (status, next_at);

-- Partial refunds and chargebacks. dispute_status is separate from status so the order's own state keeps its meaning.
ALTER TABLE orders ADD COLUMN refunded_kobo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN refunded_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN dispute_status TEXT CHECK (dispute_status IN ('open', 'won', 'lost'));
