-- Base schema: tablas events + config.
-- Correr UNA VEZ contra la DB Postgres (Supabase) ANTES de las migrations 001 y 002.
--
-- Usage:
--   psql "$DATABASE_URL" -f templates/sql/000_schema.sql

BEGIN;

-- Tabla principal de eventos. Todas las acciones del funnel se loguean acá:
-- impression, conversion, qualified, whatsapp, quiz_start, quiz_complete,
-- form_start, exit_popup_*, dwell_c, dwell_u, *_b{bucket}, etc.
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  variant     TEXT        NOT NULL,        -- v1, v2, ..., vN
  type        TEXT        NOT NULL,        -- ver lista arriba
  value_int   INTEGER,                     -- usado por dwell_c/dwell_u (ms)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_variant_type ON events (variant, type);
CREATE INDEX IF NOT EXISTS idx_events_created_at  ON events (created_at);

-- Tabla de configuración del experimento (1 row por source: 1=meta, 2=youtube).
-- El campo data es JSONB y contiene:
--   { mode, activeVariants, retiredVariants, queue, roundStartedAt,
--     rotationLog, experimentStart, weights, rotationMinImpressions,
--     championProtect, autoRotate, ... }
CREATE TABLE IF NOT EXISTS config (
  id          INTEGER PRIMARY KEY,
  data        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Config inicial para Meta (id=1) — modo equitable, sin variantes activas.
-- Cuando corras /landing-lab init la skill va a sobreescribir activeVariants.
INSERT INTO config (id, data) VALUES (
  1,
  '{"mode":"equitable","activeVariants":[],"retiredVariants":[],"queue":[],"roundStartedAt":null,"rotationLog":[],"autoRotate":true,"rotationMinImpressions":500,"championProtect":2}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Verify:
--   SELECT table_name FROM information_schema.tables WHERE table_name IN ('events','config');
--   SELECT * FROM config;
