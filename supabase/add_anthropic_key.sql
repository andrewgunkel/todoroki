-- Migration: Add anthropic_api_key column to user_preferences
-- Run this in the Supabase SQL editor for your project.
-- Safe to run multiple times (IF NOT EXISTS guard).

ALTER TABLE public.user_preferences
    ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT DEFAULT NULL;
