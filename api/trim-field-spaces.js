import { createClient } from '@supabase/supabase-js';
import { updateProjectCustomFields, createWebhook } from './_asanaHelper.js';

const PORTFOLIOS = [
  { gid: '1209745158203291', name: 'OB Customers' },
  { gid: '1213027143201381', name: 'Clientes Solicitudes' },
];
const ONBOARDING_TEAM_GID = '1204050191559311';
const OPT_FIELDS =
  'name,gid,custom_fields.name,custom_fields.gid,custom_fields.text_value,custom_fields.display_value';
const FIELDS_TO_TRIM = ['Atom ID', 'Attio Company ID', 'Attio ONB ID'];
const UUID_RE = /^[0-9a-f-]{36}$/i;
const CONCURRENCY = 10;

/**
 * POST /api/trim-field-spaces
 *
 * Para todos los proyectos de todos los portfolios:
 *   1. Detecta espacios en Atom ID, Attio Company ID, Attio ONB ID
 *   2. Trimea y escribe el valor limpio en Asana
 *   3. Si el ONB ID era inválido por espacios y ahora es un UUID válido:
 *      → registra webhook + procesa el último status update perdido
 *
 * Params: dry_run (default true), offset, limit (default 30)
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'ASANA_ACCESS_TOKEN not set' });

  const { dry_run = true, offset = 0, limit = 30 } = req.body || {};
  const supabase = getSupabase();

  // ── 1. Collect all projects ───────────────────────────────────────
  const projects = await collectAllProjects(token);

  // ── 2. Find candidates: projects with at least one field with spaces ─
  const candidates = [];
  for (const project of projects) {
    const cf = project.custom_fields || [];
    const dirty = [];

    for (const fieldName of FIELDS_TO_TRIM) {
      const field = cf.find((f) => f.name === fieldName);
      if (!field?.gid) continue;
      const raw = field.text_value || field.display_value || '';
      const trimmed = raw.trim();
      if (raw !== trimmed && raw.length > 0) {
        dirty.push({ fieldName, gid: field.gid, raw, trimmed });
      }
    }

    if (dirty.length === 0) continue;

    const onbField  = cf.find((f) => f.name === 'Attio ONB ID');
    const rawOnbId  = onbField?.text_value || onbField?.display_value || '';
    const trimmedOnbId = rawOnbId.trim();
    const wasInvalidUuid = rawOnbId.length > 0 && !UUID_RE.test(rawOnbId);
    const willBecomeValid = wasInvalidUuid && UUID_RE.test(trimmedOnbId);

    candidates.push({ project, dirty, trimmedOnbId: willBecomeValid ? trimmedOnbId : null });
  }

  const totalCandidates = candidates.length;
  const page = candidates.slice(offset, offset + limit);

  // ── 3. Process page in parallel batches ──────────────────────────
  const detail = [];
  let trimmed_count = 0, webhook_registered = 0, note_created = 0, errors = 0;

  for (let i = 0; i < page.length; i += CONCURRENCY) {
    const batch = page.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((c) => processCandidate(c, dry_run, supabase, req, token)));

    for (const r of results) {
      detail.push(r);
      if (r.error) errors++;
      else {
        if (r.fields_trimmed > 0) trimmed_count++;
        if (r.webhook_registered) webhook_registered++;
        if (r.note_created) note_created++;
      }
    }
  }

  return res.status(200).json({
    success: true,
    dry_run,
    total_projects: projects.length,
    total_with_spaces: totalCandidates,
    offset,
    limit,
    has_more: offset + limit < totalCandidates,
    next_offset: offset + limit < totalCandidates ? offset + limit : null,
    trimmed_count,
    webhook_registered,
    note_created,
    errors,
    detail,
  });
}

async function processCandidate({ project, dirty, trimmedOnbId }, dry_run, supabase, req, token) {
  const row = {
    project: project.name,
    gid: project.gid,
    fields_trimmed: 0,
    webhook_registered: false,
    note_created: false,
    changes: dirty.map((d) => ({ field: d.fieldName, before: JSON.stringify(d.raw), after: d.trimmed })),
  };

  if (dry_run) {
    row.fields_trimmed = dirty.length;
    row.would_register_webhook = !!trimmedOnbId;
    return row;
  }

  // ── Patch trimmed values to Asana ─────────────────────────────────
  const patch = {};
  for (const d of dirty) patch[d.gid] = d.trimmed;

  try {
    await updateProjectCustomFields(project.gid, patch);
    row.fields_trimmed = dirty.length;
  } catch (e) {
    row.error = `Asana PATCH failed: ${e.message}`;
    return row;
  }

  // ── If ONB ID newly valid → register webhook + process status ─────
  if (!trimmedOnbId) return row;

  // Upsert mapping
  await supabase.from('onboarding_mapping').upsert(
    { asana_project_gid: project.gid, attio_record_id: trimmedOnbId, team: 'onboarding', active: true },
    { onConflict: 'asana_project_gid' }
  ).catch(() => {});

  // Register webhook
  try {
    const origin = getOrigin(req);
    const webhook = await createWebhook(project.gid, `${origin}/api/asana-webhook`);
    await supabase.from('asana_webhook_subs').upsert(
      { asana_project_gid: project.gid, webhook_gid: webhook.gid, active: true },
      { onConflict: 'asana_project_gid' }
    ).catch(() => {});
    row.webhook_registered = true;
    row.webhook_gid = webhook.gid;
  } catch (e) {
    row.webhook_error = e.message;
  }

  // Process latest status update
  try {
    const statuses = await fetchLatestStatus(project.gid, token);
    if (statuses.length > 0) {
      const statusGid = statuses[0].gid;
      const origin = getOrigin(req);

      const syncRes = await fetch(`${origin}/api/asana-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          events: [{
            resource: { gid: statusGid, resource_type: 'project_status' },
            parent: { gid: project.gid, resource_type: 'project' },
            action: 'added',
          }],
        }),
      });
      const syncResult = await syncRes.json().catch(() => ({}));
      row.note_created = syncResult.events_processed?.[0]?.note_created ?? false;
      row.status_title = statuses[0].title?.slice(0, 60);
    }
  } catch (e) {
    row.note_error = e.message;
  }

  return row;
}

async function fetchLatestStatus(projectGid, token) {
  const r = await fetch(
    `https://app.asana.com/api/1.0/projects/${projectGid}/project_statuses?opt_fields=gid,title,color,created_at&limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) return [];
  const json = await r.json();
  return json.data || [];
}

async function collectAllProjects(token) {
  const seenGids = new Set();
  const projects = [];

  for (const portfolio of PORTFOLIOS) {
    let nextPage = null;
    do {
      const url = nextPage
        ? `https://app.asana.com/api/1.0${nextPage}`
        : `https://app.asana.com/api/1.0/portfolios/${portfolio.gid}/items?opt_fields=${OPT_FIELDS}&limit=100`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) break;
      const json = await r.json();
      for (const item of json.data || []) {
        if (!seenGids.has(item.gid)) { seenGids.add(item.gid); projects.push(item); }
      }
      nextPage = json.next_page?.path || null;
    } while (nextPage);
  }

  let nextPage = null;
  do {
    const url = nextPage
      ? `https://app.asana.com/api/1.0${nextPage}`
      : `https://app.asana.com/api/1.0/projects?team=${ONBOARDING_TEAM_GID}&opt_fields=${OPT_FIELDS}&limit=100`;
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

function getOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return process.env.APP_URL || `${protocol}://${host}`;
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}
