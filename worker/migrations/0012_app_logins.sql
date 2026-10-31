-- Signing in on the phone app. The emailed sign-in link opens in the browser, which has its own cookies, so the browser
-- leaves a one-time note for the app that asked for the link, and the app collects it.
--   challenge_hash  keyed hash of the challenge the app sent (the app keeps the secret it came from; the note is useless without it)
--   redeemed_at     set when the app collects the note, so it works once
CREATE TABLE IF NOT EXISTS app_logins (
  challenge_hash TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  redeemed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_app_logins_expires ON app_logins (expires_at);
