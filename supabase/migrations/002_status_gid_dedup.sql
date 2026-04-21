-- ============================================================
-- Migration 002: deduplicación de status updates por GID
-- Ejecutar en: Supabase → SQL Editor → New Query → Run
-- ============================================================

-- Columna para almacenar el GID del project_status de Asana
ALTER TABLE sync_events
  ADD COLUMN IF NOT EXISTS asana_status_gid text;

-- Índice único: un mismo status_gid nunca genera dos filas
-- (parcial: solo aplica cuando no es NULL)
CREATE UNIQUE INDEX IF NOT EXISTS sync_events_asana_status_gid_unique
  ON sync_events(asana_status_gid)
  WHERE asana_status_gid IS NOT NULL;

-- Índice de soporte para búsquedas por project + status_gid
CREATE INDEX IF NOT EXISTS sync_events_project_status_gid_idx
  ON sync_events(asana_project_gid, asana_status_gid)
  WHERE asana_status_gid IS NOT NULL;
