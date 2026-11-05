-- Migration 003: add subcategoria column to meta_waba_alerts
ALTER TABLE meta_waba_alerts ADD COLUMN IF NOT EXISTS subcategoria TEXT;
