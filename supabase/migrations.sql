-- Run this in Supabase SQL Editor after schema.sql
-- ============================================================
--  USER PREFERENCES  (one row per user — theme, avatar, name)
-- ============================================================
-- ============================================================
--  PROJECT & TODO COLUMN ADDITIONS
-- ============================================================

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS code         TEXT    DEFAULT '';
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS todo_counter INTEGER DEFAULT 0;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS tabs         JSONB   DEFAULT '[]'::jsonb;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS notes        JSONB   DEFAULT '[]'::jsonb;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS tools        JSONB   DEFAULT '[]'::jsonb;

ALTER TABLE public.todos ADD COLUMN IF NOT EXISTS number   INTEGER DEFAULT 0;
ALTER TABLE public.todos ADD COLUMN IF NOT EXISTS tool_ids JSONB   DEFAULT '[]'::jsonb;
ALTER TABLE public.todos ADD COLUMN IF NOT EXISTS tags     JSONB   DEFAULT '[]'::jsonb;

ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS general_notes JSONB DEFAULT '[]'::jsonb;


CREATE TABLE IF NOT EXISTS public.user_preferences (
    user_id      UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    theme        TEXT        NOT NULL DEFAULT 'light',
    avatar_color TEXT,
    display_name TEXT,
    updated_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_preferences: own row only"
    ON public.user_preferences FOR ALL
    USING  (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
