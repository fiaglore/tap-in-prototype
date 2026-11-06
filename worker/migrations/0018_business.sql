-- Tap In for Business: departments and employee IDs, visitor check-out, incident log, and team access roles.

CREATE TABLE IF NOT EXISTS departments (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (event_id, name COLLATE NOCASE)
);
-- A person's department and employee ID live on their invite (a pass is made from an invite, so they follow the person).
ALTER TABLE invites ADD COLUMN department_id TEXT;
ALTER TABLE invites ADD COLUMN employee_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_invites_department ON invites (department_id) WHERE department_id IS NOT NULL;

-- Visitors can be checked out (by hand in the console). Scans only record entries, so without this nobody knows who has left.
ALTER TABLE guests ADD COLUMN checked_out_at INTEGER;

-- Security incidents and access problems an office wants on record.
CREATE TABLE IF NOT EXISTS incidents (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('security', 'access', 'safety', 'other')),
  summary      TEXT NOT NULL,
  details      TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  reported_by  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  resolved_by  TEXT,
  resolved_at  INTEGER,
  resolution   TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_event ON incidents (event_id, created_at DESC);

-- Configurable administrative permissions for an office (dossier 9.4). The owner can do everything. Others added here get:
--   viewer    read the reports (attendance, visitors, who has access, entries)
--   security  everything a viewer can, plus log incidents, check visitors out and see who is on site
-- identifier is the phone number or email they sign in with.
CREATE TABLE IF NOT EXISTS event_members (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('viewer', 'security')),
  added_by   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (event_id, identifier)
);
CREATE INDEX IF NOT EXISTS idx_event_members_identifier ON event_members (identifier);
