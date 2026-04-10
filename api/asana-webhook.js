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

  const signature = req.headers['x-hook-signature'];
  const secret = process.env.ASANA_WEBHOOK_SECRET;
  if (signature && secret) {
    try {
      const hmac = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (hmac !== signature) {
        console.warn('[asana-webhook] Invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch (e) {
      console.warn('[asana-webhook] Signature check failed:', e.message);
    }
  }

  // ── 3. Process Events ───────────────────────────────────────────
  const { events } = req.body || {};
  if (!events || events.length === 0) {
    return res.status(200).json({ message: 'No events' });
  }

  const supabase = getSupabase();

  const relevantEvents = events.filter((e) =>
    (e.resource?.resource_type === 'project' && e.action === 'changed') ||
    (e.resource?.resource_type === 'task' && ['changed', 'added'].includes(e.action))
  );

  if (relevantEvents.length === 0) {
    return res.status(200).json({ message: 'No relevant events' });
  }

  // Group events by project GID
  const byProject = {};
  for (const event of relevantEvents) {
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

    const hasProjectChange = projectEvents.some(
      (e) => e.resource?.resource_type === 'project'
    );
    const eventType = hasProjectChange ? 'project_update' : 'task_completed';

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

  // ── 4. Trigger async processing ─────────────────────────────────
  if (inserted.length > 0) {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = process.env.APP_URL || `${protocol}://${host}`;

    for (const eventId of inserted) {
      fetch(`${origin}/api/onboarding-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sync_event_id: eventId }),
      }).catch((e) => console.warn('[asana-webhook] Async trigger failed:', e.message));
    }
  }

  return res.status(200).json({
    success: true,
    events_received: events.length,
    events_queued: inserted.length,
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
