import { createClient } from '@supabase/supabase-js';
import { getProject, getProjectStatusUpdates } from './_asanaHelper.js';
import { getAttioRecord, createAttioNote } from './_attioHelper.js';

/**
 * POST /api/test-sync
 *
 * Runs a dry-run or live test of the full sync cycle:
 *   1. Fetches Asana project data
 *   2. Fetches Attio Onboarding record
 *   3. Optionally creates a test Note in Attio
 *
 * Body:
 *   asana_project_gid — Asana project GID (required)
 *   attio_record_id   — Attio Onboarding record ID (required)
 *   dry_run           — true (default) = don't write to Attio, false = create real note
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { asana_project_gid, attio_record_id, dry_run = true } = req.body;

  if (!asana_project_gid || !attio_record_id) {
    return res.status(400).json({ error: 'asana_project_gid and attio_record_id are required' });
  }

  const ONBOARDING_SLUG = process.env.ATTIO_ONBOARDING_SLUG || 'onboarding';
  const results = { asana: null, attio: null, note: null, mapping_check: null };

  // ── 1. Test Asana fetch ─────────────────────────────────────────
  try {
    const project = await getProject(asana_project_gid);
    results.asana = {
      status: 'ok',
      project_name: project.name,
      owner: project.owner?.name || null,
      custom_fields: project.custom_fields?.map((f) => ({
        name: f.name,
        value: f.text_value || f.display_value || f.number_value,
      })),
    };

    // Try to fetch status updates and resolve Asana URLs to real names
    try {
      const updates = await getProjectStatusUpdates(asana_project_gid, { limit: 3 });
      if (updates?.length > 0 && updates[0].text) {
        updates[0].text = await resolveAsanaUrls(updates[0].text);
      }
      results.asana.recent_updates = updates?.map((u) => ({
        title: u.title,
        color: u.color,
        created_at: u.created_at,
        text_preview: u.text ? u.text.slice(0, 500) + (u.text.length > 500 ? '...' : '') : null,
      }));
      // Full resolved note preview
      if (updates?.length > 0) {
        results.asana.note_preview = buildNotePreview({
          projectName: project.name,
          update: updates[0],
        });
      }
    } catch (e) {
      results.asana.recent_updates_error = e.message;
    }
  } catch (e) {
    results.asana = { status: 'error', message: e.message };
  }

  // ── 2. Test Attio fetch ─────────────────────────────────────────
  try {
    const record = await getAttioRecord(ONBOARDING_SLUG, attio_record_id);
    const values = record?.data?.values || {};

    // Extract a few key fields for display
    const summary = {};
    for (const [key, val] of Object.entries(values)) {
      if (Array.isArray(val) && val.length > 0) {
        const first = val[0];
        summary[key] = first.value || first.option || first.status?.title || first.email_address || '(complex)';
      }
    }

    results.attio = {
      status: 'ok',
      record_id: attio_record_id,
      object: ONBOARDING_SLUG,
      fields_count: Object.keys(values).length,
      sample_fields: summary,
    };
  } catch (e) {
    results.attio = { status: 'error', message: e.message };
  }

  // ── 3. Check mapping in Supabase ────────────────────────────────
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: mapping } = await supabase
      .from('onboarding_mapping')
      .select('*')
      .eq('asana_project_gid', asana_project_gid)
      .eq('attio_record_id', attio_record_id)
      .single();

    results.mapping_check = mapping
      ? { status: 'ok', active: mapping.active, team: mapping.team }
      : { status: 'not_found', hint: 'Use POST /api/register-webhook to create the mapping' };
  } catch (e) {
    results.mapping_check = { status: 'error', message: e.message };
  }

  // ── 4. Create test note (if not dry_run) ────────────────────────
  if (!dry_run && results.asana?.status === 'ok' && results.attio?.status === 'ok') {
    try {
      const note = await createAttioNote(attio_record_id, ONBOARDING_SLUG, {
        title: `[TEST] Sync validation — ${results.asana.project_name}`,
        content: [
          `Test de conexión Asana → Attio`,
          `Fecha: ${new Date().toISOString()}`,
          `Proyecto Asana: ${results.asana.project_name} (${asana_project_gid})`,
          `Record Attio: ${attio_record_id}`,
          '',
          'Esta nota fue creada automáticamente para validar la integración.',
        ].join('\n'),
        format: 'plaintext',
      });

      results.note = { status: 'created', note_id: note?.data?.id?.note_id };
    } catch (e) {
      results.note = { status: 'error', message: e.message };
    }
  } else if (dry_run) {
    results.note = { status: 'skipped', reason: 'dry_run=true (send dry_run:false to create a real note)' };
  }

  // ── Overall ─────────────────────────────────────────────────────
  const allOk = results.asana?.status === 'ok' && results.attio?.status === 'ok';
  results.overall = allOk ? 'ready' : 'has_errors';

  return res.status(allOk ? 200 : 503).json(results);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildNotePreview({ projectName, update }) {
  const lines = [];
  const now = new Date().toISOString().split('T')[0];
  const colorMap = { green: 'En buen camino', yellow: 'En riesgo', red: 'Con problemas', blue: 'En espera', complete: 'Completado' };

  lines.push(`Fecha: ${now}`);
  lines.push(`Proyecto: ${projectName}`);
  lines.push(`Tipo de evento: Actualización de proyecto`);
  lines.push('');
  lines.push('── Último status update ──');
  if (update.title) lines.push(`Título: ${update.title}`);
  if (update.color) lines.push(`Estado: ${colorMap[update.color] || update.color}`);
  lines.push('');
  if (update.text) lines.push(update.text);

  return lines.join('\n');
}

async function resolveAsanaUrls(text) {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return text;

  const taskPattern = /https:\/\/app\.asana\.com\/0\/0\/(\d+)/g;
  const userPattern = /https:\/\/app\.asana\.com\/0\/profile\/(\d+)/g;

  const taskGids = [...new Set([...text.matchAll(taskPattern)].map((m) => m[1]))];
  const profileGids = [...new Set([...text.matchAll(userPattern)].map((m) => m[1]))];

  if (taskGids.length === 0 && profileGids.length === 0) return text;

  const taskNames = {};
  const profileNames = {};

  // Fetch tasks + collect people from assignee/completed_by/followers
  await Promise.all(taskGids.map(async (gid) => {
    try {
      const r = await fetch(
        `https://app.asana.com/api/1.0/tasks/${gid}?opt_fields=name,assignee.name,assignee.email,completed_by.name,completed_by.email,followers.name,followers.email`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) return;
      const json = await r.json();
      const data = json.data;
      if (data?.name) taskNames[gid] = data.name;
      for (const person of [data?.assignee, data?.completed_by, ...(data?.followers || [])]) {
        if (person?.gid && person?.name) profileNames[person.gid] = person.name;
      }
    } catch { /* skip */ }
  }));

  // Try direct user lookup for unresolved profile GIDs
  const unresolved = profileGids.filter((g) => !profileNames[g]);
  await Promise.all(unresolved.map(async (gid) => {
    try {
      const r = await fetch(
        `https://app.asana.com/api/1.0/users/${gid}?opt_fields=name,email`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) return;
      const json = await r.json();
      const data = json.data;
      if (data?.name) profileNames[gid] = data.name;
      else if (data?.email) profileNames[gid] = data.email;
    } catch { /* skip */ }
  }));

  let resolved = text.replace(taskPattern, (match, gid) =>
    taskNames[gid] ? `"${taskNames[gid]}"` : match
  );
  resolved = resolved.replace(userPattern, (_match, gid) =>
    profileNames[gid] ? `@${profileNames[gid]}` : '@usuario'
  );

  return resolved;
}
