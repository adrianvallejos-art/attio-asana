import { createClient } from '@supabase/supabase-js';
import { updateProjectCustomFields, createWebhook } from './_asanaHelper.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * POST /api/update-project-fields
 *
 * Updates Atom ID, Attio Company ID and/or Attio ONB ID custom fields
 * directly on the Asana project. If a valid Attio ONB ID is provided,
 * also upserts the onboarding_mapping and registers the webhook.
 *
 * Body:
 *   asana_project_gid  — required
 *   field_gids         — { atom_id, attio_company_id, attio_onb_id }
 *   atom_id            — new value (optional, pass null to skip)
 *   attio_company_id   — new value (optional)
 *   attio_onb_id       — new value (optional)
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { asana_project_gid, field_gids = {}, atom_id, attio_company_id, attio_onb_id } = req.body || {};
  if (!asana_project_gid) return res.status(400).json({ error: 'asana_project_gid required' });

  // Build Asana custom_fields patch — only include fields that have a GID and a value
  const patch = {};
  if (field_gids.atom_id && atom_id != null)          patch[field_gids.atom_id] = atom_id;
  if (field_gids.attio_company_id && attio_company_id != null) patch[field_gids.attio_company_id] = attio_company_id;
  if (field_gids.attio_onb_id && attio_onb_id != null) patch[field_gids.attio_onb_id] = attio_onb_id;

  const result = { asana_updated: false, mapping_upserted: false, webhook_registered: false };

  // ── 1. Patch Asana custom fields ────────────────────────────────
  if (Object.keys(patch).length > 0) {
    try {
      await updateProjectCustomFields(asana_project_gid, patch);
      result.asana_updated = true;
    } catch (e) {
      return res.status(500).json({ error: `Asana update failed: ${e.message}` });
    }
  }

  // ── 2. If valid ONB ID → upsert mapping + webhook ───────────────
  const validOnbId = attio_onb_id && UUID_RE.test(attio_onb_id) ? attio_onb_id : null;
  if (validOnbId) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    await supabase.from('onboarding_mapping').upsert(
      { asana_project_gid, attio_record_id: validOnbId, team: 'onboarding', active: true },
      { onConflict: 'asana_project_gid' }
    );
    result.mapping_upserted = true;

    // Check if webhook already exists
    const { data: existing } = await supabase
      .from('asana_webhook_subs')
      .select('webhook_gid')
      .eq('asana_project_gid', asana_project_gid)
      .eq('active', true)
      .single();

    if (!existing) {
      try {
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const origin = process.env.APP_URL || `${protocol}://${host}`;
        const webhook = await createWebhook(asana_project_gid, `${origin}/api/asana-webhook`);

        await supabase.from('asana_webhook_subs').upsert(
          { asana_project_gid, webhook_gid: webhook.gid, active: true },
          { onConflict: 'asana_project_gid' }
        );
        result.webhook_registered = true;
        result.webhook_gid = webhook.gid;
      } catch (e) {
        result.webhook_error = e.message;
      }
    } else {
      result.webhook_gid = existing.webhook_gid;
    }
  }

  return res.status(200).json({ success: true, ...result });
}
