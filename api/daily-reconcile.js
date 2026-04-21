import { createClient } from '@supabase/supabase-js';

const ATTIO_ONB_FIELD = 'Attio ONB ID';
const PROJECT_OPT_FIELDS =
  'name,gid,archived,completed,custom_fields.name,custom_fields.text_value,custom_fields.display_value';
const PORTFOLIOS = [
  { gid: '1209745158203291', name: 'OB Customers' },
  { gid: '1213027143201381', name: 'Clientes Solicitudes' },
];
const ONBOARDING_TEAM_GID = '1204050191559311';
// How far back to look for status updates (days)
const LOOKBACK_DAYS = 7;

/**
 * POST /api/daily-reconcile
 *
 * Reconciliación diaria: detecta status updates de Asana que no tienen
 * un sync_event completado y los procesa.
 *
 * Diseñado para ejecutarse una vez al día vía Vercel cron.
 * También se puede disparar manualmente desde el dashboard.
 *
 * Retorna un resumen de qué proyectos se revisaron y cuáles generaron notas.
 */
export const config = { api: { bodyParser: true }, maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'ASANA_ACCESS_TOKEN not set' });

  const supabase = getSupabase();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // ── 1. Collect all active projects with a valid Attio ONB ID ──────
  const projects = await collectProjects(token);
  const active = projects.filter((p) => {
    if (p.archived || p.completed) return false;
    const cf = p.custom_fields || [];
    const field = cf.find((f) => f.name === ATTIO_ONB_FIELD);
    const val = field?.text_value || field?.display_value || null;
    p._attioRecordId = val && /^[0-9a-f-]{36}$/i.test(val) ? val : null;
    return !!p._attioRecordId;
  });

  console.log(`[daily-reconcile] ${active.length} active projects with Attio ID`);

  // ── 2. Load already-processed status GIDs from Supabase ───────────
  // Pull all sync_events with asana_status_gid that are completed or pending
  // (pending = already queued, don't duplicate)
  const { data: existingRows } = await supabase
    .from('sync_events')
    .select('asana_status_gid')
    .not('asana_status_gid', 'is', null)
    .in('status', ['pending', 'processing', 'completed']);

  const processedGids = new Set((existingRows || []).map((r) => r.asana_status_gid));
  console.log(`[daily-reconcile] ${processedGids.size} already-processed status GIDs`);

  // ── 3. For each project, check recent status updates ─────────────
  const summary = { checked: 0, new_syncs: 0, already_synced: 0, errors: 0, details: [] };

  for (const project of active) {
    summary.checked++;
    try {
      const statuses = await fetchProjectStatuses(project.gid, token, since);
      if (statuses.length === 0) continue;

      for (const status of statuses) {
        if (processedGids.has(status.gid)) {
          summary.already_synced++;
          continue;
        }

        // New status update — insert sync_event and process it
        const { data: inserted, error: insertErr } = await supabase
          .from('sync_events')
          .insert({
            source: 'asana',
            event_type: 'status_update',
            asana_project_gid: project.gid,
            attio_record_id: project._attioRecordId,
            asana_status_gid: status.gid,
            payload: { events: [{ resource: { gid: status.gid, resource_type: 'project_status' }, action: 'added', _source: 'daily-reconcile' }] },
            status: 'pending',
          })
          .select('id')
          .single();

        if (insertErr) {
          // Unique constraint violation = already queued by another path — skip
          if (insertErr.code === '23505') {
            summary.already_synced++;
            continue;
          }
          console.warn(`[daily-reconcile] Insert error for ${project.gid}:`, insertErr.message);
          summary.errors++;
          continue;
        }

        processedGids.add(status.gid);

        // Process synchronously
        const origin = getOrigin(req);
        const syncRes = await fetch(`${origin}/api/onboarding-sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sync_event_id: inserted.id }),
        });
        const syncResult = await syncRes.json().catch(() => ({}));
        summary.new_syncs++;
        summary.details.push({
          project: project.name,
          project_gid: project.gid,
          status_gid: status.gid,
          status_title: status.title,
          status_created_at: status.created_at,
          note_created: syncResult.note_created ?? false,
          sync_event_id: inserted.id,
        });
      }
    } catch (e) {
      console.warn(`[daily-reconcile] Error for ${project.name}:`, e.message);
      summary.errors++;
    }
  }

  console.log(`[daily-reconcile] Done — checked:${summary.checked} new:${summary.new_syncs} already:${summary.already_synced} errors:${summary.errors}`);
  return res.status(200).json({ success: true, ...summary });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function collectProjects(token) {
  const seenGids = new Set();
  const projects = [];

  for (const portfolio of PORTFOLIOS) {
    let nextPage = null;
    do {
      const url = nextPage
        ? `https://app.asana.com/api/1.0${nextPage}`
        : `https://app.asana.com/api/1.0/portfolios/${portfolio.gid}/items?opt_fields=${PROJECT_OPT_FIELDS}&limit=100`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) break;
      const json = await r.json();
      for (const item of json.data || []) {
        if (!seenGids.has(item.gid)) { seenGids.add(item.gid); projects.push(item); }
      }
      nextPage = json.next_page?.path || null;
    } while (nextPage);
  }

  // Team fallback
  let nextPage = null;
  do {
    const url = nextPage
      ? `https://app.asana.com/api/1.0${nextPage}`
      : `https://app.asana.com/api/1.0/projects?team=${ONBOARDING_TEAM_GID}&opt_fields=${PROJECT_OPT_FIELDS}&limit=100`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) break;
    const json = await r.json();
    for (const item of json.data || []) {
      if (!seenGids.has(item.gid)) { seenGids.add(item.gid); projects.push(item); }
    }
    nextPage = json.next_page?.path || null;
  } while (nextPage);

  return projects;
}

async function fetchProjectStatuses(projectGid, token, since) {
  const url = `https://app.asana.com/api/1.0/projects/${projectGid}/project_statuses` +
    `?opt_fields=gid,title,color,created_at&limit=10`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const json = await r.json();
  return (json.data || []).filter((s) => s.created_at >= since);
}

function getOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return process.env.APP_URL || `${protocol}://${host}`;
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}
