import { createClient } from '@supabase/supabase-js';
import { ASANA, ATTIO } from '../config/onboarding-config.js';
import { getAttioRecord, getAttioAssociation } from './_attioHelper.js';
import {
  duplicateProject,
  pollJob,
  updateProject,
  addProjectToPortfolio,
  createPortfolio,
  getProjectTasks,
  updateTask,
  getUserByEmail,
  createWebhook,
} from './_asanaHelper.js';

export const config = { api: { bodyParser: true } };

/**
 * POST /api/attio-onboarding-webhook
 *
 * Recibe el webhook de Attio cuando se crea un record en el objeto Onboarding.
 * Ejecuta el flujo completo:
 *   1. Obtiene datos del Onboarding, Company y Deal desde Attio
 *   2. Duplica el proyecto template en Asana
 *   3. Configura nombre, fechas, acceso, campos custom y descripción
 *   4. Agrega al portfolio OB Customers + crea portfolio del cliente
 *   5. Actualiza las 2 tareas clave del proyecto
 *   6. Registra el webhook de Asana para sincronización futura
 *   7. Crea el mapping en Supabase
 *
 * Configurar en Attio: Settings → Webhooks → Create
 *   URL: https://attio-asana-sync.vercel.app/api/attio-onboarding-webhook
 *   Events: record.created (object: onboardings)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;

  // ── 1. Validate event ─────────────────────────────────────────────
  const eventType = body?.event_type;
  const objectSlug = body?.object?.slug || body?.object_type;

  // Accept both record.created and record_created formats
  if (!eventType?.includes('created') || !objectSlug?.includes('onboarding')) {
    return res.status(200).json({ skipped: true, reason: `Not an onboarding created event (${eventType} / ${objectSlug})` });
  }

  const onboardingRecordId = body?.record?.id?.record_id || body?.record_id;
  if (!onboardingRecordId) {
    return res.status(400).json({ error: 'No record_id in payload' });
  }

  console.log('[attio-webhook] Onboarding created:', onboardingRecordId);

  // ── 2. Fetch Onboarding record from Attio ─────────────────────────
  let onboarding;
  try {
    const r = await getAttioRecord('onboardings', onboardingRecordId);
    onboarding = r?.data;
  } catch (e) {
    return res.status(500).json({ error: `Failed to fetch onboarding: ${e.message}` });
  }

  const onbValues = onboarding?.values || {};

  // ── 3. Extract Company association ───────────────────────────────
  const companyRefs = await getAttioAssociation('onboardings', onboardingRecordId, ATTIO.onboarding.company);
  const companyRecordId = companyRefs[0]?.record_id || null;

  let companyName = null;
  if (companyRecordId) {
    try {
      const companyRecord = await getAttioRecord('companies', companyRecordId);
      const nameAttr = companyRecord?.data?.values?.name;
      companyName = nameAttr?.[0]?.value || nameAttr?.[0]?.full_value || null;
    } catch { /* non-blocking */ }
  }

  // ── 4. Extract Deal association ───────────────────────────────────
  const dealRefs = await getAttioAssociation('onboardings', onboardingRecordId, ATTIO.onboarding.deal);
  const dealRecordId = dealRefs[0]?.record_id || null;

  let dealName = companyName || 'Nuevo cliente';
  let mrr = null;
  let sowUrl = null;
  let baselineUrl = null;
  let ownerEmail = null;
  let partnerName = null;

  if (dealRecordId) {
    try {
      const dealRecord = await getAttioRecord('deals', dealRecordId);
      const dv = dealRecord?.data?.values || {};

      dealName = extractText(dv[ATTIO.deal.name]) || dealName;
      mrr = extractNumber(dv[ATTIO.deal.mrr]);
      sowUrl = extractText(dv[ATTIO.deal.sow_url]);
      baselineUrl = extractText(dv[ATTIO.deal.baseline_url]);
      ownerEmail = extractEmail(dv[ATTIO.deal.owner_email]);

      // Partner: association attribute
      const partnerRefs = dv[ATTIO.deal.partner] || [];
      if (partnerRefs.length > 0) {
        const partnerRef = partnerRefs[0];
        partnerName = partnerRef?.target_record?.values?.name?.[0]?.value
          || partnerRef?.value
          || null;
      }
    } catch (e) {
      console.warn('[attio-webhook] Could not fetch deal:', e.message);
    }
  }

  // ── 5. Extract Onboarding fields ──────────────────────────────────
  const industryRaw = extractOption(onbValues[ATTIO.onboarding.industry]);
  const countryRaw  = extractText(onbValues[ATTIO.onboarding.country]);
  const ownerAttio  = onbValues[ATTIO.onboarding.owner]?.[0];

  const industryAsanaGid = ASANA.industry_map[industryRaw?.toLowerCase?.()] || null;
  const countryAsanaGid  = ASANA.country_map[countryRaw?.toUpperCase?.()] || null;

  // Dates: start = today, end = start + 1 month
  const createdAt = onboarding?.created_at || new Date().toISOString();
  const startDate = createdAt.split('T')[0];
  const endDate   = addOneMonth(startDate);

  // Project name
  const projectName = `${dealName} - ONB`;

  // Attio URL for this onboarding record
  const attioUrl = ATTIO.onboarding_url(onboardingRecordId);

  console.log('[attio-webhook] Project name:', projectName);
  console.log('[attio-webhook] Company:', companyName, '| Deal:', dealName, '| MRR:', mrr);

  // ── 6. Duplicate Asana template ───────────────────────────────────
  if (ASANA.template_project_gid === 'TODO') {
    return res.status(500).json({ error: 'template_project_gid not configured in config/onboarding-config.js' });
  }

  let newProjectGid;
  try {
    const job = await duplicateProject(ASANA.template_project_gid, {
      name: projectName,
      teamGid: ASANA.team_gid,
      startOn: startDate,
      dueOn: endDate,
    });
    const completedJob = await pollJob(job.gid);
    newProjectGid = completedJob.new_project?.gid;
    if (!newProjectGid) throw new Error('Job completed but new_project.gid is missing');
  } catch (e) {
    return res.status(500).json({ error: `Project duplication failed: ${e.message}` });
  }

  console.log('[attio-webhook] New project GID:', newProjectGid);

  // ── 7. Resolve Asana owner ────────────────────────────────────────
  let ownerGid = null;
  const resolvedEmail = ownerEmail || extractEmail([ownerAttio]);
  if (resolvedEmail) {
    ownerGid = await getUserByEmail(resolvedEmail, ASANA.workspace_gid);
  }

  // ── 8. Build custom fields patch ─────────────────────────────────
  const customFields = {
    [ASANA.fields.ciclo_de_vida]:    ASANA.ciclo_de_vida_initial_option,
    [ASANA.fields.attio_onb_id]:     onboardingRecordId,
  };
  if (companyRecordId && ASANA.fields.attio_company_id !== 'TODO') {
    customFields[ASANA.fields.attio_company_id] = companyRecordId;
  }
  if (mrr != null && ASANA.fields.mrr !== 'TODO') {
    customFields[ASANA.fields.mrr] = mrr;
  }
  if (industryAsanaGid && ASANA.fields.industry !== 'TODO') {
    customFields[ASANA.fields.industry] = industryAsanaGid;
  }
  if (countryAsanaGid && ASANA.fields.country !== 'TODO') {
    customFields[ASANA.fields.country] = countryAsanaGid;
  }
  if (sowUrl && ASANA.fields.sow_url !== 'TODO') {
    customFields[ASANA.fields.sow_url] = sowUrl;
  }
  if (baselineUrl && ASANA.fields.baseline_url !== 'TODO') {
    customFields[ASANA.fields.baseline_url] = baselineUrl;
  }
  if (ASANA.fields.attio_url !== 'TODO') {
    customFields[ASANA.fields.attio_url] = attioUrl;
  }

  // ── 9. Build project description ─────────────────────────────────
  const descLines = [];
  if (industryRaw)  descLines.push(`Industria: ${industryRaw}`);
  if (countryRaw)   descLines.push(`País: ${countryRaw}`);
  if (mrr != null)  descLines.push(`MRR: ${mrr}`);
  if (ownerEmail)   descLines.push(`Owner deal: ${ownerEmail}`);
  if (partnerName)  descLines.push(`Partner: ${partnerName}`);
  if (sowUrl)       descLines.push(`SOW: ${sowUrl}`);
  if (baselineUrl)  descLines.push(`Baseline/ROI: ${baselineUrl}`);
  descLines.push(`Attio: ${attioUrl}`);
  const description = descLines.join('\n');

  // ── 10. Update project ────────────────────────────────────────────
  const projectUpdate = {
    name: projectName,
    public: true,
    start_on: startDate,
    due_on: endDate,
    notes: description,
    custom_fields: customFields,
  };
  if (ownerGid) projectUpdate.owner = ownerGid;

  try {
    await updateProject(newProjectGid, projectUpdate);
  } catch (e) {
    console.warn('[attio-webhook] Project update failed (non-blocking):', e.message);
  }

  // ── 11. Add to OB Customers portfolio ────────────────────────────
  try {
    await addProjectToPortfolio(ASANA.portfolio_ob_gid, newProjectGid);
  } catch (e) {
    console.warn('[attio-webhook] Add to OB Customers failed:', e.message);
  }

  // ── 12. Create client portfolio + add project ─────────────────────
  if (companyName) {
    try {
      const portfolio = await createPortfolio(companyName, ASANA.workspace_gid);
      const portfolioGid = portfolio.gid;
      await addProjectToPortfolio(portfolioGid, newProjectGid);
    } catch (e) {
      console.warn('[attio-webhook] Client portfolio creation failed:', e.message);
    }
  }

  // ── 13. Update the 2 key tasks ────────────────────────────────────
  if (ASANA.tasks_to_update.length > 0) {
    try {
      const tasks = await getProjectTasks(newProjectGid);
      for (const task of tasks) {
        if (!ASANA.tasks_to_update.some((name) => task.name?.includes(name))) continue;

        const taskCustomFields = {};
        if (industryAsanaGid && ASANA.task_fields.industry !== 'TODO') {
          taskCustomFields[ASANA.task_fields.industry] = industryAsanaGid;
        }
        if (countryAsanaGid && ASANA.task_fields.country !== 'TODO') {
          taskCustomFields[ASANA.task_fields.country] = countryAsanaGid;
        }

        await updateTask(task.gid, {
          name: task.name.replace(/{{CLIENT}}/gi, companyName || dealName),
          custom_fields: Object.keys(taskCustomFields).length > 0 ? taskCustomFields : undefined,
        }).catch((e) => console.warn('[attio-webhook] Task update failed:', e.message));
      }
    } catch (e) {
      console.warn('[attio-webhook] Task fetch failed:', e.message);
    }
  }

  // ── 14. Register Asana webhook for this new project ───────────────
  const origin = getOrigin(req);
  try {
    await createWebhook(newProjectGid, `${origin}/api/asana-webhook`);
  } catch (e) {
    console.warn('[attio-webhook] Webhook registration failed:', e.message);
  }

  // ── 15. Create Supabase mapping ───────────────────────────────────
  if (onboardingRecordId) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    await supabase.from('onboarding_mapping').upsert(
      {
        asana_project_gid: newProjectGid,
        attio_record_id: onboardingRecordId,
        team: 'onboarding',
        active: true,
      },
      { onConflict: 'asana_project_gid' }
    ).catch((e) => console.warn('[attio-webhook] Supabase mapping failed:', e.message));
  }

  console.log('[attio-webhook] Done:', projectName, '→', newProjectGid);

  return res.status(200).json({
    success: true,
    project_name: projectName,
    asana_project_gid: newProjectGid,
    attio_onboarding_id: onboardingRecordId,
    attio_company_id: companyRecordId,
    owner_resolved: !!ownerGid,
    industry: industryRaw,
    country: countryRaw,
    start_on: startDate,
    due_on: endDate,
  });
}

// ─── Value extractors ─────────────────────────────────────────────────────────

function extractText(attrValues) {
  if (!Array.isArray(attrValues) || attrValues.length === 0) return null;
  const v = attrValues[0];
  return v?.value || v?.text || v?.full_value || null;
}

function extractNumber(attrValues) {
  if (!Array.isArray(attrValues) || attrValues.length === 0) return null;
  const v = attrValues[0];
  const n = v?.value ?? v?.number_value ?? null;
  return n != null ? Number(n) : null;
}

function extractOption(attrValues) {
  if (!Array.isArray(attrValues) || attrValues.length === 0) return null;
  const v = attrValues[0];
  return v?.option?.title || v?.option?.id?.option_id || v?.value || null;
}

function extractEmail(attrValues) {
  if (!Array.isArray(attrValues) || attrValues.length === 0) return null;
  const v = attrValues[0];
  return v?.email_address || v?.value || (typeof v === 'string' && v.includes('@') ? v : null);
}

function addOneMonth(dateStr) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().split('T')[0];
}

function getOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return process.env.APP_URL || `${protocol}://${host}`;
}
