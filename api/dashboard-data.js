import { createClient } from '@supabase/supabase-js';

const ONBOARDING_TEAM_GID = '1204050191559311';
const ATTIO_ONB_FIELD = 'Attio ONB ID';

/**
 * GET /api/dashboard-data
 *
 * Returns all Onboarding projects from Asana joined with
 * their sync state from Supabase.
 *
 * Each project includes:
 *   - name, gid
 *   - attio_record_id (from Asana custom field)
 *   - has_webhook (registered in asana_webhook_subs)
 *   - has_mapping (registered in onboarding_mapping)
 *   - last_sync  (most recent sync_event)
 *   - sync_history (last 5 events)
 *   - status: 'ok' | 'no_attio_id' | 'no_webhook' | 'sync_failed' | 'never_synced'
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Allow CORS for the dashboard
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'ASANA_ACCESS_TOKEN not set' });

  const supabase = getSupabase();

  // ── 1. Fetch all projects from Onboarding team ─────────────────
  let projects = [];
  let nextPage = null;

  do {
    const url = nextPage
      ? `https://app.asana.com/api/1.0${nextPage}`
      : `https://app.asana.com/api/1.0/projects?team=${ONBOARDING_TEAM_GID}&opt_fields=name,gid,archived,custom_fields.name,custom_fields.text_value,custom_fields.display_value,current_status.color&limit=100`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(500).json({ error: `Asana fetch failed: ${r.status}` });

    const json = await r.json();
    projects = projects.concat(json.data || []);
    nextPage = json.next_page?.path || null;
  } while (nextPage);

  // ── 2. Load Supabase state in bulk ─────────────────────────────
  const projectGids = projects.map((p) => p.gid);

  const [{ data: mappings }, { data: webhooks }, { data: recentEvents }] = await Promise.all([
    supabase.from('onboarding_mapping').select('*').in('asana_project_gid', projectGids),
    supabase.from('asana_webhook_subs').select('*').in('asana_project_gid', projectGids).eq('active', true),
    supabase.from('sync_events')
      .select('*')
      .in('asana_project_gid', projectGids)
      .order('created_at', { ascending: false })
      .limit(200),
  ]);

  const mappingByProject = Object.fromEntries((mappings || []).map((m) => [m.asana_project_gid, m]));
  const webhookByProject = Object.fromEntries((webhooks || []).map((w) => [w.asana_project_gid, w]));

  // Group events by project (last 5 each)
  const eventsByProject = {};
  for (const evt of recentEvents || []) {
    if (!eventsByProject[evt.asana_project_gid]) eventsByProject[evt.asana_project_gid] = [];
    if (eventsByProject[evt.asana_project_gid].length < 5) {
      eventsByProject[evt.asana_project_gid].push(evt);
    }
  }

  // ── 3. Build project list ────────────────────────────────────────
  const result = projects.map((project) => {
    const gid = project.gid;

    const attioField = project.custom_fields?.find((f) => f.name === ATTIO_ONB_FIELD);
    const attioRecordId = attioField?.text_value || attioField?.display_value || null;
    const isValidUuid = attioRecordId && /^[0-9a-f-]{36}$/i.test(attioRecordId);

    const mapping = mappingByProject[gid] || null;
    const webhook = webhookByProject[gid] || null;
    const events = eventsByProject[gid] || [];
    const lastEvent = events[0] || null;

    // Determine status
    let status;
    if (!isValidUuid) {
      status = 'no_attio_id';
    } else if (!webhook) {
      status = 'no_webhook';
    } else if (lastEvent?.status === 'failed') {
      status = 'sync_failed';
    } else if (!lastEvent) {
      status = 'never_synced';
    } else {
      status = 'ok';
    }

    return {
      gid,
      name: project.name?.trim(),
      is_closed: !!project.archived,
      attio_record_id: isValidUuid ? attioRecordId : null,
      attio_id_raw: attioRecordId,   // shows even if malformed
      has_mapping: !!mapping,
      has_webhook: !!webhook,
      webhook_gid: webhook?.webhook_gid || null,
      asana_status_color: project.current_status?.color || null,
      status,
      last_sync: lastEvent
        ? {
            id: lastEvent.id,
            event_type: lastEvent.event_type,
            status: lastEvent.status,
            created_at: lastEvent.created_at,
            error_message: lastEvent.error_message || null,
            note_created: lastEvent.ai_analysis?.note_created ?? null,
          }
        : null,
      sync_history: events.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        status: e.status,
        created_at: e.created_at,
        error_message: e.error_message || null,
        note_created: e.ai_analysis?.note_created ?? null,
      })),
    };
  });

  // Sort: failed first, then no_attio_id, no_webhook, never_synced, ok
  const order = { sync_failed: 0, no_webhook: 1, no_attio_id: 2, never_synced: 3, ok: 4 };
  result.sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5));

  const summary = {
    total: result.length,
    active: result.filter((p) => !p.is_closed).length,
    closed: result.filter((p) => p.is_closed).length,
    ok: result.filter((p) => p.status === 'ok').length,
    no_attio_id: result.filter((p) => p.status === 'no_attio_id').length,
    no_webhook: result.filter((p) => p.status === 'no_webhook').length,
    never_synced: result.filter((p) => p.status === 'never_synced').length,
    sync_failed: result.filter((p) => p.status === 'sync_failed').length,
  };

  return res.status(200).json({ summary, projects: result });
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}
