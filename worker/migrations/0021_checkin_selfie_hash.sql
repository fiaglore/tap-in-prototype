-- A fingerprint of each check-in selfie, so a picture that was already used for a check-in cannot be sent again. It cannot be turned back into the picture.
ALTER TABLE checkins ADD COLUMN selfie_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_checkins_selfie_hash ON checkins (pass_id, selfie_hash) WHERE selfie_hash IS NOT NULL;
