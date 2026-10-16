-- Phase 3: Tap In payments for customers and vendors.
-- Money is stored as integer kobo. Balances can never go negative: the CHECK constraints make the
-- database itself refuse a debit that would overdraw, and every money movement runs in one batch
-- (one transaction) with its ledger row, so a failure leaves nothing half-done.

CREATE TABLE IF NOT EXISTS wallets (
  user_id       TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  balance_kobo  INTEGER NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0 AND balance_kobo <= 500000000),
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vendors (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES users (id),
  name           TEXT NOT NULL,
  category       TEXT,
  listed         INTEGER NOT NULL DEFAULT 1,
  till_key_hash  TEXT UNIQUE,
  till_key_hint  TEXT,
  balance_kobo   INTEGER NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendors_owner ON vendors (owner_id, created_at DESC);

-- One row per money movement. payment: wallet -> vendor. refund: vendor -> wallet.
-- topup: money into a wallet. payout: money out of a vendor balance.
CREATE TABLE IF NOT EXISTS ledger (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('topup', 'payment', 'refund', 'payout')),
  user_id      TEXT REFERENCES users (id),
  vendor_id    TEXT REFERENCES vendors (id),
  amount_kobo  INTEGER NOT NULL CHECK (amount_kobo > 0),
  ref          TEXT,
  refund_of    TEXT REFERENCES ledger (id),
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_vendor ON ledger (vendor_id, created_at DESC);
-- A pay code works once: the same code can never create a second payment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_ref ON ledger (kind, ref) WHERE ref IS NOT NULL;
-- A payment can be refunded once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_refund ON ledger (refund_of) WHERE refund_of IS NOT NULL;
