import { createClient } from '@supabase/supabase-js';
import { CSM_PROJECT } from '../config/onboarding-config.js';
import {
  duplicateProject,
  pollJob,
  getProjectSections,
  renameSection,
  createSection,
  createTask,
  updateProjectCustomFields,
  resolveOrCreateEnumOptionGids,
  createWebhook,
  getProjectTasks,
  updateTask,
  findClientPortfolio,
  createPortfolio,
  addProjectToPortfolio,
  updatePortfolioCustomFields,
  addPortfolioCustomFieldSetting,
  getPortfolioMultiEnumValue,
  getProjectTasksWithStatus,
  waitForCustomFieldSettings,
  moveTaskToSectionPosition,
} from './_asanaHelper.js';

export const config = { api: { bodyParser: true } };

/**
 * api/csm-project.js — backend del módulo "Proyectos" de csm-audit.
 *
 * Llamado por csm-audit (nunca directamente por el navegador) con un
 * header `Authorization: Bearer <CSM_AUDIT_SHARED_SECRET>`.
 *
 *   POST ?action=create            — duplica la plantilla CSM, crea
 *                                     secciones/tareas por iniciativa,
 *                                     setea custom fields y registra el
 *                                     mapping + webhook de seguimiento.
 *   GET  ?action=status-updates    — historial de status updates de un
 *                                     proyecto (espejo escrito por
 *                                     onboarding-sync.js).
 */
export default async function handler(req, res) {
  const expected = process.env.CSM_AUDIT_SHARED_SECRET;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || got !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = req.query?.action;

  if (action === 'status-updates' && req.method === 'GET') {
    return handleStatusUpdates(req, res);
  }
  if (action === 'task-status' && req.method === 'GET') {
    return handleTaskStatus(req, res);
  }
  if (action === 'create' && req.method === 'POST') {
    return handleCreate(req, res);
  }
  return res.status(400).json({ error: 'Unknown action or wrong method' });
}

/**
 * GET ?action=task-status&project_gid=... — avance por sección (iniciativa)
 * del proyecto ya creado en Asana: nombre + completado de cada tarea,
 * agrupadas por la sección a la que pertenecen. Usado en los pasos
 * Seguimiento/Resultados de csm-audit para mostrar progreso real sin tener
 * que abrir Asana.
 */
