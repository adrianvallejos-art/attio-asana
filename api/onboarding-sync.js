import { createClient } from '@supabase/supabase-js';
import { createAttioNote, patchAttioRecord } from './_attioHelper.js';
import { getProject, getProjectStatusUpdates } from './_asanaHelper.js';

/**
 * POST /api/onboarding-sync
 *
 * Processes a pending sync_event (Asana → Attio):
 *   1. Reads the event from Supabase
 *   2. Fetches context from Asana (project details, status updates)
 *   3. Resolves Asana URLs in the status text → real names (tasks, people)
 *   4. Creates a Note in the Attio Onboarding record
 *   5. Optionally updates Attio properties based on heuristics
 *   6. Marks the event as completed
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

    // ── 3. Resolve Asana URLs → real names ─────────────────────
    if (statusUpdates.length > 0 && statusUpdates[0].text) {
      statusUpdates[0].text = await resolveAsanaUrls(statusUpdates[0].text);
    }

    // ── 4. Build the note content ───────────────────────────────
    const noteContent = buildNoteContent({
      projectName,
      statusUpdates,
    });

    // ── 5. Create Note in Attio ─────────────────────────────────
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
      console.warn(`[onboarding-sync] Note creation failed for ${attio_record_id} (skipping):`, e.message);
      await supabase.from('sync_events').update({
        status: 'completed',
        error_message: `Note skipped: ${e.message}`,
        ai_analysis: { note_created: false, project_name: projectName },
      }).eq('id', sync_event_id);
      return res.status(200).json({ success: true, note_created: false, skipped_reason: e.message });
    }

    // ── 6. Auto-detect property updates ─────────────────────────
    const propertyUpdates = detectPropertyUpdates(projectDetails);
    if (Object.keys(propertyUpdates).length > 0) {
      try {
        await patchAttioRecord(ONBOARDING_SLUG, attio_record_id, propertyUpdates);
      } catch (e) {
        console.warn('[onboarding-sync] Property update failed (non-blocking):', e.message);
      }
    }

    // ── 7. Mark completed ───────────────────────────────────────
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
    console.error('[onboarding-sync] Unexpected error:', err.message);
    await supabase.from('sync_events').update({
      status: 'failed',
      error_message: err.message,
      retry_count: (event.retry_count || 0) + 1,
    }).eq('id', sync_event_id).catch(() => {});
    return res.status(200).json({ success: false, error: err.message });
  }
}

// ─── URL resolver ────────────────────────────────────────────────────────────

/**
 * Finds all Asana task and profile URLs in a text and replaces them
 * with real names fetched from the Asana API.
 *
 * Patterns handled:
 *   https://app.asana.com/0/0/{task_gid}         → "Nombre de la tarea"
 *   https://app.asana.com/0/profile/{profile_gid} → "@Nombre Apellido"
 *
 * Note: profile GIDs in URLs are public profile IDs, different from
 * internal user GIDs. We resolve them indirectly: when fetching tasks
 * we collect assignee/completed_by data and build a profile→name map.
 * If still unresolved, we strip the URL and leave a clean placeholder.
 */
async function resolveAsanaUrls(text) {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return text;

  const taskPattern = /https:\/\/app\.asana\.com\/0\/0\/(\d+)/g;
  const userPattern = /https:\/\/app\.asana\.com\/0\/profile\/(\d+)/g;

  const taskGids = [...new Set([...text.matchAll(taskPattern)].map((m) => m[1]))];
  const profileGids = [...new Set([...text.matchAll(userPattern)].map((m) => m[1]))];

  if (taskGids.length === 0 && profileGids.length === 0) return text;

  // Fetch tasks — each task response includes assignee & completed_by with name+email
  const taskNames = {};
  const profileNames = {}; // built from task member data as a side effect

  await Promise.all(chunkArray(taskGids, 10).flatMap((chunk) =>
    chunk.map(async (gid) => {
      try {
        const r = await fetch(
          `https://app.asana.com/api/1.0/tasks/${gid}?opt_fields=name,assignee.name,assignee.email,completed_by.name,completed_by.email,followers.name,followers.email`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!r.ok) return;
        const json = await r.json();
        const data = json.data;
        if (data?.name) taskNames[gid] = data.name;

        // Collect people encountered in tasks to resolve profile URLs
        for (const person of [data?.assignee, data?.completed_by, ...(data?.followers || [])]) {
          if (person?.gid && person?.name) {
            // Store by internal GID (won't match profile GIDs directly,
            // but we also store by name fragment for fuzzy fallback)
            profileNames[person.gid] = person.name;
          }
        }
      } catch { /* skip */ }
    })
  ));

  // For profile GIDs that still aren't resolved, try the workspace members endpoint
  const unresolvedProfiles = profileGids.filter((g) => !profileNames[g]);
  if (unresolvedProfiles.length > 0) {
    await Promise.all(chunkArray(unresolvedProfiles, 10).flatMap((chunk) =>
      chunk.map(async (gid) => {
        try {
          // Try the public profile endpoint (works for some workspaces)
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
      })
    ));
  }

  // Replace task URLs
  let resolved = text.replace(taskPattern, (match, gid) =>
    taskNames[gid] ? `"${taskNames[gid]}"` : match
  );

  // Replace profile URLs — if unresolved, remove the raw URL entirely
  resolved = resolved.replace(userPattern, (match, gid) => {
    if (profileNames[gid]) return `@${profileNames[gid]}`;
    // Leave a clean generic placeholder instead of a broken URL
    return '@usuario';
  });

  return resolved;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ─── Note builder ────────────────────────────────────────────────────────────

function buildNoteContent({ projectName, statusUpdates }) {
  if (statusUpdates.length === 0) {
    return `Proyecto: ${projectName}\n\n(Sin status update disponible)`;
  }

  const update = statusUpdates[0];
  const lines = [];

  if (update.title) lines.push(`📌 ${update.title}`);
  if (update.color) lines.push(`Estado: ${formatStatusColor(update.color)}`);
  if (update.author?.name) lines.push(`Por: ${update.author.name}`);
  if (update.created_at) lines.push(`Fecha: ${update.created_at.split('T')[0]}`);
  lines.push('');
  if (update.text) lines.push(update.text);

  return lines.join('\n');
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

function detectPropertyUpdates(projectDetails) {
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
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}
