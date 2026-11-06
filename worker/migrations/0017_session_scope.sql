-- Separate sign-ins for the app and the organiser/Business console. Signing in to one no longer signs you in to the other.
-- A session belongs to one area: 'app' (passes, the attendee app) or 'console' (the organiser and Business consoles).
-- Sessions that exist today become 'app' sessions, so organisers sign in to the console once more (or link their app account when asked).
ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'app' CHECK (scope IN ('app', 'console'));
