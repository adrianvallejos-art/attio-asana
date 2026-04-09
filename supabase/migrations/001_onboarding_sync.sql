-- ============================================================
-- Attio-Asana Sync: Schema completo
-- Ejecutar en: Supabase → SQL Editor → New Query → Run
-- ============================================================

-- 1. Mapping entre proyectos Asana y records Attio Onboarding
CREATE TABLE IF NOT EXISTS onboarding_mapping (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  attio_record_id    TEXT UNIQUE NOT NULL,
  asana_project_gid  TEXT UNIQUE NOT NULL,
  assigned_onb_email TEXT,
  slack_user_id      TEXT,
  team               TEXT DEFAULT 'onboarding',
  active             BOOLEAN DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

-- 2. Cola de eventos de sincronización
CREATE TABLE IF NOT EXISTS sync_events (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source            TEXT NOT NULL CHECK (source IN ('asana', 'attio')),
  event_type        TEXT NOT NULL,
  asana_project_gid TEXT,
  attio_record_id   TEXT,
  payload           JSONB NOT NULL DEFAULT '{}',
  ai_analysis       JSONB,
  status            TEXT DEFAULT 'pending'
                      CHECK (status IN ('pending','processing','awaiting_approval','approved','rejected','completed','failed')),
  error_message     TEXT,
  retry_count       INT DEFAULT 0,
  slack_thread_ts   TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- 3. Webhook subscriptions de Asana
CREATE TABLE IF NOT EXISTS asana_webhook_subs (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  asana_project_gid TEXT NOT NULL,
  webhook_gid       TEXT UNIQUE NOT NULL,
  active            BOOLEAN DEFAULT true,
  x_hook_secret     TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_sync_events_status ON sync_events(status);
CREATE INDEX IF NOT EXISTS idx_sync_events_attio  ON sync_events(attio_record_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_asana  ON sync_events(asana_project_gid);
CREATE INDEX IF NOT EXISTS idx_mapping_team       ON onboarding_mapping(team) WHERE active = true;

-- RLS
ALTER TABLE onboarding_mapping  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE asana_webhook_subs  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all" ON onboarding_mapping FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON sync_events        FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON asana_webhook_subs  FOR ALL USING (true) WITH CHECK (true);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_onboarding_mapping_updated
  BEFORE UPDATE ON onboarding_mapping
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_sync_events_updated
  BEFORE UPDATE ON sync_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
