/**
 * update-portfolio-owners.js
 *
 * Asigna el owner a cada carpeta de cliente en Asana:
 *   - Si el cliente tiene proyectos ONB → owner = owner del proyecto ONB
 *   - Si no tiene ONB → busca propietario_csm en Attio por atom_id → mapea a Asana GID
 *
 * Ejecutar: node --env-file=.env.local update-portfolio-owners.js
 * Dry run:  node --env-file=.env.local update-portfolio-owners.js --dry-run
 */

import fs from 'fs';

const DRY_RUN = process.argv.includes('--dry-run');

const ASANA_TOKEN = process.env.ASANA_ACCESS_TOKEN;
const ATTIO_TOKEN = process.env.VITE_ATTIO_API_TOKEN || process.env.ATTIO_API_TOKEN || process.env.ATTIO_API_KEY;
if (!ASANA_TOKEN) throw new Error('Falta ASANA_ACCESS_TOKEN en .env.local');
if (!ATTIO_TOKEN) throw new Error('Falta ATTIO_API_KEY / ATTIO_API_TOKEN en .env.local');

const ONB_PORTFOLIO_GID = '1209745158203291';
const LOG_FILE = 'create-portfolios-log.json';
const CONCURRENCY = 5;

// ─── Attio email → Asana owner GID ───────────────────────────────────────────
const EMAIL_TO_ASANA = {
  'mariana.guzman@atomchat.io':        '1204602972500504',
  'esteban.urla@atomchat.io':          '1209696317018479',
  'carlos.macias@atomchat.io':         '1209673330260179',
  'elvis.ventocilla@atomchat.io':      '1210145836854490',
  'felix.morales@atomchat.io':         '1203091756184685',
  'carolina.sanfortunato@atomchat.io': '1209696453800561',
  'renata.blanco@atomchat.io':         '1212999280498569',
  'diego.pereda@atomchat.io':          '1211757602000299',
  'maria.pereira@atomchat.io':         '1211973339004111',
  'martin.portillo@atomchat.io':       '1200448220334225',
  'eholmann@atomchat.io':              '15298974574373',
  'vochoa@atomchat.io':                '1191256770503035',
  'leidy.zapata@atomchat.io':          '1212386013355465',
  'laura.devia@atomchat.io':           '1211360762748309',
  'dulce.rodriguez@atomchat.io':       '1207824112977859',
  'jesus.roque@atomchat.io':           '1209174137824462',
  'angie.agudelo@atomchat.io':         '1213961052579306',
  'wendy.gonzalez@atomchat.io':        '1204204881595637',
  'claudia.joya@atomchat.io':          '1205270423291979',
  'mario.subuyuj@atomchat.io':         '1212245548562482',
  'gabrielacid@atomchat.io':           '1209890049405172',
  'guadalupe.castagnoviz@atomchat.io': '1214152301304977',
};

// ─── Asana ────────────────────────────────────────────────────────────────────
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

