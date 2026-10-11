-- Tap In schema. Times are unix seconds (UTC).
-- Secrets (invite codes, OTPs, session tokens, gate keys) are never stored in
-- plain text: only HMAC-SHA-256 hashes keyed with the SECRET_PEPPER Worker secret.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  phone       TEXT UNIQUE,
  email       TEXT UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS otps (
  id           TEXT PRIMARY KEY,
  identifier   TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otps_identifier ON otps (identifier, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS rate_events (
  bucket  TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events (bucket, at);

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL REFERENCES users (id),
  name           TEXT NOT NULL,
  prefix         TEXT NOT NULL,
  venue          TEXT,
  city           TEXT,
  starts_at      INTEGER,
  allow_reentry  INTEGER NOT NULL DEFAULT 0,
  gate_key_hash  TEXT UNIQUE,
  gate_key_hint  TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_owner ON events (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS zones (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, name)
);

CREATE TABLE IF NOT EXISTS tiers (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, name)
);

CREATE TABLE IF NOT EXISTS tier_zones (
  tier_id  TEXT NOT NULL REFERENCES tiers (id) ON DELETE CASCADE,
  zone_id  TEXT NOT NULL REFERENCES zones (id) ON DELETE CASCADE,
  PRIMARY KEY (tier_id, zone_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  tier_id           TEXT NOT NULL REFERENCES tiers (id),
  code_hash         TEXT NOT NULL UNIQUE,
  code_hint         TEXT NOT NULL,
  label             TEXT,
  bound_identifier  TEXT,
  status            TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'claimed', 'revoked')),
  expires_at        INTEGER,
  claimed_by        TEXT REFERENCES users (id),
  claimed_at        INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_event ON invites (event_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_bound ON invites (bound_identifier) WHERE bound_identifier IS NOT NULL;

CREATE TABLE IF NOT EXISTS passes (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  tier_id     TEXT NOT NULL REFERENCES tiers (id),
  user_id     TEXT NOT NULL REFERENCES users (id),
  invite_id   TEXT NOT NULL UNIQUE REFERENCES invites (id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passes_user ON passes (user_id);
CREATE INDEX IF NOT EXISTS idx_passes_event ON passes (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scans (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  pass_id   TEXT,
  zone_id   TEXT,
  result    TEXT NOT NULL CHECK (result IN ('granted', 'denied')),
  reason    TEXT,
  once      INTEGER NOT NULL DEFAULT 0,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scans_event ON scans (event_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_pass ON scans (pass_id);
-- One granted entry per pass per zone when the event does not allow re-entry.
-- The database enforces it, so two gates scanning at the same instant cannot both let one pass in.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scans_single_entry ON scans (pass_id, zone_id) WHERE result = 'granted' AND once = 1;
