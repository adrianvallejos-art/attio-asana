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
  return asanaFetch(`/projects/${projectGid}/project_statuses?opt_fields=title,text,color,author,created_at&limit=${limit}`);
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
          { resource_type: 'project', action: 'changed' },
          { resource_type: 'task', action: 'changed' },
          { resource_type: 'task', action: 'added' },
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
