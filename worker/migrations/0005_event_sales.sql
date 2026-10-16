-- Phase 2: events and concerts. Ticket capacity, sales windows, and an optional rotating QR.

-- Most tickets that may be issued for this ticket type (revoked invites do not count). NULL = no limit.
ALTER TABLE tiers ADD COLUMN capacity INTEGER;

-- Unix seconds. NULL = no limit on that side.
ALTER TABLE events ADD COLUMN sales_start INTEGER;
ALTER TABLE events ADD COLUMN sales_end INTEGER;

-- 1 = the pass QR changes every 30 seconds, so a screenshot stops working. Needs the phone to be online.
ALTER TABLE events ADD COLUMN secure_qr INTEGER NOT NULL DEFAULT 0;