async function handleTaskStatus(req, res) {
  const projectGid = req.query?.project_gid;
  if (!projectGid) return res.status(400).json({ error: 'project_gid is required' });

  try {
    const tasks = await getProjectTasksWithStatus(projectGid);
    const order = [];
    const bySection = new Map();
    for (const t of tasks) {
      const sectionName = t.memberships?.[0]?.section?.name || 'Sin sección';
      if (!bySection.has(sectionName)) { bySection.set(sectionName, []); order.push(sectionName); }
      bySection.get(sectionName).push({ name: t.name, completed: !!t.completed });
    }
    const sections = order.map((name) => ({ name, tasks: bySection.get(name) }));
    return res.status(200).json({ sections });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function handleStatusUpdates(req, res) {
  const projectGid = req.query?.project_gid;
  if (!projectGid) return res.status(400).json({ error: 'project_gid is required' });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('csm_project_status_updates')
    .select('asana_status_gid, title, text, color, author_name, attio_note_created, created_at_asana, created_at')
    .eq('asana_project_gid', projectGid)
    .order('created_at_asana', { ascending: false, nullsFirst: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ updates: data || [] });
}

/**
 * Body shape:
 * {
 *   atomId, companyRecordId, companyName, attioCompanyUrl, projectLabel,
 *   iniciativas: [{ name, tasks: [{ name, notes }] }],   // mínimo 1
 *   cicloDeVidaOptionGid, planContratadoOptionGid, industriaOptionGid,
 *   paisOptionGid, totalMrr   // opcionales — se omite el campo si no viene
 * }
 */
async function handleCreate(req, res) {
  const body = req.body || {};
  const { atomId, companyRecordId, companyName, attioCompanyUrl, projectLabel, iniciativas, baselineUrl, sowUrl } = body;

  if (!companyRecordId || !projectLabel || !Array.isArray(iniciativas) || iniciativas.length === 0) {
    return res.status(400).json({ error: 'companyRecordId, projectLabel e iniciativas (≥1) son requeridos' });
  }

  try {
    // 1. Duplicar la plantilla
    const job = await duplicateProject(CSM_PROJECT.template_project_gid, {
      name: projectLabel,
      teamGid: undefined,
    });
    const completedJob = await pollJob(job.gid);
    const newProjectGid = completedJob.new_project?.gid;
    if (!newProjectGid) throw new Error('Asana no devolvió el nuevo proyecto (job sin new_project)');
    const newProjectUrl = `https://app.asana.com/0/${newProjectGid}`;

    // 2. Secciones por iniciativa — la primera renombra el placeholder
    //    ("3. Implementación <iniciativas>", conserva el número original de
    //    la plantilla), el resto se crean nuevas a continuación de la
    //    anterior. El título siempre lista TODAS las iniciativas de esa
    //    sección, incluidas las "absorbidas" (mergedNames, ej. WhatsApp Flows
    //    dentro de Cortex) — pedido explícito 2026-10-13.
    const sections = await getProjectSections(newProjectGid);
    const placeholder = sections.find((s) => s.name.includes(CSM_PROJECT.initiative_section_placeholder));
    const placeholderNumberMatch = placeholder?.name.match(/^(\d+)\.\s*/);
    const sectionTitle = (ini) => `Implementación ${[ini.name, ...(ini.mergedNames || [])].join(' + ')}`;

    const sectionGidByIniciativa = [];
    let afterGid = placeholder?.gid;
    for (let i = 0; i < iniciativas.length; i++) {
      const title = i === 0 && placeholderNumberMatch ? `${placeholderNumberMatch[1]}. ${sectionTitle(iniciativas[i])}` : sectionTitle(iniciativas[i]);
      if (i === 0 && placeholder) {
        await renameSection(placeholder.gid, title);
        sectionGidByIniciativa.push(placeholder.gid);
        afterGid = placeholder.gid;
      } else {
        const created = await createSection(newProjectGid, title, { afterSectionGid: afterGid });
        sectionGidByIniciativa.push(created.gid);
        afterGid = created.gid;
      }
    }

    // 3. Tareas por iniciativa (el contenido exacto lo manda csm-audit ya
    //    redactado desde el paso 1+2). En la sección del placeholder, la
    //    plantilla ya trae "Tickets" y el hito "Salida a producción" — se
    //    reordenan después de crear las tareas custom: Tickets justo después
    //    de la primera, el hito al final de todas. Pedido explícito 2026-10-13.
    for (let i = 0; i < iniciativas.length; i++) {
      const tasks = iniciativas[i].tasks || [];
      const createdTaskGids = [];
      for (const t of tasks) {
        const created = await createTask(newProjectGid, { name: t.name, notes: t.notes || '', sectionGid: sectionGidByIniciativa[i] });
        createdTaskGids.push(created.gid);
      }
      if (i === 0 && placeholder && createdTaskGids.length > 0) {
        try {
          const existing = await getProjectTasks(newProjectGid);
          const ticketsTask = existing.find((t) => t.name === CSM_PROJECT.iniciativa_tickets_task_name);
          const hitoTask = existing.find((t) => t.name === CSM_PROJECT.iniciativa_hito_task_name);
          if (ticketsTask) await moveTaskToSectionPosition(sectionGidByIniciativa[i], ticketsTask.gid, { insertAfter: createdTaskGids[0] });
          if (hitoTask) await moveTaskToSectionPosition(sectionGidByIniciativa[i], hitoTask.gid, { insertAfter: createdTaskGids[createdTaskGids.length - 1] });
        } catch (e) {
          console.warn('[csm-project] No se pudo reordenar Tickets/hito (no bloqueante):', e.message);
        }
      }
    }

    // 3b. Completar la descripción de las tareas "Baseline" (sección
    //     Diagnóstico) y "SOW" (sección Plan de acción) con los links de los
    //     pasos 1 y 2 del wizard — pedido explícito: así quien abre el
    //     proyecto en Asana llega directo al baseline y al SOW firmado sin
    //     tener que pedírselo al CSM.
    if (baselineUrl || sowUrl) {
      try {
        const allTasks = await getProjectTasks(newProjectGid);
        const appendLink = async (taskName, label, url) => {
          if (!url) return;
          const task = allTasks.find((t) => t.name === taskName);
          if (!task) return;
          const notes = [task.notes?.trim(), `${label}: ${url}`].filter(Boolean).join('\n\n');
          await updateTask(task.gid, { notes });
        };
        await appendLink(CSM_PROJECT.baseline_task_name, 'Baseline', baselineUrl);
        await appendLink(CSM_PROJECT.sow_task_name, 'SOW firmado', sowUrl);
      } catch (e) {
        console.warn('[csm-project] No se pudieron completar los links de Baseline/SOW (no bloqueante):', e.message);
      }
    }

    // 4. Resuelve "Iniciativa" ANTES de tocar portfolio/proyecto — se usa en
    //    los dos. Incluye también las "absorbidas" dentro de otra sección
    //    (ej. WhatsApp Flows dentro de Cortex, ver mergedNames en csm-audit)
    //    para que sigan apareciendo en el campo aunque no tengan su propia
    //    sección.
    const fields = CSM_PROJECT.fields;
    const iniciativaNames = iniciativas.flatMap((i) => [i.name, ...(i.mergedNames || [])]).filter(Boolean);
    const iniciativaGids = iniciativaNames.length > 0
      ? await resolveOrCreateEnumOptionGids(fields.iniciativa, iniciativaNames)
      : [];

    // 5. Ubicar el proyecto dentro de la carpeta (sub-portfolio) del cliente
    //    en el portfolio "Clientes" — si no existe todavía, se crea con la
    //    misma metadata que el proyecto (ver create-all-client-portfolios.js
    //    para la referencia original de este patrón). No bloqueante: si
    //    falla, el proyecto ya quedó creado en Asana igual, solo no quedó
    //    organizado dentro de la carpeta del cliente. Va ANTES de los custom
    //    fields del proyecto (mismo orden que attio-onboarding-webhook.js:
    //    duplicar → portafolio → actualizar info) — de paso, como esto
    //    implica varias llamadas de red, le da tiempo a Asana para terminar
    //    de propagar los custom_field_settings del proyecto recién duplicado
    //    antes del paso 6.
    //
    //    Atom ID e Iniciativa se trackean SIEMPRE a nivel del portfolio del
    //    cliente (no solo al crearlo) — pedido explícito 2026-10-14: poder
    //    ver qué iniciativas tiene cada cliente sin entrar a cada proyecto.
    //    "Iniciativa" es multi_enum acumulativo: se mergea con lo que ya
    //    tenía el portfolio, nunca se pisa (varios proyectos del mismo
    //    cliente pueden sumar iniciativas distintas con el tiempo).
    // true cuando el portfolio es nuevo y Asana todavía no terminó de
    // propagar la habilitación de sus custom fields (confirmado 2026-10-14:
    // un portfolio recién creado puede tardar varios minutos en aceptar
    // valores aunque el GET ya lo muestre habilitado — csm-audit avisa en la
    // UI cuando esto pasa, en vez de reintentar a ciegas dentro del request).
    let portfolioFieldsPending = false;
    let clientPortfolioUrl = null;
    try {
      const clientesGid = CSM_PROJECT.clientes_portfolio_gid;
      let clientPortfolio = await findClientPortfolio(
        clientesGid,
        { atomId, attioCompanyId: companyRecordId },
        fields,
      );
      let isNewPortfolio = false;
      if (!clientPortfolio) {
        isNewPortfolio = true;
        clientPortfolio = await createPortfolio(companyName || projectLabel, CSM_PROJECT.workspace_gid);
        await addProjectToPortfolio(clientesGid, clientPortfolio.gid);
      }
      // Se expone en la respuesta (y de ahí a csm-audit) para poder entrar
      // directo al portfolio del cliente y agregar/ajustar iniciativas a
      // mano — no reemplaza la búsqueda de arriba, solo da acceso directo.
      // Pedido explícito 2026-10-14.
      clientPortfolioUrl = `https://app.asana.com/0/portfolio/${clientPortfolio.gid}`;

      if (isNewPortfolio) {
        // Portfolio recién creado: no tiene NINGÚN custom field habilitado
        // todavía (a diferencia del proyecto, que lo hereda de la plantilla).
        const toEnable = [
          fields.atom_id, fields.attio_company_id, fields.url_attio, fields.iniciativa,
          fields.ciclo_de_vida, fields.plan_contratado, fields.industria, fields.pais, fields.total_mrr,
        ];
        for (const gid of toEnable) {
          try { await addPortfolioCustomFieldSetting(clientPortfolio.gid, gid); } catch (e) {
            console.warn(`[csm-project] No se pudo habilitar el custom field ${gid} en el portfolio (no bloqueante):`, e.message);
          }
        }
      }

      const portfolioFields = {};
      if (atomId) portfolioFields[fields.atom_id] = atomId;
      if (companyRecordId) portfolioFields[fields.attio_company_id] = companyRecordId;
      if (attioCompanyUrl) portfolioFields[fields.url_attio] = attioCompanyUrl;
      if (iniciativaGids.length > 0) {
        const existingGids = isNewPortfolio ? [] : await getPortfolioMultiEnumValue(clientPortfolio.gid, fields.iniciativa).catch(() => []);
        portfolioFields[fields.iniciativa] = [...new Set([...existingGids, ...iniciativaGids])];
      }
      if (isNewPortfolio) {
        portfolioFields[fields.ciclo_de_vida] = body.cicloDeVidaOptionGid || CSM_PROJECT.ciclo_de_vida_cliente_option_gid;
        if (body.planContratadoOptionGid) portfolioFields[fields.plan_contratado] = body.planContratadoOptionGid;
        if (body.industriaOptionGid) portfolioFields[fields.industria] = body.industriaOptionGid;
        if (body.paisOptionGid) portfolioFields[fields.pais] = body.paisOptionGid;
        if (typeof body.totalMrr === 'number') portfolioFields[fields.total_mrr] = body.totalMrr;
      }
      if (Object.keys(portfolioFields).length > 0) {
        try {
          await updatePortfolioCustomFields(clientPortfolio.gid, portfolioFields);
        } catch (e) {
          if (isNewPortfolio) portfolioFieldsPending = true;
          console.warn('[csm-project] No se pudieron setear los custom fields del portfolio (no bloqueante):', e.message);
        }
      }

      await addProjectToPortfolio(clientPortfolio.gid, newProjectGid);
    } catch (e) {
      console.warn('[csm-project] No se pudo ubicar el proyecto en el portfolio del cliente (no bloqueante):', e.message);
    }

    // 6. Custom fields a nivel proyecto — SOLO identificadores (Atom ID,
    //    Attio Company ID, URL Attio, Iniciativa). Ciclo de vida, Plan
    //    contratado, Industria, País y Total MRR viven a nivel del portfolio
    //    del cliente (paso 5), no del proyecto.
    const customFieldValues = {};
    if (atomId) customFieldValues[fields.atom_id] = atomId;
    if (companyRecordId) customFieldValues[fields.attio_company_id] = companyRecordId;
    if (attioCompanyUrl) customFieldValues[fields.url_attio] = attioCompanyUrl;
    if (iniciativaGids.length > 0) customFieldValues[fields.iniciativa] = iniciativaGids;

    // Por si el paso 5 de arriba no alcanzó a darle suficiente tiempo a
    // Asana (ej. no había portfolio de cliente que crear) — sondea el estado
    // real en vez de escribir a ciegas (bug encontrado 2026-10-13: 400
    // "Custom field ... is not on given object").
    if (Object.keys(customFieldValues).length > 0) {
      const ready = await waitForCustomFieldSettings(newProjectGid, Object.keys(customFieldValues), { maxAttempts: 12, intervalMs: 2500 });
      if (!ready) console.warn('[csm-project] custom_field_settings no terminó de propagarse a tiempo (no bloqueante)');
      else await updateProjectCustomFields(newProjectGid, customFieldValues);
    }

    // 7. Webhook de seguimiento — reusa api/asana-webhook.js, ya genérico
    //    (filtra por project_status "added" y resuelve el mapping por team).
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = process.env.APP_URL || `${protocol}://${host}`;
    try {
      await createWebhook(newProjectGid, `${origin}/api/asana-webhook`);
    } catch (e) {
      console.warn('[csm-project] Webhook registration failed (non-blocking):', e.message);
    }

    // 8. Mapping para que onboarding-sync.js sepa que este proyecto es
    //    'csm_project' y cuál es su hilo conductor.
    const supabase = getSupabase();
    const { error: mapErr } = await supabase.from('onboarding_mapping').upsert({
      attio_record_id: companyRecordId,
      asana_project_gid: newProjectGid,
      team: 'csm_project',
      project_label: projectLabel,
      active: true,
    }, { onConflict: 'asana_project_gid' });
    if (mapErr) console.warn('[csm-project] Mapping insert failed (non-blocking):', mapErr.message);

    return res.status(200).json({
      success: true,
      asana_project_gid: newProjectGid,
      asana_project_url: newProjectUrl,
      section_gids: sectionGidByIniciativa,
      portfolio_fields_pending: portfolioFieldsPending,
      client_portfolio_url: clientPortfolioUrl,
    });
  } catch (err) {
    console.error('[csm-project] Create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}
