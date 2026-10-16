-- Public "Play" page: events an organiser chooses to list so people can find them and open the sales page.
-- Existing events stay unlisted until their organiser turns it on.
ALTER TABLE events ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
