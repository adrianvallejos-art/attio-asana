import { createClient } from '@supabase/supabase-js';
import { createWebhook, deleteWebhook } from './_asanaHelper.js';

/**
 * POST /api/register-webhook
 *
 * Registers an Asana webhook for a project and creates/updates
 * the onboarding_mapping entry.
 *
 * Body:
 *   asana_project_gid  — Asana project GID (required)
 *   attio_record_id    — Attio Onboarding record ID (required)
 *   assigned_onb_email — Owner email (optional)
 *   team               — Team name (optional, default: 'onboarding')
 *
 * GET /api/register-webhook
 *
 * Lists all active webhook subscriptions.
 *
 * DELETE /api/register-webhook
 *
 * Removes a webhook. Body: { webhook_gid: '...' }
 */
export default async function handler(req, res) {
  const supabase = getSupabase();

  // ── LIST webhooks ───────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('asana_webhook_subs')
      .select('*, onboarding_mapping:onboarding_mapping!asana_project_gid(attio_record_id, assigned_onb_email, team)')
      .eq('active', true);

    if (error) return res.status(500).json({ error: error.message });

    // Also list mappings without webhooks
    const { data: mappings } = await supabase
      .from('onboarding_mapping')
      .select('*')
      .eq('active', true);

    return res.status(200).json({ webhooks: data || [], mappings: mappings || [] });
  }

  // ── DELETE webhook ──────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { webhook_gid } = req.body;
    if (!webhook_gid) return res.status(400).json({ error: 'webhook_gid is required' });

    try {
      await deleteWebhook(webhook_gid);
      await supabase.from('asana_webhook_subs').update({ active: false }).eq('webhook_gid', webhook_gid);
      return res.status(200).json({ success: true, deleted: webhook_gid });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── REGISTER webhook ───────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { asana_project_gid, attio_record_id, assigned_onb_email, team } = req.body;

  if (!asana_project_gid || !attio_record_id) {
    return res.status(400).json({ error: 'asana_project_gid and attio_record_id are required' });
  }

  try {
    // 1. Upsert the mapping
    const { error: mapErr } = await supabase.from('onboarding_mapping').upsert(
      {
        asana_project_gid,
        attio_record_id,
        assigned_onb_email: assigned_onb_email || null,
        team: team || 'onboarding',
        active: true,
      },
      { onConflict: 'asana_project_gid' }
    );
    if (mapErr) throw new Error(`Mapping upsert failed: ${mapErr.message}`);

    // 2. Build webhook target URL
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = process.env.APP_URL || `${protocol}://${host}`;
    const targetUrl = `${origin}/api/asana-webhook`;

    // 3. Register webhook in Asana
    const webhook = await createWebhook(asana_project_gid, targetUrl);

    // 4. Store webhook subscription
    await supabase.from('asana_webhook_subs').upsert(
      {
        asana_project_gid,
        webhook_gid: webhook.gid,
        active: true,
      },
      { onConflict: 'webhook_gid' }
    );

    return res.status(200).json({
      success: true,
      mapping: { asana_project_gid, attio_record_id },
      webhook: { gid: webhook.gid, target: targetUrl },
    });
  } catch (e) {
    console.error('[register-webhook] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}
