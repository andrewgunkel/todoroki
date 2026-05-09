-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Safe to run multiple times — all statements use IF NOT EXISTS / IF EXISTS guards.

-- ============================================================
--  PROJECTS — icon, color
-- ============================================================
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS color TEXT    DEFAULT NULL;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS icon  TEXT    DEFAULT NULL;

-- ============================================================
--  TODOS — comments, completed_at, schedule
-- ============================================================
ALTER TABLE public.todos ADD COLUMN IF NOT EXISTS comments     JSONB  DEFAULT '[]'::jsonb;
ALTER TABLE public.todos ADD COLUMN IF NOT EXISTS completed_at BIGINT DEFAULT NULL;
ALTER TABLE public.todos ADD COLUMN IF NOT EXISTS schedule     JSONB  DEFAULT NULL;

-- ============================================================
--  USER PREFERENCES — anthropic_api_key
-- ============================================================
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT DEFAULT NULL;
