import { getAttioNotes, deleteAttioNote } from './_attioHelper.js';

const ONBOARDING_SLUG = process.env.ATTIO_ONBOARDING_SLUG || 'onboardings';

/**
 * GET  /api/attio-notes?attio_record_id=xxx  — list notes for a record
 * DELETE /api/attio-notes                     — body: { note_id }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── LIST notes ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { attio_record_id } = req.query;
    if (!attio_record_id) return res.status(400).json({ error: 'attio_record_id required' });

    try {
      const data = await getAttioNotes(attio_record_id, ONBOARDING_SLUG);
      const notes = (data.data || []).map((n) => ({
        id: n.id?.note_id,
        title: n.title,
        content: n.content,
        created_at: n.created_at,
      }));
      return res.status(200).json({ notes });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE note ─────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { note_id } = req.body || {};
    if (!note_id) return res.status(400).json({ error: 'note_id required' });

    try {
      await deleteAttioNote(note_id);
      return res.status(200).json({ success: true, deleted: note_id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
