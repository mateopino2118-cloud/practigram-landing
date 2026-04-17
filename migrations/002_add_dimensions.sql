-- Migration: add device / country / hour_local dimensions to events.
-- These let us cut conversion data by traffic dimension (mobile vs desktop,
-- AR vs MX, hora del día) — gaps that the panel cannot answer today.
--
-- Run ONCE before deploying the api/track.js + api/redirect.js code that
-- writes to these columns. Safe and idempotent.
--
-- Usage:
--   node migrations/run.js migrations/002_add_dimensions.sql
--
-- Backfill: existing rows stay NULL on the new columns. Phase 3 vistas
-- will ignore NULLs (`WHERE device IS NOT NULL`) so historical data still
-- contributes to the existing KPIs but not to device/country/hour cuts.

BEGIN;

-- 1. New dimensions. NULL allowed because parsing can fail or older rows
--    predate the migration. We never NEED these to be present.
ALTER TABLE events ADD COLUMN IF NOT EXISTS device     TEXT;     -- 'mobile' | 'desktop' | 'tablet'
ALTER TABLE events ADD COLUMN IF NOT EXISTS country    TEXT;     -- ISO-2: 'AR', 'MX', 'CO'...
ALTER TABLE events ADD COLUMN IF NOT EXISTS hour_local SMALLINT; -- 0..23 in America/Argentina/Buenos_Aires

-- 2. New index to speed up date-range queries on a single variant.
--    The auditoría detected that today any (variant, type, date_range) query
--    does a partial scan because the only index is (source, variant, type).
CREATE INDEX IF NOT EXISTS idx_events_variant_type_created
  ON events (variant, type, created_at);

-- 3. Indexes for the new dimensions (Phase 3 vistas will group by these).
CREATE INDEX IF NOT EXISTS idx_events_country ON events (country) WHERE country IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_device  ON events (device)  WHERE device  IS NOT NULL;

COMMIT;

-- Verify (run manually after):
--   SELECT column_name FROM information_schema.columns WHERE table_name='events' ORDER BY column_name;
--   SELECT indexname FROM pg_indexes WHERE tablename='events';
