/**
 * Attio API helper — Onboarding Sync project
 *
 * Provides:
 *   - getAttioRecord(objectSlug, recordId)
 *   - patchAttioRecord(objectSlug, recordId, values)
 *   - createAttioNote(parentRecordId, parentObjectSlug, { title, content, format })
 */

const ATTIO_BASE = 'https://api.attio.com/v2';

function getToken() {
  const token = process.env.ATTIO_API_TOKEN;
  if (!token) throw new Error('[Attio] ATTIO_API_TOKEN not set');
  return token;
}

async function attioFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${ATTIO_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Attio ${options.method || 'GET'} ${path} failed (${res.status}): ${JSON.stringify(err.error || err)}`);
  }

  return res.json();
}

/**
 * GET a single record from any Attio object.
 */
export async function getAttioRecord(objectSlug, recordId) {
  return attioFetch(`/objects/${objectSlug}/records/${recordId}`);
}

/**
 * PATCH any Attio object record.
 */
export async function patchAttioRecord(objectSlug, recordId, values) {
  if (!recordId || !values || Object.keys(values).length === 0) return null;
  return attioFetch(`/objects/${objectSlug}/records/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { values } }),
  });
}

/**
 * List notes attached to an Attio record.
 * Returns the raw Attio response (data array).
 */
export async function getAttioNotes(parentRecordId, parentObjectSlug) {
  return attioFetch(`/notes?parent_object=${parentObjectSlug}&parent_record_id=${parentRecordId}&limit=50`);
}

/**
 * Delete a single note by its note ID.
 */
export async function deleteAttioNote(noteId) {
  const token = getToken();
  const res = await fetch(`${ATTIO_BASE}/notes/${noteId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Attio DELETE /notes/${noteId} failed (${res.status}): ${JSON.stringify(err.error || err)}`);
  }
  return true;
}

/**
 * Create a Note on an Attio record.
 *
 * @param {string} parentRecordId   — The Attio record ID to attach the note to
 * @param {string} parentObjectSlug — The object slug (e.g. 'onboarding')
 * @param {object} opts
 * @param {string} opts.title       — Note title
 * @param {string} opts.content     — Note body (plain text or HTML)
 * @param {string} [opts.format]    — 'plaintext' (default) or 'html'
 */
export async function createAttioNote(parentRecordId, parentObjectSlug, { title, content, format = 'plaintext' }) {
  return attioFetch('/notes', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        title,
        content,
        format,
        parent_object: parentObjectSlug,
        parent_record_id: parentRecordId,
      },
    }),
  });
}
