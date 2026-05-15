-- Run in Supabase SQL Editor
-- Adds email_prefs column for Gmail integration settings and thread metadata.

ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS email_prefs JSONB DEFAULT '{}'::jsonb;
