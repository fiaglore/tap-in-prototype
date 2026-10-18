-- Visitors for Tap In for Business: invited ahead with a one-tap link, or checked in at the door as a walk-in.
-- They are guests of kind 'visitor', with who they are visiting, why, and the window their pass works in.
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt (it is new and small).
CREATE TABLE guests_new (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  tier_id      TEXT NOT NULL REFERENCES tiers (id),
  kind         TEXT NOT NULL CHECK (kind IN ('invite', 'import', 'visitor')),
  name         TEXT NOT NULL,
  contact      TEXT,
  party_size   INTEGER NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 20),
  table_label  TEXT,
  code_hash    TEXT,
  code_hint    TEXT,
  rsvp         TEXT NOT NULL DEFAULT 'pending' CHECK (rsvp IN ('pending', 'yes', 'no')),
  attending    INTEGER,
  rsvp_at      INTEGER,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at   INTEGER NOT NULL,
  host         TEXT,
  purpose      TEXT,
  valid_from   INTEGER,
  valid_until  INTEGER,
  walk_in      INTEGER NOT NULL DEFAULT 0
);
INSERT INTO guests_new (id, event_id, tier_id, kind, name, contact, party_size, table_label, code_hash, code_hint, rsvp, attending, rsvp_at, status, created_at)
  SELECT id, event_id, tier_id, kind, name, contact, party_size, table_label, code_hash, code_hint, rsvp, attending, rsvp_at, status, created_at FROM guests;
DROP TABLE guests;
ALTER TABLE guests_new RENAME TO guests;
CREATE INDEX IF NOT EXISTS idx_guests_event ON guests (event_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_guests_code ON guests (event_id, code_hash) WHERE code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_guests_visits ON guests (event_id, valid_from) WHERE kind = 'visitor';
