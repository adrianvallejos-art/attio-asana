import { updateProjectCustomFields } from './_asanaHelper.js';
import { queryAttioRecords } from './_attioHelper.js';

const PORTFOLIO_GID = '1213027143201381'; // Clientes Solicitudes
const OPT_FIELDS =
  'name,gid,custom_fields.name,custom_fields.gid,custom_fields.text_value,custom_fields.display_value';

/**
 * POST /api/backfill-atom-ids
 *
 * Backfill de una sola vez para proyectos del portfolio "Clientes Solicitudes":
 *   1. Extrae el Atom ID del nombre del proyecto (entre paréntesis)
 *   2. Escribe el Atom ID en el campo custom "Atom ID" de Asana (si está vacío)
 *   3. Busca en Attio la Company con ese Atom ID
 *   4. Si la encuentra, escribe el Attio Company ID en el campo custom de Asana
 *   5. Si no la encuentra, deja el campo vacío y lo reporta
 *
 * Parámetros opcionales (body JSON):
 *   force — boolean: si true, sobreescribe campos aunque ya tengan valor
 *   dry_run — boolean: si true, solo muestra qué haría sin escribir nada
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'ASANA_ACCESS_TOKEN not set' });

  const { force = false, dry_run = false } = req.body || {};

  const projects = await fetchPortfolioProjects(token, PORTFOLIO_GID);

  const summary = {
    total: projects.length,
    no_atom_in_name: 0,
    already_filled: 0,
    atom_id_written: 0,
    company_found: 0,
    company_not_found: 0,
    errors: 0,
    detail: [],
  };

  for (const project of projects) {
    const cf = project.custom_fields || [];

    // Extract Atom ID from name: "Company (AtomID)" → "AtomID"
    const nameMatch = project.name?.match(/\(([^)]+)\)\s*$/);
    const atomIdFromName = nameMatch ? nameMatch[1].trim() : null;

    if (!atomIdFromName) {
      summary.no_atom_in_name++;
      continue;
    }

    const atomIdField = cf.find((f) => f.name === 'Atom ID');
    const attioCompanyField = cf.find((f) => f.name === 'Attio Company ID');

    if (!atomIdField?.gid) {
      summary.errors++;
      summary.detail.push({ project: project.name, status: 'error', reason: 'Campo "Atom ID" no encontrado en el proyecto' });
      continue;
    }

    const currentAtomId = atomIdField.text_value || atomIdField.display_value || null;
    const currentCompanyId = attioCompanyField?.text_value || attioCompanyField?.display_value || null;

    if (currentAtomId && !force) {
      summary.already_filled++;
      continue;
    }

    const row = { project: project.name, gid: project.gid, atom_id: atomIdFromName, company_found: false };

    // ── 1. Write Atom ID to Asana ─────────────────────────────────
    if (!dry_run) {
      try {
        await updateProjectCustomFields(project.gid, { [atomIdField.gid]: atomIdFromName });
        summary.atom_id_written++;
      } catch (e) {
        summary.errors++;
        summary.detail.push({ ...row, status: 'error', reason: `Asana PATCH atom_id: ${e.message}` });
        continue;
      }
    } else {
      summary.atom_id_written++;
    }

    // ── 2. Search Attio Company by atom_id ───────────────────────
    try {
      const records = await queryAttioRecords('companies', {
        slug: 'atom_id',
        value: atomIdFromName,
      });

      if (records.length > 0) {
        const companyRecordId = records[0].id?.record_id;
        row.company_found = true;
        row.attio_company_id = companyRecordId;
        summary.company_found++;

        // Write Attio Company ID to Asana (only if field exists and not already set or force)
        if (companyRecordId && attioCompanyField?.gid && (!currentCompanyId || force) && !dry_run) {
          await updateProjectCustomFields(project.gid, {
            [attioCompanyField.gid]: companyRecordId,
          }).catch((e) => {
            row.warning = `Company ID escrito pero Asana PATCH falló: ${e.message}`;
          });
        }
      } else {
        summary.company_not_found++;
        row.company_found = false;
      }
    } catch (e) {
      summary.errors++;
      row.company_found = false;
      row.attio_error = e.message;
    }

    row.status = row.company_found ? 'ok' : 'no_company';
    summary.detail.push(row);
  }

  return res.status(200).json({
    success: true,
    dry_run,
    force,
    ...summary,
    no_company_projects: summary.detail.filter((r) => r.status === 'no_company').map((r) => r.project),
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
