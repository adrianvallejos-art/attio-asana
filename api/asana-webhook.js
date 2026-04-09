import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

/**
 * POST /api/asana-webhook
 *
 * Receives Asana webhook events for project updates.
 * Handles two flows:
 *   1. Handshake — Asana sends X-Hook-Secret, we echo it back
 *   2. Events   — Asana sends project/task change events
 *
 * Events are stored in sync_events for async processing
 * by the onboarding-sync endpoint.
 */
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
  if (signature && process.env.ASANA_WEBHOOK_SECRET) {
    const hmac = crypto
      .createHmac('sha256', process.env.ASANA_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (hmac !== signature) {
      console.warn('[asana-webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
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
    const { data: mapping } = await supabase
      .from('onboarding_mapping')
      .select('attio_record_id')
      .eq('asana_project_gid', projectGid)
      .eq('active', true)
      .single();

    if (!mapping) {
      console.warn(`[asana-webhook] No mapping for Asana project ${projectGid} — skipping`);
      continue;
    }

    const hasProjectChange = projectEvents.some(
      (e) => e.resource?.resource_type === 'project'
    );
    const eventType = hasProjectChange ? 'project_update' : 'task_completed';

    const { data, error } = await supabase.from('sync_events').insert({
      source: 'asana',
      event_type: eventType,
      asana_project_gid: projectGid,
      attio_record_id: mapping.attio_record_id,
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

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
}
