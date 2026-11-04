/**
 * setup-client-portfolios.js
 *
 * Crea y configura las carpetas de clientes en el portfolio "Clientes" de Asana.
 *
 * Uso: node setup-client-portfolios.js
 *
 * Fases:
 *   1. Corrige Nebula (sub-portfolio CSM + sus 4 proyectos + proyecto Tickets)
 *   2. Completa la carpeta Cofiño existente (agrega items que le faltan)
 *   3. Crea carpetas de prueba: Autoland (Tickets+CSM) y Tanner (ONB+Tickets)
 */

import 'dotenv/config'; // opcional si no usas dotenv

const TOKEN = process.env.ASANA_ACCESS_TOKEN;
if (!TOKEN) throw new Error('Falta ASANA_ACCESS_TOKEN en .env.local');
const BASE  = 'https://app.asana.com/api/1.0';
const WORKSPACE_GID       = '1176142409313345';
const CLIENTES_PORTFOLIO  = '1213481895234783'; // Portfolio principal "Clientes"

// ─── Custom field GIDs (mapeados desde Cofiño como modelo) ────────────────────
const F = {
  atom_id:          '1210444217947526',
  attio_company_id: '1213632895496591',
  url_attio:        '1214246840300235',
  ciclo_de_vida:    '1210562547163309',
};
const CICLO_CLIENTE = '1210562547163312'; // Opción "Cliente"

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function asana(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Asana ${method} ${path} → ${res.status}: ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

function clientFields(atom_id, attio_company_id) {
  return {
    [F.atom_id]:          atom_id,
    [F.attio_company_id]: attio_company_id,
    [F.url_attio]:        `https://app.attio.com/atomchat/company/${attio_company_id}/overview`,
    [F.ciclo_de_vida]:    CICLO_CLIENTE,
  };
}

async function addItemToPortfolio(portfolioGid, itemGid, label) {
  try {
    await asana(`/portfolios/${portfolioGid}/addItem`, {
      method: 'POST',
      body: { data: { item: itemGid } },
    });
    console.log(`    ✓ Agregado ${label} (${itemGid}) al portfolio ${portfolioGid}`);
  } catch (e) {
    if (e.message.includes('already')) console.log(`    ⚠ ${label} ya estaba en el portfolio`);
    else console.warn(`    ✗ addItem ${label}: ${e.message}`);
  }
}

async function updatePortfolioFields(gid, fields, label) {
  try {
    await asana(`/portfolios/${gid}`, {
      method: 'PUT',
      body: { data: { custom_fields: fields } },
    });
    console.log(`    ✓ Portfolio ${label} (${gid}) — campos actualizados`);
  } catch (e) {
    console.warn(`    ✗ Portfolio update ${label}: ${e.message}`);
  }
}

async function updateProjectFields(gid, fields, label) {
  try {
    await asana(`/projects/${gid}`, {
      method: 'PUT',
      body: { data: { custom_fields: fields } },
    });
    console.log(`    ✓ Proyecto "${label}" (${gid}) — campos actualizados`);
  } catch (e) {
    console.warn(`    ✗ Project update "${label}": ${e.message}`);
  }
}

async function createClientPortfolio(name) {
  const portfolio = await asana('/portfolios', {
    method: 'POST',
    body: { data: { name, workspace: WORKSPACE_GID, color: 'light-green', public: true } },
  });
  console.log(`    ✓ Portfolio creado: "${name}" → ${portfolio.gid}`);
  return portfolio;
}

// ─── FASE 1: Fix Nebula ───────────────────────────────────────────────────────

async function fixNebula() {
  console.log('\n══════════════════════════════════════════════');
  console.log('FASE 1: Fix Nebula');
  console.log('══════════════════════════════════════════════');

  const NEBULA_ATOM = 'DlYmWfuDf61v9TS6CVIN';
  const NEBULA_CO   = '87fac589-6517-4bd3-a3ea-6fe0cf73ab18';
  const fields = clientFields(NEBULA_ATOM, NEBULA_CO);

  // 1a. Fix sub-portfolio CSM de Nebula
  console.log('\n  Sub-portfolio CSM Nebula (1213352402292595):');
  await updatePortfolioFields('1213352402292595', fields, 'Nebula CSM');

  // 1b. Fix los 4 proyectos dentro del sub-portfolio
  console.log('\n  Proyectos dentro del sub-portfolio Nebula CSM:');
  const nebulaProjects = [
    { gid: '1213750685618556', name: 'Nebula - NPS Orbi' },
    { gid: '1209952231680689', name: 'Citas de Taller - Nebula Casa Toro' },
    { gid: '1213349376551248', name: 'Nebula - Renault CasaToro Marketing relacional 2026' },
    { gid: '1210644561755656', name: 'Nebula - Agents AI' },
  ];
  for (const p of nebulaProjects) {
    await updateProjectFields(p.gid, {
      [F.atom_id]:          NEBULA_ATOM,
      [F.attio_company_id]: NEBULA_CO,
    }, p.name);
  }

  // 1c. Fix proyecto Tickets de Nebula
  console.log('\n  Proyecto Tickets Nebula (1213352409798545):');
  await updateProjectFields('1213352409798545', {
    [F.atom_id]:          NEBULA_ATOM,
    [F.attio_company_id]: NEBULA_CO,
  }, 'NEBULA Tickets');
}

// ─── FASE 2: Completar carpeta Cofiño existente ───────────────────────────────

async function completeCofinoFolder() {
  console.log('\n══════════════════════════════════════════════');
  console.log('FASE 2: Completar carpeta Cofiño');
  console.log('══════════════════════════════════════════════');
  console.log('  Carpeta existente GID: 1213481895234786');
  console.log('  (campos ya correctos — solo faltan items)');

  const COFINO_FOLDER = '1213481895234786';

  // La carpeta ya tiene Atom ID, Attio Company ID, URL Attio, Ciclo de vida correctos.
  // Solo agregamos los proyectos que le faltan.
  console.log('\n  Agregando items:');
  await addItemToPortfolio(COFINO_FOLDER, '1213130467491078', 'Tickets — GRUPO COFIÑO');
  await addItemToPortfolio(COFINO_FOLDER, '1211517635124321', 'CSM portfolio — Grupo Cofiño');
}

// ─── FASE 3: Crear carpetas de prueba ─────────────────────────────────────────

async function createTestFolders() {
  console.log('\n══════════════════════════════════════════════');
  console.log('FASE 3: Carpetas de prueba');
  console.log('══════════════════════════════════════════════');

  const tests = [
    {
      name: 'Autoland',
      atom_id: 'pZkIqSNBd6FLSl4HEKfE',
      attio_company_id: '0ea3d0b3-3aca-484f-8d82-5a4f8d23113c',
      items: [
        { gid: '1213160483034993', label: 'Tickets — AUTOLAND' },
        { gid: '1210977880029631', label: 'CSM portfolio — Autoland' },
      ],
    },
    {
      name: 'Tanner',
      atom_id: 'L7yQgig4qrGDBvlQKCAZ',
      attio_company_id: '004e0932-e6db-4b77-b4b6-b837e2829537',
      items: [
        { gid: '1213073756823247', label: 'ONB — Tanner' },
        { gid: '1213982358421961', label: 'Tickets — TANNER BANCO DIGITAL' },
      ],
    },
  ];

  for (const client of tests) {
    console.log(`\n  ── ${client.name} ──`);

    // 1. Crear carpeta (sub-portfolio)
    let portfolio;
    try {
      portfolio = await createClientPortfolio(client.name);
    } catch (e) {
      console.warn(`    ✗ No se pudo crear el portfolio: ${e.message}`);
      continue;
    }

    // 2. Configurar custom fields
    await updatePortfolioFields(portfolio.gid, clientFields(client.atom_id, client.attio_company_id), client.name);

    // 3. Agregar items (proyectos/portfolios del cliente)
    console.log('    Items:');
    for (const item of client.items) {
      await addItemToPortfolio(portfolio.gid, item.gid, item.label);
    }

    // 4. Agregar la carpeta al portfolio principal "Clientes"
    await addItemToPortfolio(CLIENTES_PORTFOLIO, portfolio.gid, `carpeta "${client.name}" → Clientes`);

    console.log(`    → GID de la carpeta: ${portfolio.gid}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Iniciando setup de portfolios de clientes...\n');
  console.log('Custom field GIDs:');
  console.log('  Atom ID:          ', F.atom_id);
  console.log('  Attio Company ID: ', F.attio_company_id);
  console.log('  URL Attio:        ', F.url_attio);
  console.log('  Ciclo de vida:    ', F.ciclo_de_vida, '(opción Cliente:', CICLO_CLIENTE, ')');

  await fixNebula();
  await completeCofinoFolder();
  await createTestFolders();

  console.log('\n══════════════════════════════════════════════');
  console.log('Listo. Verifica en Asana:');
  console.log('  Clientes: https://app.asana.com/0/portfolio/1213481895234783/list');
  console.log('══════════════════════════════════════════════\n');
}

main().catch(console.error);
