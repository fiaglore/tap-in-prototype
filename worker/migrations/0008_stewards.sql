-- Gate team: each steward has their own scanner key, so every scan can be traced to a person.
-- The event's shared gate key still works as a fallback; its scans have no steward.
CREATE TABLE IF NOT EXISTS stewards (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  key_hint      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_seen_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stewards_event ON stewards (event_id, created_at);

ALTER TABLE scans ADD COLUMN steward_id TEXT;
CREATE INDEX IF NOT EXISTS idx_scans_steward ON scans (steward_id);
