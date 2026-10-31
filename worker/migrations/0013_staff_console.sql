-- The Tap In team's support console (/admin/).
--   users.suspended_at  set when the team suspends an account: it cannot sign in, and its sessions are ended
--   audit_log           everything the team does, and which person's page they opened: who, what, to whom, why.
--                       It is only ever added to. staff_id has no foreign key so the record outlives the account.
ALTER TABLE users ADD COLUMN suspended_at INTEGER;

CREATE TABLE IF NOT EXISTS audit_log (
  id                TEXT PRIMARY KEY,
  at                INTEGER NOT NULL,
  staff_id          TEXT NOT NULL,
  staff_identifier  TEXT NOT NULL,
  action            TEXT NOT NULL,
  target_type       TEXT,
  target_id         TEXT,
  reason            TEXT,
  detail            TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log (target_type, target_id, at DESC);
