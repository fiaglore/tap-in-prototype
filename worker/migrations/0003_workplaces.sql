-- Phase 1: Tap In access for companies and offices.
-- A workplace is an event with kind = 'workplace': doors are zones, access groups (Staff, Contractor,
-- Visitor) are tiers. Groups can be limited to certain days and hours, and a pass can expire.

ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event', 'workplace'));
-- Minutes east of UTC used to read a group's working hours. 60 = West Africa Time (Lagos).
ALTER TABLE events ADD COLUMN tz_offset_min INTEGER NOT NULL DEFAULT 60;

-- days_mask: bit 0 = Monday ... bit 6 = Sunday. from_min/to_min: minutes after local midnight.
ALTER TABLE tiers ADD COLUMN days_mask INTEGER NOT NULL DEFAULT 127;
ALTER TABLE tiers ADD COLUMN from_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tiers ADD COLUMN to_min INTEGER NOT NULL DEFAULT 1440;

-- An invite can carry an end time that is copied onto the pass when it is claimed (visitors, contractors).
ALTER TABLE invites ADD COLUMN access_until INTEGER;
ALTER TABLE passes ADD COLUMN expires_at INTEGER;
