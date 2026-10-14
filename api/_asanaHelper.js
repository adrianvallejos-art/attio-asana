/**
 * Asana API helper — Onboarding Sync project
 *
 * Provides:
 *   - getProject(projectGid)
 *   - getProjectCustomField(projectGid, fieldName)
 *   - getProjectStatusUpdates(projectGid)
 *   - getTasksForProject(projectGid)
 *   - createTask(projectGid, taskData)
 *   - updateProjectDescription(projectGid, description)
 *   - createWebhook(projectGid, targetUrl)
 *   - deleteWebhook(webhookGid)
 */

const ASANA_BASE = 'https://app.asana.com/api/1.0';

function getToken() {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) throw new Error('[Asana] ASANA_ACCESS_TOKEN not set');
  return token;
}

async function asanaFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${ASANA_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Asana ${options.method || 'GET'} ${path} failed (${res.status}): ${JSON.stringify(err.errors || err)}`);
  }

  const json = await res.json();
  return json.data;
}

/**
 * Get project details.
 */
export async function getProject(projectGid) {
  return asanaFetch(`/projects/${projectGid}?opt_fields=name,notes,current_status,custom_fields,owner,members`);
}

/**
 * Extract a custom field value from a project.
 */
export async function getProjectCustomField(projectGid, fieldName) {
  const project = await getProject(projectGid);
  const field = project.custom_fields?.find(
    (f) => f.name === fieldName || f.gid === fieldName
  );
  if (!field) return null;
  return field.text_value || field.display_value || field.number_value || null;
}

/**
 * Get status updates (project updates) for a project.
 */
export async function getProjectStatusUpdates(projectGid, { limit = 10 } = {}) {
  return asanaFetch(`/projects/${projectGid}/project_statuses?opt_fields=gid,title,text,color,author.name,created_at&limit=${limit}`);
}

/**
 * Get tasks in a project.
 */
export async function getTasksForProject(projectGid, { completed = false, limit = 50 } = {}) {
  const completedParam = completed ? '' : '&completed_since=now';
  return asanaFetch(
    `/projects/${projectGid}/tasks?opt_fields=name,completed,due_on,assignee,notes&limit=${limit}${completedParam}`
  );
}

/**
 * Create a task in a project.
 */
export async function createTask(projectGid, { name, notes = '', due_on, assignee, custom_fields, sectionGid }) {
  // "projects" es obligatorio siempre — "memberships" solo AGREGA la sección
  // dentro de ese proyecto, no lo reemplaza (bug 2026-10-13: Asana devolvía
  // 400 "You should specify one of workspace, parent, projects" cuando solo
  // se mandaba memberships sin projects).
  const data = { name, notes, due_on, projects: [projectGid] };
  if (assignee) data.assignee = assignee;
  if (custom_fields && Object.keys(custom_fields).length) data.custom_fields = custom_fields;
  if (sectionGid) data.memberships = [{ project: projectGid, section: sectionGid }];
  return asanaFetch('/tasks', { method: 'POST', body: JSON.stringify({ data }) });
}

/**
 * Update custom field values on a project.
 * @param {string} projectGid
 * @param {Record<string, string>} fields  — { [fieldGid]: value }
 */
export async function updateProjectCustomFields(projectGid, fields) {
  return asanaFetch(`/projects/${projectGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { custom_fields: fields } }),
  });
}

/**
 * Espera a que Asana termine de copiar los custom_field_settings de la
 * plantilla al proyecto recién duplicado — justo después de duplicate+poll
 * esto puede tardar varios segundos (eventual consistency), y escribir
 * custom_fields antes revienta con 400 "Custom field ... is not on given
 * object" (bug 2026-10-13). Sondea directo el estado real en vez de
 * reintentar a ciegas sobre el texto del error.
 */
export async function waitForCustomFieldSettings(projectGid, requiredFieldGids, opts = {}) {
  return waitForResourceCustomFieldSettings('projects', projectGid, requiredFieldGids, opts);
}

