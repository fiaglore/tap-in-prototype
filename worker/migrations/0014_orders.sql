-- Paid ticket orders, payment webhooks and the money ledger for ticket sales (dossier sections 7 and 7.5).
-- Money is integer kobo. A ticket for a paid tier exists only after a verified provider webhook marks its order paid.
--
-- orders.status: pending -> paid -> fulfilled   (normal path)
--                pending -> failed | expired     (no tickets)
--                paid -> review                  (amount or currency did not match; no tickets, staff look at it)
--                paid -> refund_due              (paid but tickets could not be issued, e.g. sold out; money must go back)
--                fulfilled -> refunding -> refunded
CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT PRIMARY KEY,
  event_id            TEXT NOT NULL REFERENCES events (id),
  tier_id             TEXT NOT NULL REFERENCES tiers (id),
  user_id             TEXT NOT NULL REFERENCES users (id),
  qty                 INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 8),
  unit_kobo           INTEGER NOT NULL CHECK (unit_kobo >= 0),
  subtotal_kobo       INTEGER NOT NULL CHECK (subtotal_kobo >= 0),
  commission_kobo     INTEGER NOT NULL CHECK (commission_kobo >= 0),
  fee_mode            TEXT NOT NULL CHECK (fee_mode IN ('pass', 'absorb')),
  buyer_fee_kobo      INTEGER NOT NULL CHECK (buyer_fee_kobo >= 0),
  total_kobo          INTEGER NOT NULL CHECK (total_kobo >= 0),
  currency            TEXT NOT NULL DEFAULT 'NGN',
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'fulfilled', 'failed', 'expired', 'review', 'refund_due', 'refunding', 'refunded')),
  provider            TEXT NOT NULL,
  provider_ref        TEXT NOT NULL UNIQUE,
  processor_fee_kobo  INTEGER,
  fulfil_lock         INTEGER,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  paid_at             INTEGER,
  refunded_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_event ON orders (event_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_tier_pending ON orders (tier_id, status, expires_at);

-- Which order produced a ticket. order_seq makes "ticket n of this order" unique, so a retry can never issue it twice.
ALTER TABLE passes ADD COLUMN order_id TEXT;
ALTER TABLE passes ADD COLUMN order_seq INTEGER;
ALTER TABLE invites ADD COLUMN order_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_passes_order_seq ON passes (order_id, order_seq) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invites_order ON invites (order_id) WHERE order_id IS NOT NULL;

-- Every webhook delivery, once. event_key is the provider's own event id, so a replayed webhook is recognised and ignored.
CREATE TABLE IF NOT EXISTS payment_events (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_key    TEXT NOT NULL,
  type         TEXT NOT NULL,
  provider_ref TEXT,
  outcome      TEXT,
  received_at  INTEGER NOT NULL,
  UNIQUE (provider, event_key)
);

-- Append-only money ledger for ticket orders. One row per component per order; refunds add reversing rows.
--   gross              what the buyer paid (+)
--   organiser_payable  what the organiser is owed (+)
--   commission         Tap In's platform commission (+)
--   processor_fee      what the payment provider took (+, a cost)
--   refund_*           the same kinds with a negative amount
-- Invariant for every order: gross = organiser_payable + commission + buyer-side remainder; see lib/fees.js.
CREATE TABLE IF NOT EXISTS order_ledger (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders (id),
  event_id    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('gross', 'organiser_payable', 'commission', 'processor_fee')),
  amount_kobo INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT 'sale' CHECK (reason IN ('sale', 'refund')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_ledger_order ON order_ledger (order_id);
CREATE INDEX IF NOT EXISTS idx_order_ledger_event ON order_ledger (event_id, kind);

-- Per-event choice: 'pass' adds the platform fee on top of the ticket price; 'absorb' takes it out of the organiser's share.
ALTER TABLE events ADD COLUMN fee_mode TEXT NOT NULL DEFAULT 'pass' CHECK (fee_mode IN ('pass', 'absorb'));
