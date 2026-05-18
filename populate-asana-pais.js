/**
 * populate-asana-pais.js
 *
 * Script one-shot: puebla el campo "País" en cada portfolio de clientes en Asana
 * leyendo la ubicación primaria del company en Attio.
 *
 * Flujo:
 *   1. Fetch todos los portfolios (sub-carpetas) del portfolio "Clientes"
 *   2. Lee el Attio Company ID de cada portfolio
 *   3. Consulta Attio por ese record_id para obtener primary_location.country_name
 *   4. Mapea country_name → Asana enum GID del campo "País"
 *   5. PATCH el portfolio en Asana con el valor correspondiente
 *
 * Ejecutar:  node --env-file=.env.local populate-asana-pais.js
 * Dry run:   node --env-file=.env.local populate-asana-pais.js --dry-run
 */

const DRY_RUN     = process.argv.includes('--dry-run');
const ASANA_TOKEN = process.env.ASANA_ACCESS_TOKEN;
const ATTIO_TOKEN = process.env.ATTIO_API_KEY || process.env.VITE_ATTIO_API_TOKEN || process.env.ATTIO_API_TOKEN;

if (!ASANA_TOKEN) throw new Error('Falta ASANA_ACCESS_TOKEN en .env.local');
if (!ATTIO_TOKEN) throw new Error('Falta ATTIO_API_KEY / ATTIO_API_TOKEN en .env.local');

// ── Constantes ────────────────────────────────────────────────────────────────

const CLIENTES_GID          = '1213481895234783';
const ATTIO_COMPANY_ID_GID  = '1213632895496591';  // custom field en cada portfolio
const PAIS_FIELD_GID        = '1209758683683903';  // campo "País" en portfolio Clientes

// Attio primary_location.country_code (ISO 3166-1 alpha-2) → Asana enum option GID
// Países sin opción en Asana (CU, UY, VE, PT) quedan sin mapeo → campo vacío
const COUNTRY_MAP = {
  'AR': '1209758683683904',  // Argentina
  'BO': '1209758683683905',  // Bolivia
  'BR': '1211547799949368',  // Brasil
  'CL': '1209758683683906',  // Chile
  'CO': '1209758683683907',  // Colombia
  'CR': '1209758683683908',  // Costa Rica
  'EC': '1209758683683909',  // Ecuador
  'SV': '1209758683683910',  // El Salvador
  'ES': '1209758683683911',  // España
  'GT': '1209758683683912',  // Guatemala
  'HN': '1209758683683913',  // Honduras
  'MX': '1209758683683914',  // México
  'NI': '1209758683683915',  // Nicaragua
  'PA': '1209758683683916',  // Panamá
  'PY': '1210357909165044',  // Paraguay
  'PE': '1209758683683917',  // Perú
  'DO': '1209758683683918',  // Rep. Dominicana
  'US': '1210562925996320',  // Estados Unidos
  'PR': '1211761946953782',  // Puerto Rico
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function asana(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://app.asana.com/api/1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${ASANA_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Asana ${method} ${path}: ${res.status} ${json.errors?.[0]?.message}`);
  return json.data;
}

async function asanaGetAll(path) {
  const items = [];
  let url = `https://app.asana.com/api/1.0${path}`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ASANA_TOKEN}` } });
    const json = await res.json();
    if (!res.ok) { console.warn('  Asana error:', json.errors?.[0]?.message); break; }
    items.push(...(json.data || []));
    url = json.next_page ? `https://app.asana.com/api/1.0${json.next_page.path}` : null;
  }
  return items;
}

async function attioGetCompany(recordId) {
  const res = await fetch(`https://api.attio.com/v2/objects/companies/records/${recordId}`, {
    headers: { Authorization: `Bearer ${ATTIO_TOKEN}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const loc = json?.data?.values?.primary_location?.[0];
  return loc?.country_code ?? null;
}

function cfText(item, fieldGid) {
  const f = (item.custom_fields || []).find(f => f.gid === fieldGid);
  if (!f) return null;
  return (f.text_value || f.display_value || '').trim() || null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\nModo: ${DRY_RUN ? 'DRY RUN' : 'REAL'}\n`);

// 1. Fetch portfolios del portfolio "Clientes"
console.log('1. Cargando portfolios de clientes…');
const fields = 'gid,name,resource_type,custom_fields.gid,custom_fields.text_value,custom_fields.display_value';
const items = await asanaGetAll(`/portfolios/${CLIENTES_GID}/items?opt_fields=${fields}&limit=100`);
const portfolios = items.filter(i => i.resource_type === 'portfolio');
console.log(`   ${portfolios.length} portfolios encontrados`);

// 2. Extraer attio_company_id de cada portfolio
const toProcess = portfolios
  .map(p => ({ gid: p.gid, name: p.name, attioId: cfText(p, ATTIO_COMPANY_ID_GID) }))
  .filter(p => p.attioId);

console.log(`   ${toProcess.length} portfolios con Attio Company ID`);
console.log(`   ${portfolios.length - toProcess.length} portfolios sin Attio Company ID (se saltean)\n`);

// 3. Fetch países desde Attio y actualizar Asana
let updated = 0, skippedNoCountry = 0, skippedNoMap = 0, errors = 0;
const noMapCountries = new Set();

for (const batch of chunk(toProcess, 5)) {
  await Promise.allSettled(batch.map(async ({ gid, name, attioId }) => {
    try {
      // Obtener país desde Attio
      const countryName = await attioGetCompany(attioId);

      if (!countryName) {
        console.log(`  ⚠  ${name}: sin primary_location en Attio`);
        skippedNoCountry++;
        return;
      }

      const enumGid = COUNTRY_MAP[countryName];
      if (!enumGid) {
        noMapCountries.add(countryName);
        console.log(`  –  ${name}: "${countryName}" sin mapeo en Asana`);
        skippedNoMap++;
        return;
      }

      if (DRY_RUN) {
        console.log(`  ✓  [DRY] ${name}: ${countryName} → ${enumGid}`);
        updated++;
        return;
      }

      // PATCH portfolio en Asana
      await asana(`/portfolios/${gid}`, {
        method: 'PUT',
        body: { data: { custom_fields: { [PAIS_FIELD_GID]: enumGid } } },
      });

      console.log(`  ✓  ${name}: ${countryName}`);
      updated++;
    } catch (err) {
      console.log(`  ✗  ${name}: ${err.message}`);
      errors++;
    }
  }));
  await delay(300);
}

// ── Resumen ───────────────────────────────────────────────────────────────────

console.log('\n─────────────────────────────────────────────────');
console.log(`✓ Actualizados:   ${updated}`);
console.log(`– Sin country:    ${skippedNoCountry}`);
console.log(`– Sin mapeo:      ${skippedNoMap}${noMapCountries.size ? ` (${[...noMapCountries].join(', ')})` : ''}`);
console.log(`✗ Errores:        ${errors}`);
if (DRY_RUN) console.log('\n⚠  DRY RUN — nada fue escrito en Asana.');