/**
 * Igual que waitForCustomFieldSettings pero para un portfolio — el mismo
 * retraso de propagación de Asana aplica ahí (confirmado 2026-10-14: un
 * portfolio recién creado también puede "mostrarse" habilitado vía GET y
 * seguir rechazando el PUT de valores por unos segundos más).
 */
export async function waitForPortfolioCustomFieldSettings(portfolioGid, requiredFieldGids, opts = {}) {
  return waitForResourceCustomFieldSettings('portfolios', portfolioGid, requiredFieldGids, opts);
}

async function waitForResourceCustomFieldSettings(resourcePath, gid, requiredFieldGids, { maxAttempts = 10, intervalMs = 2000 } = {}) {
  const required = new Set(requiredFieldGids);
  for (let i = 0; i < maxAttempts; i++) {
    const resource = await asanaFetch(`/${resourcePath}/${gid}?opt_fields=custom_field_settings.custom_field.gid`);
    const present = new Set((resource.custom_field_settings || []).map((s) => s.custom_field?.gid));
    if ([...required].every((fgid) => present.has(fgid))) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Update a project's description.
 */
export async function updateProjectDescription(projectGid, notes) {
  return asanaFetch(`/projects/${projectGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { notes } }),
  });
}

/**
 * Register a webhook for a project.
 */
export async function createWebhook(projectGid, targetUrl) {
  return asanaFetch('/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        resource: projectGid,
        target: targetUrl,
        filters: [
          { resource_type: 'project_status', action: 'added' },
        ],
      },
    }),
  });
}

/**
 * Delete (unsubscribe) a webhook.
 */
export async function deleteWebhook(webhookGid) {
  const token = getToken();
  const res = await fetch(`${ASANA_BASE}/webhooks/${webhookGid}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/**
 * Duplicate a project from a template.
 * Returns the Asana Job object — poll with pollJob() to get the new project GID.
 */
export async function duplicateProject(templateGid, { name, teamGid, startOn, dueOn }) {
  const data = {
    name,
    team: teamGid,
    include: [
      'members', 'notes', 'task_notes', 'task_assignee', 'task_subtasks',
      'task_attachments', 'task_dates', 'task_dependencies',
      'task_followers', 'task_tags', 'task_projects',
    ],
  };
  // schedule_dates requiere EXACTAMENTE una de start_on/due_on — si no viene
  // ninguna (caso normal acá, csm-project.js nunca las manda) hay que omitir
  // el objeto entero, no mandarlo con ambas en undefined (bug 2026-10-13:
  // Asana devolvía 400 duplicating_with_schedule_dates_requires_one_of...).
  if (startOn && dueOn) {
    throw new Error('duplicateProject: pasa startOn O dueOn, no ambas');
  }
  if (startOn || dueOn) {
    data.schedule_dates = { should_skip_weekends: false, start_on: startOn, due_on: dueOn };
  }
  return asanaFetch(`/projects/${templateGid}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
}

/**
 * Poll an Asana Job until it completes.
 * Returns the job data (includes new_project.gid when status = 'succeeded').
 */
export async function pollJob(jobGid, { maxAttempts = 20, intervalMs = 2000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const job = await asanaFetch(`/jobs/${jobGid}`);
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed') throw new Error(`Asana job ${jobGid} failed`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Asana job ${jobGid} timed out after ${maxAttempts} attempts`);
}

/**
 * Add a project to a portfolio.
 */
export async function addProjectToPortfolio(portfolioGid, projectGid) {
  return asanaFetch(`/portfolios/${portfolioGid}/addItem`, {
    method: 'POST',
    body: JSON.stringify({ data: { item: projectGid } }),
  });
}

/**
 * Create a new portfolio. `color`/`public` default to match the existing
 * client-folder convention (create-all-client-portfolios.js) — light-green,
 * visible to the workspace — not the original light-blue/private default.
 */
export async function createPortfolio(name, workspaceGid, { color = 'light-green', isPublic = true } = {}) {
  return asanaFetch('/portfolios', {
    method: 'POST',
    body: JSON.stringify({
      data: { name, workspace: workspaceGid, color, public: isPublic },
    }),
  });
}

/**
 * All items (projects AND sub-portfolios) of a portfolio, paginated.
 * `optFields` defaults to what's needed to match a client folder by its
 * Atom ID / Attio Company ID custom fields (see findClientPortfolio).
 */
export async function getPortfolioItems(portfolioGid, optFields = 'name,resource_type,custom_fields.gid,custom_fields.text_value') {
  const items = [];
  let offset;
  do {
    const path = `/portfolios/${portfolioGid}/items?opt_fields=${optFields}&limit=100${offset ? `&offset=${offset}` : ''}`;
    const token = getToken();
    const res = await fetch(`${ASANA_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`Asana GET ${path} failed (${res.status}): ${JSON.stringify(json.errors || json)}`);
    items.push(...(json.data || []));
    offset = json.next_page?.offset;
  } while (offset);
  return items;
}

/**
 * Find the client's own portfolio (sub-portfolio of "Clientes") by Atom ID or
 * Attio Company ID custom field value. No live single-lookup endpoint exists
 * for this in Asana — list all items of CLIENTES_GID and filter in memory,
 * same approach as update-clientes-portfolio.js.
 */
export async function findClientPortfolio(clientesPortfolioGid, { atomId, attioCompanyId }, fieldGids) {
  const items = await getPortfolioItems(clientesPortfolioGid);
  const cfVal = (item, fieldGid) => (item.custom_fields || []).find((f) => f.gid === fieldGid)?.text_value?.trim() || null;
  return items.find((it) => {
    if (it.resource_type !== 'portfolio') return false;
    if (atomId && cfVal(it, fieldGids.atom_id) === atomId) return true;
    if (attioCompanyId && cfVal(it, fieldGids.attio_company_id) === attioCompanyId) return true;
    return false;
  }) || null;
}

/**
 * Update custom field values on a portfolio (same shape as updateProjectCustomFields).
 */
export async function updatePortfolioCustomFields(portfolioGid, fields) {
  return asanaFetch(`/portfolios/${portfolioGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { custom_fields: fields } }),
  });
}

/**
 * Habilita un custom field en un portfolio — un portfolio recién creado no
 * tiene NINGUNO habilitado todavía (a diferencia de un proyecto duplicado de
 * una plantilla que ya los trae). Sin esto, updatePortfolioCustomFields
 * devuelve 400 "Custom field ... is not on given object". Pedido explícito
 * 2026-10-14: trackear Atom ID e Iniciativa a nivel del portfolio del cliente.
 */
export async function addPortfolioCustomFieldSetting(portfolioGid, fieldGid) {
  return asanaFetch(`/portfolios/${portfolioGid}/addCustomFieldSetting`, {
    method: 'POST',
    body: JSON.stringify({ data: { custom_field: fieldGid } }),
  });
}

/**
 * GIDs actualmente seleccionados de un custom field multi_enum en un
 * portfolio — para mergear (no pisar) cuando varios proyectos del mismo
 * cliente van sumando iniciativas distintas al mismo portfolio.
 */
export async function getPortfolioMultiEnumValue(portfolioGid, fieldGid) {
  const portfolio = await asanaFetch(`/portfolios/${portfolioGid}?opt_fields=custom_fields.gid,custom_fields.multi_enum_values.gid`);
  const field = (portfolio.custom_fields || []).find((f) => f.gid === fieldGid);
  return (field?.multi_enum_values || []).map((v) => v.gid);
}

/**
 * Update a project (name, public, start_on, due_on, owner, etc.)
 */
export async function updateProject(projectGid, data) {
  return asanaFetch(`/projects/${projectGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}

/**
 * Get all tasks in a project with their custom fields and names.
 */
export async function getProjectTasks(projectGid) {
  return asanaFetch(
    `/projects/${projectGid}/tasks?opt_fields=gid,name,notes,custom_fields.gid,custom_fields.name,custom_fields.text_value&limit=100`
  );
}

/**
 * All tasks in a project with completion state and which section they belong
 * to — para mostrar avance por sección (iniciativa) en csm-audit (paso 4/5).
 */
export async function getProjectTasksWithStatus(projectGid) {
  return asanaFetch(
    `/projects/${projectGid}/tasks?opt_fields=gid,name,completed,memberships.section.name&limit=100`
  );
}

/**
 * Update a task.
 */
export async function updateTask(taskGid, data) {
  return asanaFetch(`/tasks/${taskGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}

/**
 * Find an Asana user by email. Returns the user GID or null.
 */
export async function getUserByEmail(email, workspaceGid) {
  try {
    const users = await asanaFetch(
      `/users?workspace=${workspaceGid}&opt_fields=gid,email&limit=100`
    );
    const match = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    return match?.gid || null;
  } catch {
    return null;
  }
}

/**
 * List sections of a project (max 50 — templates are small, no pagination needed).
 */
export async function getProjectSections(projectGid) {
  return asanaFetch(`/projects/${projectGid}/sections?opt_fields=name&limit=50`);
}

/**
 * Rename an existing section.
 */
export async function renameSection(sectionGid, name) {
  return asanaFetch(`/sections/${sectionGid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { name } }),
  });
}

/**
 * Reposiciona una tarea YA EXISTENTE dentro de una sección (no crea nada
 * nuevo) — usado para que el "hito" y "Tickets" de la plantilla queden en el
 * orden pedido una vez que ya se agregaron las tareas custom de la iniciativa.
 */
export async function moveTaskToSectionPosition(sectionGid, taskGid, { insertAfter, insertBefore } = {}) {
  const data = { task: taskGid };
  if (insertAfter) data.insert_after = insertAfter;
  if (insertBefore) data.insert_before = insertBefore;
  return asanaFetch(`/sections/${sectionGid}/addTask`, {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
}

/**
 * Create a new section in a project, inserted after `afterSectionGid` when given.
 */
export async function createSection(projectGid, name, { afterSectionGid } = {}) {
  const data = { name };
  return asanaFetch(`/projects/${projectGid}/sections`, {
    method: 'POST',
    body: JSON.stringify({ data: afterSectionGid ? { ...data, insert_after: afterSectionGid } : data }),
  });
}

/**
 * Get a custom field's definition, including its current enum_options (with gids).
 */
export async function getCustomField(customFieldGid) {
  return asanaFetch(`/custom_fields/${customFieldGid}?opt_fields=name,enum_options.name,enum_options.gid`);
}

/**
 * Create a new enum option on a (single or multi) enum custom field.
 * Returns the created option { gid, name, ... }.
 */
export async function createEnumOption(customFieldGid, name) {
  return asanaFetch(`/custom_fields/${customFieldGid}/enum_options`, {
    method: 'POST',
    body: JSON.stringify({ data: { name } }),
  });
}

/**
 * Resolve a list of label strings to enum_option gids for a multi_enum custom
 * field, creating any option that doesn't exist yet. Case-insensitive match.
 */
export async function resolveOrCreateEnumOptionGids(customFieldGid, labels) {
  const field = await getCustomField(customFieldGid);
  const existing = field.enum_options || [];
  const gids = [];
  for (const label of labels) {
    const clean = String(label || '').trim();
    if (!clean) continue;
    const found = existing.find((o) => o.name.toLowerCase() === clean.toLowerCase());
    if (found) {
      gids.push(found.gid);
    } else {
      const created = await createEnumOption(customFieldGid, clean);
      gids.push(created.gid);
      existing.push(created);
    }
  }
  return gids;
}
