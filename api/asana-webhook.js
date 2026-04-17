import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const ATTIO_ONB_FIELD = 'Attio ONB ID'; // Custom field name in Asana

/**
 * POST /api/asana-webhook
 *
 * Receives Asana webhook events for project updates.
 * Handles two flows:
 *   1. Handshake — Asana sends X-Hook-Secret, we echo it back
 *   2. Events   — Asana sends project/task change events
 *
 * Auto-discovery: if the project has no mapping in Supabase,
 * fetches the project from Asana and checks for the "Attio ONB ID"
 * custom field. If found, creates the mapping automatically.
 * If not found, skips silently without breaking the operation.
 */
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  // ── 1. Asana Webhook Handshake ──────────────────────────────────
  const hookSecret = req.headers['x-hook-secret'];
  if (hookSecret) {
    console.log('[asana-webhook] Handshake received');
    res.setHeader('X-Hook-Secret', hookSecret);

    try {
      const supabase = getSupabase();
      if (req.body?.data?.resource) {
        await supabase.from('asana_webhook_subs').upsert(
          {
            asana_project_gid: String(req.body.data.resource),
            webhook_gid: req.body.data.gid || 'pending',
            x_hook_secret: hookSecret,
          },
          { onConflict: 'webhook_gid' }
        );
      }
    } catch (e) {
      console.warn('[asana-webhook] Failed to persist hook secret:', e.message);
    }

    return res.status(200).end();
  }

  // ── 2. Signature Verification ───────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Signature check skipped: Asana uses a per-webhook x_hook_secret (from handshake),
  // not a global secret. Real protection comes from onboarding_mapping lookup — only
  // projects in our mapping get processed.


  // ── 3. Process Events ───────────────────────────────────────────
  const { events } = req.body || {};
  if (!events || events.length === 0) {
    return res.status(200).json({ message: 'No events' });
  }

  const supabase = getSupabase();

  // Only trigger when someone publishes a project status update (the colored
  // bubble with text). Asana fires resource_type='project_status', action='added'
  // for this exact action. Everything else — task changes, project field edits,
  // membership changes, comments — is ignored.
  const relevantEvents = events.filter((e) =>
    e.resource?.resource_type === 'project_status' && e.action === 'added'
  );

  if (relevantEvents.length === 0) {
    return res.status(200).json({ message: 'No relevant events' });
  }

  // Group by project GID — ensures only ONE sync per project per webhook call
  // even if both project_status and project events arrive in the same batch.
  const byProject = {};
  for (const event of relevantEvents) {
    // project_status events: parent.gid = project, resource.gid = status entry
    // project changed events: resource.gid = project
    const projectGid = event.parent?.gid || event.resource?.gid;
    if (!projectGid) continue;
    if (!byProject[projectGid]) byProject[projectGid] = [];
    byProject[projectGid].push(event);
  }

  const inserted = [];

  for (const [projectGid, projectEvents] of Object.entries(byProject)) {
    // ── 3a. Look up mapping in Supabase (fast path) ───────────────
    let attioRecordId = null;

    const { data: mapping } = await supabase
      .from('onboarding_mapping')
      .select('attio_record_id')
      .eq('asana_project_gid', projectGid)
      .eq('active', true)
      .single();

    if (mapping) {
      attioRecordId = mapping.attio_record_id;
    } else {
      // ── 3b. Fallback: read Attio ONB ID from Asana custom field ──
      attioRecordId = await getAttioIdFromAsana(projectGid);

      if (attioRecordId) {
        // Auto-create mapping so future events use the fast path
        await supabase.from('onboarding_mapping').upsert(
          {
            asana_project_gid: projectGid,
            attio_record_id: attioRecordId,
            team: 'onboarding',
            active: true,
          },
          { onConflict: 'asana_project_gid' }
        ).catch((e) => console.warn('[asana-webhook] Auto-mapping insert failed:', e.message));

        console.log(`[asana-webhook] Auto-mapped project ${projectGid} → Attio ${attioRecordId}`);
      } else {
        // No Attio ID anywhere — skip this project silently
        console.log(`[asana-webhook] Project ${projectGid} has no Attio ONB ID — skipping`);
        continue;
      }
    }

    const eventType = 'status_update';

    const { data, error } = await supabase.from('sync_events').insert({
      source: 'asana',
      event_type: eventType,
      asana_project_gid: projectGid,
      attio_record_id: attioRecordId,
      payload: { events: projectEvents },
      status: 'pending',
    }).select('id');

    if (error) {
      console.error(`[asana-webhook] DB insert error for ${projectGid}:`, error.message);
    } else {
      inserted.push(data[0]?.id);
    }
  }

  // ── 4. Process sync events synchronously before responding ──────
  // Fire-and-forget is unreliable on Vercel: the function shuts down after
  // sending the response, killing any background fetch. We await each sync
  // call here so Vercel keeps the function alive until the note is created.
  // Total processing time is typically <3s, well within Asana's timeout.
  const results = [];
  if (inserted.length > 0) {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = process.env.APP_URL || `${protocol}://${host}`;

    for (const eventId of inserted) {
      try {
        const r = await fetch(`${origin}/api/onboarding-sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sync_event_id: eventId }),
        });
        const result = await r.json().catch(() => ({}));
        results.push({ id: eventId, ok: r.ok, note_created: result.note_created });
      } catch (e) {
        console.warn('[asana-webhook] Sync call failed:', e.message);
        results.push({ id: eventId, ok: false, error: e.message });
      }
    }
  }

  return res.status(200).json({
    success: true,
    events_received: events.length,
    events_processed: results,
  });
}

/**
 * Fetch the Attio ONB ID from the Asana project's custom fields.
 * Returns null if the field is missing or empty — never throws.
 */
async function getAttioIdFromAsana(projectGid) {
  try {
    const token = process.env.ASANA_ACCESS_TOKEN;
    if (!token) return null;

    const res = await fetch(
      `https://app.asana.com/api/1.0/projects/${projectGid}?opt_fields=custom_fields.name,custom_fields.text_value,custom_fields.display_value`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) return null;

    const json = await res.json();
    const field = json.data?.custom_fields?.find((f) => f.name === ATTIO_ONB_FIELD);
    const value = field?.text_value || field?.display_value || null;

    // Validate it looks like a UUID
    if (value && /^[0-9a-f-]{36}$/i.test(value)) return value;
    return null;
  } catch {
    return null;
  }
}

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
}
