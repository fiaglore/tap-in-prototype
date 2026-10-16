-- Ticket types can carry a price so the public sales page has something to sell.
ALTER TABLE tiers ADD COLUMN price_kobo INTEGER NOT NULL DEFAULT 0;
