-- Wristbands for confirmed guests. A wristband is one person's own scannable code, stored as a guest row
-- (kind 'import') that points at the invitation, pass or imported ticket it was made for.
--   wristband_of  the invitation / pass / imported ticket this wristband was made for
--   wb_seat       which person in the party (1..wb_seats); wb_gen is the generation, raised when one is replaced
--   wristbanded   set on the original once wristbands exist: its own code stops admitting, so nobody gets in twice
ALTER TABLE guests ADD COLUMN wristbanded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN wristband_of TEXT;
ALTER TABLE guests ADD COLUMN wb_seat INTEGER;
ALTER TABLE guests ADD COLUMN wb_seats INTEGER;
ALTER TABLE guests ADD COLUMN wb_gen INTEGER;
ALTER TABLE passes ADD COLUMN wristbanded INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_guests_wristband_of ON guests (wristband_of) WHERE wristband_of IS NOT NULL;
