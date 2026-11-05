/**
 * create-all-client-portfolios.js
 *
 * Crea las carpetas de cliente en el portfolio principal "Clientes".
 * Ejecutar: node create-all-client-portfolios.js
 *
 * Por cada cliente con Atom ID:
 *   1. Consulta Attio para obtener nombre de empresa y plan
 *   2. Crea sub-portfolio (carpeta) en "Clientes"
 *   3. Setea: Atom ID, Attio Company ID, URL Attio, Ciclo de vida, Plan contratado
 *   4. Agrega los proyectos de ONB, Tickets y/o CSM como ítems
 */

import fs from 'fs';

// ─── Tokens ───────────────────────────────────────────────────────────────────
const ASANA_TOKEN = process.env.ASANA_ACCESS_TOKEN;
const ATTIO_TOKEN = process.env.VITE_ATTIO_API_TOKEN || process.env.ATTIO_API_TOKEN || process.env.ATTIO_API_KEY;
if (!ASANA_TOKEN) throw new Error('Falta ASANA_ACCESS_TOKEN en .env.local');
if (!ATTIO_TOKEN) throw new Error('Falta ATTIO_API_KEY / ATTIO_API_TOKEN en .env.local');

// ─── GIDs ────────────────────────────────────────────────────────────────────
const WORKSPACE    = '1176142409313345';
const CLIENTES     = '1213481895234783'; // Portfolio "Clientes"
const CONCURRENCY  = 3;                  // Peticiones en paralelo por batch

const F = {
  atom_id:          '1210444217947526',
  attio_company_id: '1213632895496591',
  url_attio:        '1214246840300235',
  ciclo_de_vida:    '1210562547163309',
  plan_contratado:  '1212945918780798',
};
const CICLO_CLIENTE = '1210562547163312';
const PLAN_MAP = {
  'Team':         '1212945918780799',
  'Professional': '1212945918780800',
  'Enterprise':   '1212945918780801',
};

// Atom IDs de carpetas ya creadas — skip
const SKIP_ATOMS = new Set([
  'ufW4kEvg7GKMSMeSbDjX', // Cofiño
  'pZkIqSNBd6FLSl4HEKfE', // Autoland
  'L7yQgig4qrGDBvlQKCAZ', // Tanner
  'DlYmWfuDf61v9TS6CVIN', // Nebula
]);

// ─── Data files ───────────────────────────────────────────────────────────────
const TOOL_DIR = 'C:/Users/User/.claude/projects/c--Users-User--gemini-antigravity-playground-azure-ring-cpq-demo/bf995963-8d8c-42ec-9afa-70b10b5196d0/tool-results';
const ONB_FILE  = `${TOOL_DIR}/mcp-claude_ai_Asana-get_items_for_portfolio-1778012219313.txt`;
const TIX_FILE  = `${TOOL_DIR}/toolu_014AtbGkjQberj4auHtCcDuY.txt`;
const CSM_FILE  = `${TOOL_DIR}/mcp-claude_ai_Asana-get_items_for_portfolio-1778012220166.txt`;

// ─── Helpers: Asana ──────────────────────────────────────────────────────────
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

// ─── Helpers: Attio ──────────────────────────────────────────────────────────
const attioCache = {};
async function getAttioCompany(coId) {
  if (!coId) return null;
  if (attioCache[coId] !== undefined) return attioCache[coId];
  try {
    const res = await fetch(`https://api.attio.com/v2/objects/companies/records/${coId}`, {
      headers: { Authorization: `Bearer ${ATTIO_TOKEN}` },
    });
    if (!res.ok) { attioCache[coId] = null; return null; }
    const json = await res.json();
    const values = json.data?.values || {};
    const name = values.name?.[0]?.value || null;
    const planTitle = values.atom_plan?.[0]?.option?.title || null;
    const plan = PLAN_MAP[planTitle] || null;
    attioCache[coId] = { name, plan, planTitle };
    return attioCache[coId];
  } catch {
    attioCache[coId] = null;
    return null;
  }
}

// ─── Build client map from portfolio files ───────────────────────────────────
function cfVal(item, name) {
  const f = (item.custom_fields || []).find(f => f.name === name);
  return f ? (f.text_value || f.display_value || '').trim() || null : null;
}

function cleanName(raw) {
  return raw.replace(/\s*\([^)]{5,25}\)\s*$/, '').trim(); // strip (atomId) at end
}

function loadPortfolio(path, src) {
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  return (data.data || []).map(item => ({
    src,
    gid: item.gid,
    name: item.name || '',
    rtype: item.resource_type || 'project',
    atom: cfVal(item, 'Atom ID'),
    co: cfVal(item, 'Attio Company ID'),
  }));
}

