import { updateProjectCustomFields } from './_asanaHelper.js';
import { queryAttioRecords } from './_attioHelper.js';

const PORTFOLIO_GID = '1213027143201381'; // Clientes Solicitudes
const OPT_FIELDS =
  'name,gid,custom_fields.name,custom_fields.gid,custom_fields.text_value,custom_fields.display_value';
const CONCURRENCY = 10; // Attio queries en paralelo

/**
 * POST /api/backfill-atom-ids
 *
 * Parámetros opcionales (body JSON):
 *   force   — sobreescribe campos aunque ya tengan valor
 *   dry_run — muestra qué haría sin escribir nada
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'ASANA_ACCESS_TOKEN not set' });

  const { force = false, dry_run = false, offset = 0, limit = 20 } = req.body || {};

  const projects = await fetchPortfolioProjects(token, PORTFOLIO_GID);

  // ── Pre-filter: solo proyectos con Atom ID en el nombre y campo vacío ──
  // Paginate candidates (offset/limit apply after pre-filtering)
  const allCandidates = [];
  const candidates = [];
  let no_atom_in_name = 0;
  let already_filled = 0;

  for (const project of projects) {
    const cf = project.custom_fields || [];
    const nameMatch = project.name?.match(/\(([^)]+)\)\s*$/);
    const atomIdFromName = nameMatch ? nameMatch[1].trim() : null;

    if (!atomIdFromName) { no_atom_in_name++; continue; }

    const atomIdField     = cf.find((f) => f.name === 'Atom ID');
    const attioCompanyField = cf.find((f) => f.name === 'Attio Company ID');
    const currentAtomId   = atomIdField?.text_value || atomIdField?.display_value || null;

    if (currentAtomId && !force) { already_filled++; continue; }
    if (!atomIdField?.gid) continue;

    allCandidates.push({ project, atomIdFromName, atomIdField, attioCompanyField,
                      currentCompanyId: attioCompanyField?.text_value || attioCompanyField?.display_value || null });
  }

  // Apply pagination to candidates
  candidates.push(...allCandidates.slice(offset, offset + limit));

  // ── Process candidates in parallel batches ────────────────────────
  const detail = [];
  let atom_id_written = 0, company_found = 0, company_not_found = 0, errors = 0;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);

    const results = await Promise.all(batch.map(async ({ project, atomIdFromName, atomIdField, attioCompanyField, currentCompanyId }) => {
      const row = { project: project.name, gid: project.gid, atom_id: atomIdFromName, company_found: false, status: 'no_company' };

      // 1. Write Atom ID to Asana
      if (!dry_run) {
        try {
          await updateProjectCustomFields(project.gid, { [atomIdField.gid]: atomIdFromName });
        } catch (e) {
          return { ...row, status: 'error', reason: `Asana PATCH atom_id: ${e.message}` };
        }
      }

      // 2. Query Attio Company by atom_id
      try {
        const records = await queryAttioRecords('companies', { slug: 'atom_id', value: atomIdFromName });

        if (records.length > 0) {
          const companyRecordId = records[0].id?.record_id;
          row.company_found = true;
          row.attio_company_id = companyRecordId;
          row.status = 'ok';

          if (companyRecordId && attioCompanyField?.gid && (!currentCompanyId || force) && !dry_run) {
            await updateProjectCustomFields(project.gid, { [attioCompanyField.gid]: companyRecordId })
              .catch((e) => { row.warning = `Asana PATCH company_id falló: ${e.message}`; });
          }
        }
      } catch (e) {
        row.attio_error = e.message;
        row.status = 'no_company';
      }

      return row;
    }));

    for (const r of results) {
      detail.push(r);
      if (r.status === 'error') errors++;
      else if (r.company_found) { atom_id_written++; company_found++; }
      else { atom_id_written++; company_not_found++; }
    }
  }

  const totalCandidates = allCandidates.length;
  const hasMore = offset + limit < totalCandidates;

  return res.status(200).json({
    success: true,
    dry_run,
    force,
    total: projects.length,
    total_candidates: totalCandidates,
    offset,
    limit,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
    no_atom_in_name,
    already_filled,
    atom_id_written,
    company_found,
    company_not_found,
    errors,
    no_company_projects: detail.filter((r) => r.status === 'no_company').map((r) => r.project),
    detail,
  });
}

async function fetchPortfolioProjects(token, portfolioGid) {
  const projects = [];
  let nextPage = null;
  do {
    const url = nextPage
      ? `https://app.asana.com/api/1.0${nextPage}`
      : `https://app.asana.com/api/1.0/portfolios/${portfolioGid}/items?opt_fields=${OPT_FIELDS}&limit=100`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) break;
    const json = await r.json();
    projects.push(...(json.data || []));
    nextPage = json.next_page?.path || null;
  } while (nextPage);
  return projects;
}
