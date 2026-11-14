-- Tap In for Business: secure self check-in. Staff scan a QR code that changes every 30 seconds on a screen at the
-- office, their phone proves it is at the office (location), and now and then, at random, it takes a live selfie.
-- Offices that do not turn it on are unaffected.
ALTER TABLE events ADD COLUMN checkin_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN checkin_lat REAL;
ALTER TABLE events ADD COLUMN checkin_lng REAL;
ALTER TABLE events ADD COLUMN checkin_radius_m INTEGER NOT NULL DEFAULT 150;
ALTER TABLE events ADD COLUMN checkin_max_accuracy_m INTEGER NOT NULL DEFAULT 100;
-- off: never ask for a selfie. random: ask some of the time (see below). always: ask every time.
ALTER TABLE events ADD COLUMN checkin_selfie_mode TEXT NOT NULL DEFAULT 'random' CHECK (checkin_selfie_mode IN ('off', 'random', 'always'));
-- In random mode, the chance (percent) a person is asked for a selfie. Someone who is punctual and rarely skips work is
-- asked about checkin_selfie_min_pct of the time; someone new, or with a patchy record, checkin_selfie_max_pct.
ALTER TABLE events ADD COLUMN checkin_selfie_max_pct INTEGER NOT NULL DEFAULT 50;
ALTER TABLE events ADD COLUMN checkin_selfie_min_pct INTEGER NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS checkins (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  pass_id          TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  day              INTEGER NOT NULL,           -- local day number (days since 1970-01-01 in the office's time zone)
  at               INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('ok', 'rejected')),
  reason           TEXT,                       -- why a check-in was refused: outside_location, ...
  lat              REAL,
  lng              REAL,
  accuracy_m       INTEGER,
  distance_m       INTEGER,
  selfie_chance    INTEGER,                    -- percent chance the person had of being asked, shown to the owner
  selfie_required  INTEGER NOT NULL DEFAULT 0,
  selfie_b64       TEXT,                       -- kept 30 days, then cleared (see purge)
  flags            TEXT NOT NULL DEFAULT ''    -- comma separated: weak_gps, no_gps
);
CREATE INDEX IF NOT EXISTS idx_checkins_event ON checkins (event_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_pass ON checkins (pass_id, at DESC);
-- One accepted check-in per person per day.
CREATE UNIQUE INDEX IF NOT EXISTS uq_checkins_day ON checkins (pass_id, day) WHERE status = 'ok';
