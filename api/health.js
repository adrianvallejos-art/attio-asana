import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/health
 *
 * Validates connectivity to all external services:
 *   - Supabase (DB)
 *   - Asana API
 *   - Attio API
 *
 * Returns status per service + config check for env vars.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const results = {
    timestamp: new Date().toISOString(),
    env_vars: checkEnvVars(),
    supabase: { status: 'pending' },
    asana: { status: 'pending' },
    attio: { status: 'pending' },
  };

  // ── Supabase ────────────────────────────────────────────────────
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data, error } = await supabase.from('onboarding_mapping').select('id').limit(1);
    if (error) throw new Error(error.message);
    results.supabase = { status: 'ok', tables_accessible: true, rows_sample: data?.length ?? 0 };
  } catch (e) {
    results.supabase = { status: 'error', message: e.message };
  }

  // ── Asana ───────────────────────────────────────────────────────
  try {
    const asanaRes = await fetch('https://app.asana.com/api/1.0/users/me', {
      headers: { Authorization: `Bearer ${process.env.ASANA_ACCESS_TOKEN}` },
    });
    if (!asanaRes.ok) throw new Error(`HTTP ${asanaRes.status}`);
    const asanaData = await asanaRes.json();
    results.asana = {
      status: 'ok',
      user: asanaData.data?.name,
      email: asanaData.data?.email,
      workspaces: asanaData.data?.workspaces?.map((w) => ({ gid: w.gid, name: w.name })),
    };
  } catch (e) {
    results.asana = { status: 'error', message: e.message };
  }

  // ── Attio ───────────────────────────────────────────────────────
  try {
    const attioRes = await fetch('https://api.attio.com/v2/self', {
      headers: { Authorization: `Bearer ${process.env.ATTIO_API_TOKEN}` },
    });
    if (!attioRes.ok) throw new Error(`HTTP ${attioRes.status}`);
    const attioData = await attioRes.json();
    results.attio = {
      status: 'ok',
      workspace: attioData.data?.workspace?.name,
    };
  } catch (e) {
    results.attio = { status: 'error', message: e.message };
  }

  // ── Overall ─────────────────────────────────────────────────────
  const allOk = results.supabase.status === 'ok'
    && results.asana.status === 'ok'
    && results.attio.status === 'ok';

  results.overall = allOk ? 'all_connected' : 'has_errors';

  return res.status(allOk ? 200 : 503).json(results);
}

function checkEnvVars() {
  const vars = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'ATTIO_API_TOKEN',
    'ASANA_ACCESS_TOKEN',
    'ASANA_WEBHOOK_SECRET',
    'ATTIO_ONBOARDING_SLUG',
  ];
  const result = {};
  for (const v of vars) {
    result[v] = process.env[v] ? 'set' : 'missing';
  }
  return result;
}
