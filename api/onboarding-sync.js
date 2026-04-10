import { createClient } from '@supabase/supabase-js';
import { createAttioNote, patchAttioRecord } from './_attioHelper.js';
import { getProject, getProjectStatusUpdates } from './_asanaHelper.js';

/**
 * POST /api/onboarding-sync
 *
 * Processes a pending sync_event (Asana → Attio):
 *   1. Reads the event from Supabase
 *   2. Fetches context from Asana (project details, status updates)
 *   3. Creates a Note in the Attio Onboarding record
 *   4. Optionally updates Attio properties based on heuristics
 *   5. Marks the event as completed
 *
 * Body: { sync_event_id: UUID }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sync_event_id } = req.body;
  if (!sync_event_id) return res.status(400).json({ error: 'sync_event_id is required' });

  const supabase = getSupabase();

  // ── 1. Load the sync event ─────────────────────────────────────
  const { data: event, error: fetchErr } = await supabase
    .from('sync_events')
    .select('*')
    .eq('id', sync_event_id)
    .single();

  if (fetchErr || !event) {
    return res.status(404).json({ error: 'Sync event not found' });
  }

  if (event.status !== 'pending') {
    return res.status(200).json({ message: `Event already ${event.status}` });
  }

  // Mark as processing
  await supabase.from('sync_events').update({ status: 'processing' }).eq('id', sync_event_id);

  try {
    const { asana_project_gid, attio_record_id, event_type, payload } = event;

    // ── 2. Fetch Asana context ──────────────────────────────────
    let projectName = asana_project_gid;
    let statusUpdates = [];
    let projectDetails = null;

    try {
      projectDetails = await getProject(asana_project_gid);
      projectName = projectDetails.name || asana_project_gid;
    } catch (e) {
      console.warn('[onboarding-sync] Could not fetch Asana project:', e.message);
    }

    try {
      statusUpdates = await getProjectStatusUpdates(asana_project_gid, { limit: 3 });
    } catch (e) {
      console.warn('[onboarding-sync] Could not fetch status updates:', e.message);
    }

    // ── 3. Build the note content ───────────────────────────────
    const asanaEvents = payload?.events || [];
    const noteContent = buildNoteContent({
      projectName,
      eventType: event_type,
      asanaEvents,
      statusUpdates,
      projectDetails,
    });

    // ── 4. Create Note in Attio ─────────────────────────────────
    const ONBOARDING_SLUG = process.env.ATTIO_ONBOARDING_SLUG || 'onboarding';
    let noteCreated = false;

    try {
      await createAttioNote(attio_record_id, ONBOARDING_SLUG, {
        title: `Asana Update — ${projectName}`,
        content: noteContent,
        format: 'plaintext',
      });
      noteCreated = true;
    } catch (e) {
      // Non-fatal: log and continue — never block the operation
      console.warn(`[onboarding-sync] Note creation failed for ${attio_record_id} (skipping):`, e.message);
      await supabase.from('sync_events').update({
        status: 'completed',
        error_message: `Note skipped: ${e.message}`,
        ai_analysis: { note_created: false, project_name: projectName },
      }).eq('id', sync_event_id);
      return res.status(200).json({ success: true, note_created: false, skipped_reason: e.message });
    }

    // ── 5. Auto-detect property updates ─────────────────────────
    const propertyUpdates = detectPropertyUpdates(asanaEvents, projectDetails);
    if (Object.keys(propertyUpdates).length > 0) {
      try {
        await patchAttioRecord(ONBOARDING_SLUG, attio_record_id, propertyUpdates);
      } catch (e) {
        console.warn('[onboarding-sync] Property update failed (non-blocking):', e.message);
      }
    }

    // ── 6. Mark completed ───────────────────────────────────────
    await supabase.from('sync_events').update({
      status: 'completed',
      ai_analysis: {
        note_created: noteCreated,
        properties_updated: Object.keys(propertyUpdates),
        project_name: projectName,
      },
    }).eq('id', sync_event_id);

    return res.status(200).json({
      success: true,
      note_created: noteCreated,
      properties_updated: Object.keys(propertyUpdates),
    });

  } catch (err) {
    // Unexpected error — log but return 200 so Asana doesn't retry the webhook
    console.error('[onboarding-sync] Unexpected error:', err.message);

    await supabase.from('sync_events').update({
      status: 'failed',
      error_message: err.message,
      retry_count: (event.retry_count || 0) + 1,
    }).eq('id', sync_event_id).catch(() => {});

    return res.status(200).json({ success: false, error: err.message });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildNoteContent({ projectName, eventType, asanaEvents, statusUpdates, projectDetails }) {
  const lines = [];
  const now = new Date().toISOString().split('T')[0];

  lines.push(`Fecha: ${now}`);
  lines.push(`Proyecto: ${projectName}`);
  lines.push(`Tipo de evento: ${formatEventType(eventType)}`);
  lines.push('');

  if (statusUpdates.length > 0) {
    const latest = statusUpdates[0];
    lines.push('── Último status update ──');
    if (latest.title) lines.push(`Título: ${latest.title}`);
    if (latest.text) lines.push(latest.text);
    if (latest.color) lines.push(`Estado: ${formatStatusColor(latest.color)}`);
    lines.push('');
  }

  if (asanaEvents.length > 0) {
    lines.push('── Cambios detectados ──');
    for (const evt of asanaEvents) {
      const resource = evt.resource?.resource_type || 'recurso';
      const action = evt.action || 'cambio';
      const name = evt.resource?.name || '';
      lines.push(`• ${resource} ${action}${name ? `: ${name}` : ''}`);
    }
    lines.push('');
  }

  if (projectDetails?.current_status) {
    lines.push('── Estado actual del proyecto ──');
    lines.push(`Color: ${formatStatusColor(projectDetails.current_status.color)}`);
    if (projectDetails.current_status.text) {
      lines.push(projectDetails.current_status.text);
    }
  }

  return lines.join('\n');
}

function formatEventType(type) {
  const map = {
    project_update: 'Actualización de proyecto',
    task_completed: 'Tarea completada',
    task_added: 'Tarea agregada',
    call_logged: 'Llamada registrada',
  };
  return map[type] || type;
}

function formatStatusColor(color) {
  const map = {
    green: 'En buen camino',
    yellow: 'En riesgo',
    red: 'Con problemas',
    blue: 'En espera',
    complete: 'Completado',
  };
  return map[color] || color;
}

/**
 * Detect properties that can be auto-updated in Attio
 * based on Asana event patterns.
 * Phase 2 (AI) will replace this with Claude-powered analysis.
 */
function detectPropertyUpdates(asanaEvents, projectDetails) {
  const updates = {};
  if (!projectDetails) return updates;

  if (projectDetails.current_status?.color === 'complete') {
    updates['onboarding_status'] = [{ option: 'Completed' }];
  }

  if (projectDetails.current_status?.color === 'red') {
    updates['onboarding_status'] = [{ option: 'At Risk' }];
  }

  return updates;
}

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
}
