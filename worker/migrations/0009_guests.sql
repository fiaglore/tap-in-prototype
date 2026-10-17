-- Guests: people on a list who do not need a Tap In account.
--  kind 'invite': a private-event invitation (wedding, party, launch). The guest opens a link, answers the RSVP and
--                 shows the QR on that page; its code is derived from the id, so nothing secret is stored.
--  kind 'import': a ticket sold somewhere else (another ticketer, a bank-transfer list). Its code is stored only as a
--                 keyed hash, scoped to the event, and checked at the gate like a pass.
CREATE TABLE IF NOT EXISTS guests (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  tier_id      TEXT NOT NULL REFERENCES tiers (id),
  kind         TEXT NOT NULL CHECK (kind IN ('invite', 'import')),
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
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guests_event ON guests (event_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_guests_code ON guests (event_id, code_hash) WHERE code_hash IS NOT NULL;

-- A guest's party is let in with one scan; without re-entry, once per area.
ALTER TABLE scans ADD COLUMN guest_id TEXT;
CREATE INDEX IF NOT EXISTS idx_scans_guest ON scans (guest_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_scans_guest_entry ON scans (guest_id, zone_id) WHERE result = 'granted' AND once = 1 AND guest_id IS NOT NULL;
