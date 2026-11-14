-- Per-person ticket limits and sales waves (early bird, then regular, and so on).
--   max_per_buyer        most tickets of this type one person can hold from purchases (2 by default; a group type can allow up to 5)
--   opens_at, closes_at  optional window for this ticket type alone, on top of the event's own sales window (unix seconds)
--   opens_after_tier_id  optional: this type only goes on sale once that other type has sold out
-- Only adds columns and a table, so code that does not know about them keeps working.
ALTER TABLE tiers ADD COLUMN max_per_buyer INTEGER NOT NULL DEFAULT 2;
ALTER TABLE tiers ADD COLUMN opens_at INTEGER;
ALTER TABLE tiers ADD COLUMN closes_at INTEGER;
ALTER TABLE tiers ADD COLUMN opens_after_tier_id TEXT;

-- Free tickets taken online have no order, so what each person has taken is counted here.
CREATE TABLE IF NOT EXISTS tier_buys (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  tier_id TEXT NOT NULL REFERENCES tiers (id),
  qty     INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tier_buys ON tier_buys (tier_id, user_id);
