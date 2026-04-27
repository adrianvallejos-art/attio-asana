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
export async function createTask(projectGid, { name, notes = '', due_on, assignee }) {
  return asanaFetch('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        name,
        notes,
        due_on,
        assignee,
        projects: [projectGid],
      },
    }),
  });
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
  return asanaFetch(`/projects/${templateGid}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        name,
        team: teamGid,
        include: [
          'members', 'notes', 'task_notes', 'task_assignee', 'subtasks',
          'task_attachments', 'task_dates', 'task_dependencies',
          'task_followers', 'task_tags', 'task_projects',
        ],
        schedule_dates: {
          should_skip_weekends: false,
          start_on: startOn,
          due_on: dueOn,
        },
      },
    }),
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
 * Create a new portfolio.
 */
export async function createPortfolio(name, workspaceGid) {
  return asanaFetch('/portfolios', {
    method: 'POST',
    body: JSON.stringify({
      data: { name, workspace: workspaceGid, color: 'light-blue', public: false },
    }),
  });
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
