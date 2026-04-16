import { createClient } from '@supabase/supabase-js';

const ONBOARDING_TEAM_GID = '1204050191559311';
const ATTIO_ONB_FIELD = 'Attio ONB ID';
const PROJECT_OPT_FIELDS = 'name,gid,archived,completed,created_at,custom_fields.name,custom_fields.text_value,custom_fields.display_value,current_status.color,current_status.title';

// All portfolios to query — { gid, name }
const PORTFOLIOS = [
  { gid: '1209745158203291', name: 'OB Customers' },
  { gid: '1213027143201381', name: 'Clientes Solicitudes' },
];

/**
 * GET /api/dashboard-data
 *
 * Returns all Onboarding projects from Asana (portfolio-first, team as fallback)
 * joined with their sync state from Supabase.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'ASANA_ACCESS_TOKEN not set' });

  const supabase = getSupabase();

  // ── 1. Fetch projects from all portfolios ─────────────────────
  const seenGids = new Set();
  let projects = [];

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
        if (!seenGids.has(item.gid)) {
          seenGids.add(item.gid);
          item._portfolio = portfolio.name;
          projects.push(item);
        }
        // If already seen from another portfolio, keep first (priority order above)
      }
      nextPage = json.next_page?.path || null;
    } while (nextPage);
  }

  // ── 1b. Fallback: Onboarding team projects not in any portfolio ──
  {
    let nextPage = null;
    do {
      const url = nextPage
        ? `https://app.asana.com/api/1.0${nextPage}`
        : `https://app.asana.com/api/1.0/projects?team=${ONBOARDING_TEAM_GID}&opt_fields=${PROJECT_OPT_FIELDS}&limit=100`;

      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) break;

      const json = await r.json();
      for (const item of json.data || []) {
        if (!seenGids.has(item.gid)) {
          seenGids.add(item.gid);
          item._portfolio = 'Onboarding';
          projects.push(item);
        }
      }
      nextPage = json.next_page?.path || null;
    } while (nextPage);
  }

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

    const cf = project.custom_fields || [];

    const attioField = cf.find((f) => f.name === ATTIO_ONB_FIELD);
    const attioRecordId = attioField?.text_value || attioField?.display_value || null;
    const isValidUuid = attioRecordId && /^[0-9a-f-]{36}$/i.test(attioRecordId);

    const attioCompanyField = cf.find((f) => f.name === 'Attio Company ID');
    const attioCompanyId = attioCompanyField?.text_value || attioCompanyField?.display_value || null;

    const atomIdField = cf.find((f) => f.name === 'Atom ID');
    const atomId = atomIdField?.text_value || atomIdField?.display_value || null;

    // Auto-extract Atom ID from project name: "Company (AtomID)" → "AtomID"
    const nameMatch = project.name?.match(/\(([^)]+)\)\s*$/);
    const atomIdFromName = nameMatch ? nameMatch[1].trim() : null;

    const cicloDeVidaField = cf.find((f) => f.name === 'Ciclo de vida');
    const cicloDeVida = cicloDeVidaField?.display_value || null;

    const portfolio = project._portfolio || PORTFOLIO_NAME;

    // Field GIDs needed to PATCH custom fields back to Asana
    const fieldGids = {
      attio_onb_id: attioField?.gid || null,
      attio_company_id: attioCompanyField?.gid || null,
      atom_id: atomIdField?.gid || null,
    };

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

    const statusTitle = project.current_status?.title?.trim() || null;
    const statusColor = project.current_status?.color || null;
    const CLOSED_STATUSES = ['finalizado', 'descartado'];
    const is_closed = !!project.archived ||
      !!project.completed ||
      statusColor === 'complete' ||
      (statusTitle && CLOSED_STATUSES.some(s => statusTitle.toLowerCase().includes(s)));

    return {
      gid,
      name: project.name?.trim(),
      created_at: project.created_at || null,
      is_closed,
      asana_status_title: statusTitle,
      attio_record_id: isValidUuid ? attioRecordId : null,
      attio_id_raw: attioRecordId,
      attio_company_id: attioCompanyId,
      atom_id: atomId,
      atom_id_from_name: atomId ? null : atomIdFromName,
      ciclo_de_vida: cicloDeVida,
      portfolio,
      field_gids: fieldGids,
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
