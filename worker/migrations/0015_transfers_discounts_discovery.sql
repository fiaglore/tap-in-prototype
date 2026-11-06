-- Ticket transfers, discount codes, discovery fields and two-step sign-in (MFA).

-- Discovery (dossier 4.2). country is an ISO 3166-1 alpha-2 code.
ALTER TABLE events ADD COLUMN category TEXT;
ALTER TABLE events ADD COLUMN country TEXT NOT NULL DEFAULT 'NG';
ALTER TABLE events ADD COLUMN region TEXT;
CREATE INDEX IF NOT EXISTS idx_events_discovery ON events (listed, country, category, starts_at);

-- Transfers (dossier 4.5). The old pass is revoked and a new one is issued, so a screenshot of the old code stops working.
ALTER TABLE events ADD COLUMN allow_transfers INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS transfers (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  from_user_id  TEXT NOT NULL,
  to_identifier TEXT NOT NULL,
  to_user_id    TEXT,
  old_pass_id   TEXT NOT NULL,
  new_pass_id   TEXT,
  invite_id     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('completed', 'waiting')),
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers (from_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_event ON transfers (event_id, created_at DESC);

-- Discount codes (dossier 5). A discount takes money off the ticket price; the platform commission is worked out on the reduced price.
CREATE TABLE IF NOT EXISTS discount_codes (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  percent_off     INTEGER CHECK (percent_off BETWEEN 1 AND 90),
  amount_off_kobo INTEGER CHECK (amount_off_kobo > 0),
  tier_id         TEXT,
  max_uses        INTEGER CHECK (max_uses > 0),
  expires_at      INTEGER,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at      INTEGER NOT NULL,
  UNIQUE (event_id, code),
  CHECK ((percent_off IS NOT NULL) != (amount_off_kobo IS NOT NULL))
);
ALTER TABLE orders ADD COLUMN discount_code_id TEXT;
ALTER TABLE orders ADD COLUMN discount_kobo INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_orders_discount ON orders (discount_code_id, status) WHERE discount_code_id IS NOT NULL;

-- Two-step sign-in (TOTP). The secret is stored encrypted under SECRET_PEPPER. A session is "second-step verified" once mfa_at is set.
ALTER TABLE users ADD COLUMN mfa_secret TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled_at INTEGER;
ALTER TABLE users ADD COLUMN mfa_last_step INTEGER;   -- newest 30-second step already used, so a code cannot be replayed
ALTER TABLE users ADD COLUMN mfa_recovery TEXT;        -- JSON array of keyed hashes of unused recovery codes
ALTER TABLE sessions ADD COLUMN mfa_at INTEGER;
