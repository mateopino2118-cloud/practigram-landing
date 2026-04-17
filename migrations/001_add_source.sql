-- Migration: add source column to events for Meta / YouTube split
-- Run this ONCE against the production DB BEFORE deploying the code that
-- writes to the `source` column (api/track.js). Safe/idempotent — skips
-- the ALTER if the column already exists.
--
-- Usage:
--   psql "$DATABASE_URL" -f migrations/001_add_source.sql
--
-- All existing events are backfilled with 'meta' (the only source that
-- existed before this migration). The config table gets a unique constraint
-- on id so the per-source UPSERT (id=1 meta, id=2 youtube) works.

BEGIN;

-- 1. Events: add source column with default 'meta' so historical data is
--    correctly attributed to Meta ads (the only traffic source pre-YouTube).
ALTER TABLE events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'meta';

-- 2. Index to keep per-source Thompson Sampling queries fast. The redirect
--    endpoint groups events by (source, variant, type) over a time window.
CREATE INDEX IF NOT EXISTS idx_events_source_variant_type
  ON events (source, variant, type);

-- 3. Config: make id unique so INSERT ... ON CONFLICT (id) works for the
--    per-source upsert path. This is a no-op if id is already the PK
--    (which it almost certainly is), but the conditional keeps it safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'config'::regclass
      AND contype IN ('p', 'u')
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'config'::regclass AND attname = 'id')]
  ) THEN
    ALTER TABLE config ADD CONSTRAINT config_id_unique UNIQUE (id);
  END IF;
END $$;

COMMIT;

-- Verify:
--   SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='events' AND column_name='source';
--   SELECT indexname FROM pg_indexes WHERE tablename='events' AND indexname='idx_events_source_variant_type';