function buildClientMap() {
  const onb = loadPortfolio(ONB_FILE, 'ONB');
  const tix = loadPortfolio(TIX_FILE, 'Tickets');
  const csm = loadPortfolio(CSM_FILE, 'CSM');

  const map = {};
  const srcOrder = { ONB: 0, Tickets: 1, CSM: 2 };

  for (const item of [...onb, ...tix, ...csm]) {
    if (!item.atom) continue;
    if (!map[item.atom]) {
      map[item.atom] = { atom: item.atom, co: null, rawName: item.name, items: [] };
    }
    const client = map[item.atom];
    // Prefer earlier-source name
    if (srcOrder[item.src] < srcOrder[map[item.atom].items[0]?.src ?? 'CSM']) {
      client.rawName = item.name;
    }
    if (!client.co && item.co) client.co = item.co;
    client.items.push({ gid: item.gid, src: item.src, rtype: item.rtype });
  }

  return map;
}

// ─── Create one client folder ────────────────────────────────────────────────
async function createClientFolder(atom, rawName, coId, items, attioData) {
  const folderName = attioData?.name || cleanName(rawName);

  // 1. Create portfolio
  const portfolio = await asana('/portfolios', {
    method: 'POST',
    body: { data: { name: folderName, workspace: WORKSPACE, color: 'light-green', public: true } },
  });
  const pGid = portfolio.gid;

  // 2. Add to Clientes (enables field inheritance)
  await asana(`/portfolios/${CLIENTES}/addItem`, {
    method: 'POST',
    body: { data: { item: pGid } },
  });

  // 3. Set custom fields
  const fields = {
    [F.atom_id]:          atom,
    [F.ciclo_de_vida]:    CICLO_CLIENTE,
  };
  if (coId) {
    fields[F.attio_company_id] = coId;
    fields[F.url_attio] = `https://app.attio.com/atomchat/company/${coId}/overview`;
  }
  if (attioData?.plan) {
    fields[F.plan_contratado] = attioData.plan;
  }

  await asana(`/portfolios/${pGid}`, {
    method: 'PUT',
    body: { data: { custom_fields: fields } },
  });

  // 4. Add project/portfolio items
  const addedItems = [];
  for (const item of items) {
    try {
      await asana(`/portfolios/${pGid}/addItem`, {
        method: 'POST',
        body: { data: { item: item.gid } },
      });
      addedItems.push(`${item.src}(${item.gid})`);
    } catch (e) {
      if (!e.message.includes('already')) {
        addedItems.push(`${item.src}(${item.gid})[err:${e.message.slice(0, 30)}]`);
      }
    }
  }

  return { pGid, folderName, addedItems, plan: attioData?.planTitle || null };
}

// ─── Batch processor ─────────────────────────────────────────────────────────
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── MAIN ─────────────────────────────────────────────────────────────────────
const clientMap = buildClientMap();
const all = Object.values(clientMap).filter(c => !SKIP_ATOMS.has(c.atom));

console.log(`Total clientes con Atom ID: ${Object.keys(clientMap).length}`);
console.log(`Ya creados (skip): ${SKIP_ATOMS.size}`);
console.log(`A crear: ${all.length}\n`);

// Pre-fetch Attio data for all clients with coId (batched to avoid overload)
console.log('Pre-fetching planes desde Attio...');
const uniqueCoIds = [...new Set(all.map(c => c.co).filter(Boolean))];
let attioFetched = 0;
for (const batchCoIds of chunk(uniqueCoIds, 10)) {
  await Promise.all(batchCoIds.map(id => getAttioCompany(id)));
  attioFetched += batchCoIds.length;
  process.stdout.write(`\r  Attio: ${attioFetched}/${uniqueCoIds.length}`);
  await delay(100);
}
console.log(`\n  Planes encontrados: ${Object.values(attioCache).filter(v => v?.plan).length}/${uniqueCoIds.length}\n`);

// Create portfolios in batches
let created = 0, errors = 0;
const log = [];

for (const batch of chunk(all, CONCURRENCY)) {
  const results = await Promise.allSettled(
    batch.map(async c => {
      const attioData = c.co ? attioCache[c.co] : null;
      const result = await createClientFolder(c.atom, c.rawName, c.co, c.items, attioData);
      return { atom: c.atom, rawName: c.rawName, ...result };
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const v = r.value;
      created++;
      const plan = v.plan ? ` | plan:${v.plan}` : '';
      console.log(`  ✓ [${created}/${all.length}] "${v.folderName}" → ${v.pGid} | items:[${v.addedItems.join(',')}]${plan}`);
      log.push({ status: 'ok', name: v.folderName, gid: v.pGid, atom: v.atom, plan: v.plan });
    } else {
      errors++;
      const atomName = batch[results.indexOf(r)]?.rawName || '?';
      console.log(`  ✗ "${atomName}": ${r.reason?.message?.slice(0, 80)}`);
      log.push({ status: 'error', name: atomName, error: r.reason?.message });
    }
  }

  await delay(200); // small pause between batches
}

// Save log
fs.writeFileSync('create-portfolios-log.json', JSON.stringify(log, null, 2));

console.log(`\n══════════════════════════════════`);
console.log(`Creados: ${created} | Errores: ${errors}`);
console.log(`Log guardado en create-portfolios-log.json`);
console.log(`Clientes: https://app.asana.com/0/portfolio/${CLIENTES}/list`);
