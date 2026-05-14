-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Adds the ical_token column for iCal feed authentication.

ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS ical_token TEXT DEFAULT NULL;

-- Optional: index for fast token lookups
CREATE UNIQUE INDEX IF NOT EXISTS user_preferences_ical_token_idx
    ON public.user_preferences (ical_token)
    WHERE ical_token IS NOT NULL;
