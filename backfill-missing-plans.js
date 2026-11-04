/**
 * backfill-missing-plans.js
 *
 * Para las carpetas de clientes sin Plan contratado:
 *   1. Busca la compañía en Attio por Atom ID (filter API)
 *   2. Actualiza la carpeta de Asana con Attio Company ID, URL Attio y Plan contratado
 *
 * Ejecutar: node --env-file=.env.local backfill-missing-plans.js
 * Dry run:  node --env-file=.env.local backfill-missing-plans.js --dry-run
 */

import fs from 'fs';

const DRY_RUN = process.argv.includes('--dry-run');

const ASANA_TOKEN = process.env.ASANA_ACCESS_TOKEN;
const ATTIO_TOKEN = process.env.VITE_ATTIO_API_TOKEN || process.env.ATTIO_API_TOKEN || process.env.ATTIO_API_KEY;
if (!ASANA_TOKEN) throw new Error('Falta ASANA_ACCESS_TOKEN en .env.local');
if (!ATTIO_TOKEN) throw new Error('Falta ATTIO_API_KEY / ATTIO_API_TOKEN en .env.local');

const LOG_FILE = 'create-portfolios-log.json';

const F = {
  attio_company_id: '1213632895496591',
  url_attio:        '1214246840300235',
  plan_contratado:  '1212945918780798',
};

const PLAN_MAP = {
  'Team':         '1212945918780799',
  'Professional': '1212945918780800',
  'Enterprise':   '1212945918780801',
};

const CONCURRENCY = 3;

// ─── Asana ───────────────────────────────────────────────────────────────────
async function asana(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://app.asana.com/api/1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${ASANA_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${json.errors?.[0]?.message || JSON.stringify(json)}`);
  return json.data;
}

// ─── Attio: buscar compañía por Atom ID ──────────────────────────────────────
async function findAttioCompanyByAtomId(atomId) {
  try {
    const res = await fetch('https://api.attio.com/v2/objects/companies/records/query', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ATTIO_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          atom_id: { $eq: atomId },
        },
        limit: 1,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Attio query ${res.status}: ${err.slice(0, 120)}`);
    }

    const json = await res.json();
    const record = json.data?.[0];
    if (!record) return { notFound: true };

    const values = record.values || {};
    const coId   = record.id?.record_id || null;
    const name   = values.name?.[0]?.value || null;
    const planTitle = values.atom_plan?.[0]?.option?.title || null;
    const plan   = PLAN_MAP[planTitle] || null;

    return { coId, name, planTitle, plan };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Batch helpers ────────────────────────────────────────────────────────────
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── MAIN ─────────────────────────────────────────────────────────────────────
const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));

// Solo los que no tienen plan y tienen gid
const targets = log.filter(r => r.status === 'ok' && !r.plan && r.gid && r.atom);

console.log(`Carpetas sin plan: ${targets.length}`);
console.log(`Modo: ${DRY_RUN ? 'DRY RUN (no escribe)' : 'REAL'}\n`);

let updated = 0, notFound = 0, noPlan = 0, errors = 0;
const results = [];

for (const batch of chunk(targets, CONCURRENCY)) {
  const settled = await Promise.allSettled(
    batch.map(async entry => {
      const attio = await findAttioCompanyByAtomId(entry.atom);

      if (attio?.notFound) {
        return { name: entry.name, atom: entry.atom, status: 'not_found' };
      }
      if (!attio || attio.error) {
        return { name: entry.name, atom: entry.atom, status: 'attio_error', detail: attio?.error };
      }
      if (!attio.coId) {
        return { name: entry.name, atom: entry.atom, status: 'not_found' };
      }
      if (!attio.plan) {
        return { name: entry.name, atom: entry.atom, status: 'no_plan', coId: attio.coId, planTitle: attio.planTitle };
      }

      const fields = {
        [F.attio_company_id]: attio.coId,
        [F.url_attio]:        `https://app.attio.com/atomchat/company/${attio.coId}/overview`,
        [F.plan_contratado]:  attio.plan,
      };

      if (!DRY_RUN) {
        await asana(`/portfolios/${entry.gid}`, {
          method: 'PUT',
          body: { data: { custom_fields: fields } },
        });
      }

      return {
        name: entry.name,
        atom: entry.atom,
        status: 'updated',
        coId: attio.coId,
        plan: attio.planTitle,
        dry: DRY_RUN,
      };
    })
  );

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const r = s.status === 'fulfilled'
      ? s.value
      : { name: batch[i].name, atom: batch[i].atom, status: 'error', detail: s.reason?.message };

    results.push(r);

    if (r.status === 'updated')     { updated++;  console.log(`  ✓ "${r.name}" → co:${r.coId} | plan:${r.plan}${r.dry ? ' [DRY]' : ''}`); }
    else if (r.status === 'not_found') { notFound++; console.log(`  ? "${r.name}" | atom:${r.atom} → no encontrado en Attio`); }
    else if (r.status === 'no_plan')   { noPlan++;   console.log(`  ~ "${r.name}" | co:${r.coId} | sin atom_plan en Attio`); }
    else                               { errors++;   console.log(`  ✗ "${r.name}": ${r.detail?.slice(0, 80)}`); }
  }

  await delay(200);
}

fs.writeFileSync('backfill-plans-log.json', JSON.stringify(results, null, 2));

console.log(`\n══════════════════════════════════`);
console.log(`Actualizados: ${updated} | No encontrados: ${notFound} | Sin plan en Attio: ${noPlan} | Errores: ${errors}`);
console.log(`Log: backfill-plans-log.json`);
if (DRY_RUN) console.log('\n⚠  DRY RUN — nada fue escrito en Asana. Correr sin --dry-run para aplicar.');
