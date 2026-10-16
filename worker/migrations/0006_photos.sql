-- Selfie on the pass. A person keeps one small photo (a 256px JPEG, stored as base64 text). It is shown only to door
-- staff scanning a pass for an event that asks for it (events.require_photo), never listed or exported.
ALTER TABLE events ADD COLUMN require_photo INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_photos (
  user_id     TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  jpeg_b64    TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  set_count   INTEGER NOT NULL DEFAULT 1
);
