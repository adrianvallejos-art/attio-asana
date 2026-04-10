import { createClient } from '@supabase/supabase-js';

const ONBOARDING_TEAM_GID = '1204050191559311';
const ATTIO_ONB_FIELD = 'Attio ONB ID';

/**
 * POST /api/bulk-register
 *
 * Fetches all active projects from the Onboarding team in Asana,
 * reads the "Attio ONB ID" custom field from each, and registers
 * a webhook + mapping for every project that has the field populated.
 *
 * Projects without the field are silently skipped.
 *
 * Returns a summary: registered, skipped, failed.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'ASANA_ACCESS_TOKEN not set' });

  const supabase = getSupabase();
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = process.env.APP_URL || `${protocol}://${host}`;
  const webhookTarget = `${origin}/api/asana-webhook`;

  const summary = { registered: [], skipped: [], failed: [] };

  // ── 1. Fetch all projects from Onboarding team ─────────────────
  let projects = [];
  try {
    const r = await fetch(
      `https://app.asana.com/api/1.0/projects?team=${ONBOARDING_TEAM_GID}&opt_fields=name,gid,custom_fields.name,custom_fields.text_value,custom_fields.display_value&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error(`Asana projects fetch failed: ${r.status}`);
    const json = await r.json();
    projects = json.data || [];
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // ── 2. Process each project ────────────────────────────────────
  for (const project of projects) {
    const projectGid = project.gid;
    const projectName = project.name;

    // Find the Attio ONB ID custom field
    const field = project.custom_fields?.find((f) => f.name === ATTIO_ONB_FIELD);
    const attioRecordId = field?.text_value || field?.display_value || null;

    if (!attioRecordId || !/^[0-9a-f-]{36}$/i.test(attioRecordId)) {
      summary.skipped.push({ gid: projectGid, name: projectName, reason: 'No Attio ONB ID' });
      continue;
    }

    try {
      // Check if webhook already exists for this project
      const { data: existing } = await supabase
        .from('asana_webhook_subs')
        .select('webhook_gid')
        .eq('asana_project_gid', projectGid)
        .eq('active', true)
        .single();

      if (existing) {
        // Ensure mapping exists
        await supabase.from('onboarding_mapping').upsert(
          { asana_project_gid: projectGid, attio_record_id: attioRecordId, team: 'onboarding', active: true },
          { onConflict: 'asana_project_gid' }
        );
        summary.skipped.push({ gid: projectGid, name: projectName, reason: 'Webhook already registered' });
        continue;
      }

      // Register webhook in Asana
      const wRes = await fetch('https://app.asana.com/api/1.0/webhooks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: {
            resource: projectGid,
            target: webhookTarget,
            filters: [
              { resource_type: 'project', action: 'changed' },
              { resource_type: 'task', action: 'changed' },
              { resource_type: 'task', action: 'added' },
            ],
          },
        }),
      });

      if (!wRes.ok) {
        const err = await wRes.json().catch(() => ({}));
        throw new Error(`Webhook creation failed: ${JSON.stringify(err.errors || err)}`);
      }

      const webhook = await wRes.json();

      // Save mapping + webhook sub
      await supabase.from('onboarding_mapping').upsert(
        { asana_project_gid: projectGid, attio_record_id: attioRecordId, team: 'onboarding', active: true },
        { onConflict: 'asana_project_gid' }
      );

      await supabase.from('asana_webhook_subs').upsert(
        { asana_project_gid: projectGid, webhook_gid: webhook.data?.gid || 'pending', active: true },
        { onConflict: 'webhook_gid' }
      );

      summary.registered.push({ gid: projectGid, name: projectName, attio_record_id: attioRecordId });

    } catch (e) {
      console.error(`[bulk-register] Failed for ${projectName}:`, e.message);
      summary.failed.push({ gid: projectGid, name: projectName, error: e.message });
    }
  }

  return res.status(200).json({
    success: true,
    total_projects: projects.length,
    registered: summary.registered.length,
    skipped: summary.skipped.length,
    failed: summary.failed.length,
    detail: summary,
  });
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}