async function fetchAllPortfolioItems(portfolioGid, optFields) {
  const items = [];
  let nextPage = null;
  do {
    const url = nextPage
      ? `https://app.asana.com/api/1.0${nextPage}`
      : `https://app.asana.com/api/1.0/portfolios/${portfolioGid}/items?opt_fields=${optFields}&limit=100`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ASANA_TOKEN}` } });
    const json = await res.json();
    if (!res.ok) break;
    items.push(...(json.data || []));
    nextPage = json.next_page?.path || null;
  } while (nextPage);
  return items;
}

// ─── Attio ────────────────────────────────────────────────────────────────────
async function findAttioOwnerByAtomId(atomId) {
  try {
    const res = await fetch('https://api.attio.com/v2/objects/companies/records/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ATTIO_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { atom_id: { $eq: atomId } }, limit: 1 }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const record = json.data?.[0];
    if (!record) return null;
    const values = record.values || {};
    const actorId = values.propietario_csm?.[0]?.referenced_actor_id || null;
    return actorId;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function cfVal(item, name) {
  const f = (item.custom_fields || []).find(f => f.name === name);
  return f ? (f.text_value || f.display_value || '').trim() || null : null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── MAIN ─────────────────────────────────────────────────────────────────────
console.log(`Modo: ${DRY_RUN ? 'DRY RUN' : 'REAL'}\n`);

// 1. Fetch all Attio workspace members → build actorId → email map
console.log('Cargando workspace members de Attio...');
const mr = await fetch('https://api.attio.com/v2/workspace_members', {
  headers: { Authorization: `Bearer ${ATTIO_TOKEN}` },
});
const mj = await mr.json();
const actorToEmail = {};
for (const m of mj.data || []) {
  const id = m.id?.workspace_member_id;
  if (id) actorToEmail[id] = m.email_address;
}
console.log(`  ${Object.keys(actorToEmail).length} members cargados\n`);

// 2. Fetch ONB portfolio items with owner
console.log('Fetcheando proyectos ONB con owners...');
const onbItems = await fetchAllPortfolioItems(
  ONB_PORTFOLIO_GID,
  'gid,name,owner.gid,owner.name,custom_fields.name,custom_fields.text_value,custom_fields.display_value'
);
console.log(`  ${onbItems.length} proyectos ONB\n`);

// Build atom → Asana owner GID from ONB
const atomToOwnerGid = {};
for (const item of onbItems) {
  const atom = cfVal(item, 'Atom ID');
  if (atom && item.owner?.gid) atomToOwnerGid[atom] = item.owner.gid;
}

// 3. Load client log
const clients = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))
  .filter(r => r.status === 'ok' && r.gid && r.atom);

console.log(`Clientes a procesar: ${clients.length}`);
const withOnb    = clients.filter(c => atomToOwnerGid[c.atom]);
const withoutOnb = clients.filter(c => !atomToOwnerGid[c.atom]);
console.log(`  Con ONB (owner directo): ${withOnb.length}`);
console.log(`  Sin ONB (lookup Attio):  ${withoutOnb.length}\n`);

// 4. Process all clients
let updated = 0, skipped = 0, errors = 0;
const results = [];

async function processClient(client) {
  let ownerGid = null;
  let source = null;

  if (atomToOwnerGid[client.atom]) {
    ownerGid = atomToOwnerGid[client.atom];
    source = 'ONB';
  } else {
    // Look up propietario_csm in Attio
    const actorId = await findAttioOwnerByAtomId(client.atom);
    if (actorId) {
      const email = actorToEmail[actorId];
      ownerGid = email ? EMAIL_TO_ASANA[email] : null;
      source = email ? `Attio CSM (${email})` : `Attio CSM (unmapped actor:${actorId})`;
    } else {
      source = 'Attio: no propietario_csm';
    }
  }

  if (!ownerGid) {
    return { name: client.name, atom: client.atom, status: 'no_owner', source };
  }

  if (!DRY_RUN) {
    await asana(`/portfolios/${client.gid}`, {
      method: 'PUT',
      body: { data: { owner: { gid: ownerGid } } },
    });
  }

  return { name: client.name, atom: client.atom, status: 'updated', ownerGid, source, dry: DRY_RUN };
}

for (const batch of chunk(clients, CONCURRENCY)) {
  const settled = await Promise.allSettled(batch.map(processClient));

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const r = s.status === 'fulfilled'
      ? s.value
      : { name: batch[i].name, atom: batch[i].atom, status: 'error', detail: s.reason?.message };

    results.push(r);

    if (r.status === 'updated') {
      updated++;
      console.log(`  ✓ "${r.name}" | owner:${r.ownerGid} | via ${r.source}${r.dry ? ' [DRY]' : ''}`);
    } else if (r.status === 'no_owner') {
      skipped++;
      console.log(`  ~ "${r.name}" | sin owner → ${r.source}`);
    } else {
      errors++;
      console.log(`  ✗ "${r.name}": ${r.detail?.slice(0, 80)}`);
    }
  }

  await delay(150);
}

fs.writeFileSync('update-owners-log.json', JSON.stringify(results, null, 2));

console.log(`\n══════════════════════════════════`);
console.log(`Actualizados: ${updated} | Sin owner: ${skipped} | Errores: ${errors}`);
console.log(`Log: update-owners-log.json`);
if (DRY_RUN) console.log('\n⚠  DRY RUN — nada fue escrito. Correr sin --dry-run para aplicar.');
