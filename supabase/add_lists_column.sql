-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Adds the `lists` column used by the Lists tab feature.

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS lists JSONB DEFAULT '[]'::jsonb;
