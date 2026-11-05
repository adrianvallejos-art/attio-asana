/**
 * portfolioReconcile.js
 *
 * Lógica de update-clientes-portfolio.js extraída a una función reusable —
 * antes solo corría como script de terminal (`node --env-file=.env.local
 * update-clientes-portfolio.js`). Ahora la llaman tanto ese mismo script
 * (wrapper delgado, mismo uso de siempre) como api/daily-portfolio-reconcile.js
 * (cron diario).
 *
 * Fases:
 *   0a. Escanea "Clientes Solicitudes" — crea carpeta en "Clientes" para proyectos sin una
 *   0b. Vincula proyectos de Solicitudes (tickets) y OB Customers (ONB) a carpetas existentes
 *   1.  Fetch todos los sub-portfolios de "Clientes" con sus campos — incluye
 *       un nivel más de sub-sub-portfolios ("ambientes" de una misma cuenta,
 *       ej. Ilumno → UDI/Areandina/etc., 1 sola suscripción con múltiples
 *       Atom ID/portafolios de Asana) para que también se les haga backfill/sync.
 *   2.  Backfill Atom ID desde Attio para portfolios que tienen Attio Company ID pero no Atom ID
 *   3.  Detectar duplicados por Atom ID → mover items al keeper, remover drop del padre
 *       (nunca mergea entre padre y sus propios hijos — ver nota en FASE 3)
 *   4.  Sync nombre desde Attio + campos faltantes (Plan, MRR, Industria, País, URL Attio, etc.)
 */

const CLIENTES_GID    = '1213481895234783';
const SOLICITUDES_GID = '1213027143201381';
const OB_CUSTOMERS_GID = '1209745158203291';
const WORKSPACE_GID   = '1176142409313345';

const GID = {
  atom_id:       '1210444217947526',
  attio_company: '1213632895496591',
  url_attio:     '1214246840300235',
  ciclo_de_vida: '1210562547163309',
  plan:          '1212945918780798',
  industria:     '1209758682431708',
  total_mrr:     '1214622504155723',
  pais:          '1209758683683903',
};

const CICLO_CLIENTE_GID = '1210562547163312';

const PLAN_MAP = {
  'team':         '1212945918780799',
  'professional': '1212945918780800',
  'enterprise':   '1212945918780801',
};

const INDUSTRIA_MAP = {
  'Automotive':                          '1209758682431710',
  'Education':                           '1209758682431709',
  'Primary/Secondary Education':         '1209758682431709',
  'Financial Services':                  '1209758682431711',
  'Insurance':                           '1209758682431711',
  'Servicios financieros':               '1209758682431711',
  'Retail':                              '1209758682431713',
  'Consumer Goods':                      '1209758682431713',
  'Sporting Goods':                      '1209758682431713',
  'Real Estate':                         '1209758682431712',
  'Health, Wellness and Fitness':        '1209758682431714',
  'Hospital & Health Care':              '1209758682431714',
  'Pharmaceuticals':                     '1209758682431714',
  'Cosmetics':                           '1209758682431714',
  'Information Technology and Services': '1210279392466247',
  'Entertainment':                       '1210279392466247',
  'Construction':                        '1210279392466247',
  'Mining & Metals':                     '1210279392466247',
  'Telecommunications':                  '1210279392466247',
  'Oil & Energy':                        '1210279392466247',
  'Food & Beverages':                    '1210279392466247',
  'Machinery':                           '1210279392466247',
  'Utilities':                           '1210279392466247',
  'Internet':                            '1210279392466247',
  'Transportation/Trucking/Railroad':    '1210279392466247',
  'Environmental Services':              '1210279392466247',
  'Graphic Design':                      '1210279392466247',
  'Services':                            '1210279392466247',
};

const COUNTRY_MAP = {
  'AR': '1209758683683904',
  'BO': '1209758683683905',
  'BR': '1211547799949368',
  'CL': '1209758683683906',
  'CO': '1209758683683907',
  'CR': '1209758683683908',
  'EC': '1209758683683909',
  'SV': '1209758683683910',
  'ES': '1209758683683911',
  'GT': '1209758683683912',
  'HN': '1209758683683913',
  'MX': '1209758683683914',
  'NI': '1209758683683915',
  'PA': '1209758683683916',
  'PY': '1210357909165044',
  'PE': '1209758683683917',
  'DO': '1209758683683918',
  'US': '1210562925996320',
  'PR': '1211761946953782',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function cfVal(item, fieldGid) {
  const f = (item.custom_fields || []).find(f => f.gid === fieldGid);
  return f ? (f.text_value || f.display_value || '').trim() || null : null;
}

function cfEnumGid(item, fieldGid) {
  const f = (item.custom_fields || []).find(f => f.gid === fieldGid);
  return f?.enum_value?.gid || null;
}

// Atom IDs son strings ~20 chars alfanuméricos. Descarta URLs, literales cortos, etc.
function isValidAtomId(val) {
  if (!val) return false;
  if (val.startsWith('http')) return false;
  if (val.length < 10) return false;
  if (/\s/.test(val)) return false;
  return true;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const CF_FIELDS = [
  'gid', 'name', 'resource_type',
  'custom_fields.gid', 'custom_fields.name', 'custom_fields.text_value',
  'custom_fields.display_value', 'custom_fields.enum_value',
].join(',');

/**
 * Ejecuta la reconciliación completa. Devuelve un resumen (nunca lanza por
 * errores puntuales de Asana/Attio en items individuales — esos quedan
 * loggeados y contados; sí relanza si faltan credenciales).
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun=false]
 * @param {string|null} [opts.filterAtomId=null]
 * @param {string|null} [opts.filterAttioId=null]
 * @param {(msg: string) => void} [opts.log=console.log]
 */
export async function runPortfolioReconcile({
  dryRun = false,
  filterAtomId = null,
  filterAttioId = null,
  log = console.log,
  // Corrida completa (~380+ carpetas) mide ~3min probado en local — muy por
  // encima del límite de 60s de una función serverless de Vercel (incluso el
  // máximo de 300s en plan Pro queda ajustado). En vez de asumir el plan,
  // cada fase respeta este presupuesto y corta temprano si se acerca al
  // límite — es seguro porque todo acá es incremental/idempotente: lo que no
  // alcanza a procesar hoy, lo agarra la corrida de mañana sin perder nada ni
  // dejar nada a medio escribir. El CLI (sin deadline) sigue corriendo completo.
  deadlineMs = null,
} = {}) {
  const ASANA_TOKEN = process.env.ASANA_ACCESS_TOKEN;
  const ATTIO_TOKEN = process.env.ATTIO_API_KEY || process.env.VITE_ATTIO_API_TOKEN || process.env.ATTIO_API_TOKEN;

  if (!ASANA_TOKEN) throw new Error('Falta ASANA_ACCESS_TOKEN');
  if (!ATTIO_TOKEN) throw new Error('Falta ATTIO_API_KEY / ATTIO_API_TOKEN');

  const hasFilter = !!(filterAtomId || filterAttioId);
  let deadlineHit = false;
  function outOfTime() {
    if (deadlineMs === null) return false;
    if (deadlineHit) return true;
    if (Date.now() >= deadlineMs) {
      deadlineHit = true;
      log('⏱  Presupuesto de tiempo agotado — se corta acá, el resto queda para la corrida de mañana.');
    }
    return deadlineHit;
  }

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

  async function asanaGetAll(path) {
    const items = [];
    let url = `https://app.asana.com/api/1.0${path}`;
    while (url) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${ASANA_TOKEN}` } });
      const json = await res.json();
      if (!res.ok) { log(`  Asana paginación error: ${json.errors?.[0]?.message}`); break; }
      items.push(...(json.data || []));
      url = json.next_page ? `https://app.asana.com/api/1.0${json.next_page.path}` : null;
    }
    return items;
  }

  function parseAttioValues(v) {
    return {
      name:      v.name?.[0]?.value || null,
      atom_id:   v.atom_id?.[0]?.value || null,
      plan:      v.atom_plan?.[0]?.option?.title?.toLowerCase() || null,
      mrr:       v.total_mrr?.[0]?.currency_value ?? null,
      industria: v.industria?.[0]?.option?.title || null,
      country:   v.primary_location?.[0]?.country_code || null,
    };
  }

  async function attioGetCompany(recordId) {
    const res = await fetch(`https://api.attio.com/v2/objects/companies/records/${recordId}`, {
      headers: { Authorization: `Bearer ${ATTIO_TOKEN}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const v = json?.data?.values || {};
    return { record_id: recordId, ...parseAttioValues(v) };
  }

  async function attioQueryByAtomId(atomId) {
    const res = await fetch('https://api.attio.com/v2/objects/companies/records/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ATTIO_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { atom_id: { '$eq': atomId } }, limit: 1 }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const record = json?.data?.[0];
    if (!record) return null;
    const recordId = record.id?.record_id || null;
    return { record_id: recordId, ...parseAttioValues(record.values || {}) };
  }

  // ── FASE 0: Crear carpetas faltantes desde Clientes Solicitudes ───────────────

  log(`Modo: ${dryRun ? 'DRY RUN' : 'REAL'}${hasFilter ? ` | Filtro: ${filterAtomId ? `atom-id=${filterAtomId}` : `attio-id=${filterAttioId}`}` : ''}`);
  log('══ FASE 0: Carpetas faltantes en Clientes (desde Solicitudes) ═══');

  const solItems  = await asanaGetAll(`/portfolios/${SOLICITUDES_GID}/items?opt_fields=${CF_FIELDS}&limit=100`);
  const solProjects = solItems
    .filter(i => i.resource_type === 'project')
    .map(p => ({
      gid:      p.gid,
      name:     p.name?.trim(),
      atom_id:  cfVal(p, GID.atom_id),
      attio_co: cfVal(p, GID.attio_company),
    }))
    .filter(p => isValidAtomId(p.atom_id));

  log(`   ${solItems.filter(i => i.resource_type === 'project').length} proyectos en Solicitudes (${solProjects.length} con Atom ID válido)`);

  const clientesRaw = await asanaGetAll(`/portfolios/${CLIENTES_GID}/items?opt_fields=${CF_FIELDS}&limit=100`);
  const clientesPfs = clientesRaw.filter(i => i.resource_type === 'portfolio');

  const carpetaByAtomId = {};
  for (const p of clientesPfs) {
    const atomId = cfVal(p, GID.atom_id);
    if (atomId) carpetaByAtomId[atomId] = p.gid;
  }

  const existingAtomIds = new Set(
    clientesPfs.map(p => cfVal(p, GID.atom_id)).filter(Boolean)
  );
  const existingNames = new Set(
    clientesPfs.map(p => p.name?.trim().toLowerCase()).filter(Boolean)
  );

  const pfWithoutAtomId = clientesPfs.filter(p => !cfVal(p, GID.atom_id));
  if (pfWithoutAtomId.length > 0 && !dryRun) {
    log(`   Backfilling Atom ID en ${pfWithoutAtomId.length} carpetas existentes sin él...`);
    const solByName = Object.fromEntries(solProjects.map(p => [p.name?.trim().toLowerCase(), p]));
    for (const batch of chunk(pfWithoutAtomId, 5)) {
      if (outOfTime()) break;
      await Promise.allSettled(batch.map(async p => {
        const sol = solByName[p.name?.trim().toLowerCase()];
        if (!sol?.atom_id) return;
        try {
          const initFields = { [GID.atom_id]: sol.atom_id, [GID.ciclo_de_vida]: CICLO_CLIENTE_GID };
          if (sol.attio_co) initFields[GID.attio_company] = sol.attio_co;
          await asana(`/portfolios/${p.gid}`, { method: 'PUT', body: { data: { custom_fields: initFields } } });
          existingAtomIds.add(sol.atom_id);
          carpetaByAtomId[sol.atom_id] = p.gid;
          log(`   ✓ Atom ID escrito en carpeta existente "${p.name}"`);
        } catch (e) { log(`   ⚠  Backfill "${p.name}": ${e.message.slice(0, 60)}`); }
      }));
      await delay(300);
    }
  }

  let toCreate = solProjects.filter(p =>
    !existingAtomIds.has(p.atom_id) &&
    !existingNames.has(p.name?.trim().toLowerCase())
  );

  if (filterAtomId)  toCreate = toCreate.filter(p => p.atom_id === filterAtomId);
  if (filterAttioId) toCreate = toCreate.filter(p => p.attio_co === filterAttioId);

  log(`   ${toCreate.length} proyectos sin carpeta en Clientes${hasFilter ? ' (filtrado)' : ''}`);

  let created = 0, createErrors = 0;

  for (const batch of chunk(toCreate, 3)) {
    if (outOfTime()) break;
    await Promise.allSettled(batch.map(async proj => {
      if (dryRun) {
        log(`  ✓  [DRY] Crear carpeta "${proj.name}" (atom: ${proj.atom_id})`);
        created++;
        return;
      }
      try {
        const newPf = await asana('/portfolios', {
          method: 'POST',
          body: { data: { name: proj.name, workspace: WORKSPACE_GID, color: 'light-green', public: true } },
        });
        await asana(`/portfolios/${newPf.gid}/addItem`, {
          method: 'POST',
          body: { data: { item: proj.gid } },
        });
        await asana(`/portfolios/${CLIENTES_GID}/addItem`, {
          method: 'POST',
          body: { data: { item: newPf.gid } },
        });
        const initFields = { [GID.atom_id]: proj.atom_id, [GID.ciclo_de_vida]: CICLO_CLIENTE_GID };
        if (proj.attio_co) initFields[GID.attio_company] = proj.attio_co;
        await asana(`/portfolios/${newPf.gid}`, {
          method: 'PUT',
          body: { data: { custom_fields: initFields } },
        });
        log(`  ✓  Carpeta "${proj.name}" creada (${newPf.gid})`);
        created++;
        carpetaByAtomId[proj.atom_id] = newPf.gid;
      } catch (e) {
        log(`  ✗  "${proj.name}": ${e.message.slice(0, 80)}`);
        createErrors++;
      }
    }));
    await delay(400);
  }

  log(`   Carpetas creadas: ${created}, errores: ${createErrors}`);

  // ── FASE 0b: Vincular proyectos de Solicitudes y ONB a carpetas ──────────────

  log('══ FASE 0b: Vincular proyectos a carpetas existentes ════════');

  const onbItems = await asanaGetAll(`/portfolios/${OB_CUSTOMERS_GID}/items?opt_fields=${CF_FIELDS}&limit=100`);
  const onbByAtomId = {};
  for (const p of onbItems.filter(i => i.resource_type === 'project')) {
    const atomId = cfVal(p, GID.atom_id);
    if (isValidAtomId(atomId)) onbByAtomId[atomId] = p.gid;
  }
  log(`   ${Object.keys(onbByAtomId).length} proyectos ONB indexados`);

  const solByAtomId2 = Object.fromEntries(solProjects.map(p => [p.atom_id, p.gid]));

  const toLink = [];
  for (const [atomId, carpetaGid] of Object.entries(carpetaByAtomId)) {
    if (filterAtomId && atomId !== filterAtomId) continue;
    if (solByAtomId2[atomId]) toLink.push({ carpetaGid, projGid: solByAtomId2[atomId], type: 'tickets' });
    if (onbByAtomId[atomId]) toLink.push({ carpetaGid, projGid: onbByAtomId[atomId], type: 'onb' });
  }
  log(`   ${toLink.length} pares (carpeta, proyecto) a vincular`);

  let linked = 0, alreadyLinked = 0, linkErrors = 0;

  for (const batch of chunk(toLink, 5)) {
    if (outOfTime()) break;
    await Promise.allSettled(batch.map(async ({ carpetaGid, projGid, type }) => {
      if (dryRun) { linked++; return; }
      try {
        await asana(`/portfolios/${carpetaGid}/addItem`, {
          method: 'POST', body: { data: { item: projGid } },
        });
        linked++;
      } catch (e) {
        if (e.message.toLowerCase().includes('already')) alreadyLinked++;
        else { log(`  ✗ vincular ${type}: ${e.message.slice(0, 60)}`); linkErrors++; }
      }
    }));
    await delay(300);
  }
  log(`   Vinculados: ${linked} nuevos | ${alreadyLinked} ya vinculados | ${linkErrors} errores`);

  // ── FASE 1: Fetch portfolios de Clientes (+ 1 nivel de sub-sub-portfolios) ───

  log('══ FASE 1: Cargando portfolios de Clientes ══════════════════');

  const rawItems = await asanaGetAll(`/portfolios/${CLIENTES_GID}/items?opt_fields=${CF_FIELDS}&limit=100`);
  const topPortfolios = rawItems.filter(i => i.resource_type === 'portfolio');

  // Caso "1 suscripción, múltiples ambientes" (ej. Ilumno: un solo cliente en
  // Attio/facturación, pero varios sub-portafolios de Asana — uno por
  // universidad/ambiente — cada uno con su propio Atom ID/Attio Company ID).
  // Esos hijos no cuelgan directo de "Clientes", cuelgan DENTRO del portafolio
  // padre del cliente — hay que bajar un nivel más para encontrarlos y que
  // también se les haga backfill/sync. Un padre que en sí mismo ya tiene Atom
  // ID propio (caso normal, sin ambientes) no necesita este paso.
  let nestedCount = 0;
  const nestedPortfolios = [];
  for (const batch of chunk(topPortfolios, 8)) {
    if (outOfTime()) break;
    await Promise.allSettled(batch.map(async (parent) => {
      try {
        const children = await asanaGetAll(`/portfolios/${parent.gid}/items?opt_fields=${CF_FIELDS}&limit=100`);
        const childPortfolios = children.filter(c => c.resource_type === 'portfolio');
        for (const child of childPortfolios) {
          nestedPortfolios.push(child);
          nestedCount++;
        }
      } catch (e) {
        log(`  ⚠ no se pudo listar hijos de "${parent.name}": ${e.message.slice(0, 60)}`);
      }
    }));
    await delay(150);
  }
  log(`   ${topPortfolios.length} sub-portfolios directos + ${nestedCount} sub-sub-portfolios (ambientes) encontrados`);

  // Dedupe por gid (un portfolio nested no debería aparecer dos veces, pero por las dudas)
  const seenGids = new Set();
  const portfolios = [...topPortfolios, ...nestedPortfolios].filter(p => {
    if (seenGids.has(p.gid)) return false;
    seenGids.add(p.gid);
    return true;
  });

  // Usado en FASE 3 para no mergear un ambiente anidado con su propio padre —
  // en la práctica un padre (ej. Ilumno) y uno de sus ambientes (ej.
  // "Universidad Piloto de Colombia | Ilumno") pueden terminar compartiendo el
  // mismo Atom ID (uno de los ambientes se identifica con el Atom ID "general"
  // de la cuenta), y eso NO es un duplicado a fusionar — es la estructura
  // 1 suscripción / N ambientes que queremos preservar.
  const topLevelGids = new Set(topPortfolios.map(p => p.gid));

  let pf = portfolios.map(p => ({
    gid:       p.gid,
    name:      p.name,
    atom_id:   cfVal(p, GID.atom_id),
    attio_co:  cfVal(p, GID.attio_company),
    url_attio: cfVal(p, GID.url_attio),
    ciclo:     cfEnumGid(p, GID.ciclo_de_vida),
    plan:      cfEnumGid(p, GID.plan),
    industria: cfEnumGid(p, GID.industria),
    mrr:       cfVal(p, GID.total_mrr),
    pais:      cfEnumGid(p, GID.pais),
  }));

  if (filterAtomId)  pf = pf.filter(p => p.atom_id === filterAtomId);
  if (filterAttioId) pf = pf.filter(p => p.attio_co === filterAttioId);
  if (hasFilter) log(`   (Filtrado a ${pf.length} portfolio/s)`);

  // ── FASE 2: Backfill Atom ID ──────────────────────────────────────────────────

  log('══ FASE 2: Backfill Atom ID (Attio Company ID sin Atom ID) ══');

  const needAtomId = pf.filter(p => p.attio_co && !p.atom_id);
  log(`   ${needAtomId.length} portfolios a procesar`);

  let atomBackfilled = 0, atomErrors = 0;

  for (const batch of chunk(needAtomId, 5)) {
    if (outOfTime()) break;
    await Promise.allSettled(batch.map(async p => {
      try {
        const attio = await attioGetCompany(p.attio_co);
        if (!attio?.atom_id) { log(`  –  "${p.name}": sin atom_id en Attio`); return; }
        p.atom_id = attio.atom_id;
        if (dryRun) { log(`  ✓  [DRY] "${p.name}": atom_id → ${attio.atom_id}`); atomBackfilled++; return; }
        await asana(`/portfolios/${p.gid}`, {
          method: 'PUT',
          body: { data: { custom_fields: { [GID.atom_id]: attio.atom_id } } },
        });
        log(`  ✓  "${p.name}": atom_id → ${attio.atom_id}`);
        atomBackfilled++;
      } catch (e) {
        log(`  ✗  "${p.name}": ${e.message.slice(0, 80)}`);
        atomErrors++;
      }
    }));
    await delay(300);
  }

  log(`   Backfill Atom ID: ${atomBackfilled} actualizados, ${atomErrors} errores`);

  // ── FASE 3: Merge duplicados ──────────────────────────────────────────────────
  // Agrupa por Atom ID exacto — pero SOLO entre portfolios de nivel top (hijos
  // directos de "Clientes"). Confirmado con datos reales (Ilumno): un ambiente
  // anidado puede compartir el Atom ID de su propio padre a propósito (caso
  // 1 suscripción/N ambientes) — si se incluyeran acá, esta fase los trataría
  // como duplicados y fusionaría/eliminaría el ambiente, rompiendo la
  // estructura. Los anidados nunca se mergean entre sí ni con su padre.

  if (!hasFilter) {
    log('══ FASE 3: Merge de duplicados (mismo Atom ID, solo nivel top) ══════════════');

    const byAtom = {};
    for (const p of pf) {
      if (!p.atom_id || !topLevelGids.has(p.gid)) continue;
      if (!byAtom[p.atom_id]) byAtom[p.atom_id] = [];
      byAtom[p.atom_id].push(p);
    }

    const duplicateGroups = Object.values(byAtom).filter(g => g.length > 1);
    log(`   ${duplicateGroups.length} grupos de duplicados detectados`);

    let mergesDone = 0, mergeErrors = 0;

    for (const group of duplicateGroups) {
      if (outOfTime()) break;
      const withAttio = group.filter(p => p.attio_co);
      const keeper = withAttio.length > 0
        ? withAttio.sort((a, b) => a.gid.localeCompare(b.gid))[0]
        : group.sort((a, b) => a.gid.localeCompare(b.gid))[0];
      const drops = group.filter(p => p.gid !== keeper.gid);

      log(`  "${keeper.name}" (${keeper.gid}) ← keeper`);
      for (const drop of drops) {
        log(`  "${drop.name}" (${drop.gid}) → a remover`);
        if (dryRun) {
          log(`    [DRY] Movería items de ${drop.gid} → ${keeper.gid} y removería de Clientes`);
          mergesDone++; continue;
        }
        try {
          const dropItems = await asanaGetAll(`/portfolios/${drop.gid}/items?opt_fields=gid,name,resource_type&limit=100`);
          for (const item of dropItems) {
            try {
              await asana(`/portfolios/${keeper.gid}/addItem`, { method: 'POST', body: { data: { item: item.gid } } });
              log(`    ✓ "${item.name}" movido a keeper`);
            } catch (e) {
              if (!e.message.includes('already')) log(`    ⚠ addItem ${item.gid}: ${e.message.slice(0, 60)}`);
            }
            await delay(100);
          }
          await asana(`/portfolios/${CLIENTES_GID}/removeItem`, { method: 'POST', body: { data: { item: drop.gid } } });
          log(`    ✓ "${drop.name}" removido de Clientes`);
          mergesDone++;
        } catch (e) {
          log(`    ✗ "${drop.name}": ${e.message.slice(0, 80)}`);
          mergeErrors++;
        }
        await delay(300);
      }
    }
    log(`   Merges: ${mergesDone} realizados, ${mergeErrors} errores`);
  } else {
    log('══ FASE 3: Merge de duplicados — omitida (filtro activo)');
  }

  // ── FASE 4: Sync campos desde Attio ──────────────────────────────────────────

  log('══ FASE 4: Sync nombre, responsable y campos desde Attio ════');

  const dropGids = hasFilter ? new Set() : new Set(
    Object.values((() => {
      const byAtom = {};
      for (const p of pf) { if (!p.atom_id || !topLevelGids.has(p.gid)) continue; if (!byAtom[p.atom_id]) byAtom[p.atom_id] = []; byAtom[p.atom_id].push(p); }
      return byAtom;
    })()).filter(g => g.length > 1).flatMap(group => {
      const withAttio = group.filter(p => p.attio_co);
      const keeper = withAttio.length > 0
        ? withAttio.sort((a, b) => a.gid.localeCompare(b.gid))[0]
        : group.sort((a, b) => a.gid.localeCompare(b.gid))[0];
      return group.filter(p => p.gid !== keeper.gid).map(p => p.gid);
    })
  );

  const toSync = pf.filter(p => (p.atom_id || p.attio_co) && !dropGids.has(p.gid));
  log(`   ${toSync.length} portfolios a sincronizar`);

  const noAttioCoId = toSync.filter(p => p.atom_id && !p.attio_co);
  log(`   ${noAttioCoId.length} sin Attio Company ID → consultando Attio por Atom ID...`);

  const attioCache = {};
  let fetchedByAtom = 0;

  for (const batch of chunk(noAttioCoId, 5)) {
    if (outOfTime()) break;
    await Promise.allSettled(batch.map(async p => {
      const result = await attioQueryByAtomId(p.atom_id);
      if (result?.record_id) {
        p.attio_co = result.record_id;
        p._attioCoNewlyDiscovered = true;
        attioCache[result.record_id] = result;
      }
      fetchedByAtom++;
    }));
    await delay(200);
  }
  log(`   ${Object.keys(attioCache).length} records encontrados por atom_id`);

  const toFetchById = [...new Set(toSync.filter(p => p.attio_co && !attioCache[p.attio_co]).map(p => p.attio_co))];
  let fetchedById = 0;

  for (const batch of chunk(toFetchById, 8)) {
    if (outOfTime()) break;
    await Promise.allSettled(batch.map(async coId => {
      attioCache[coId] = await attioGetCompany(coId);
      fetchedById++;
    }));
    await delay(150);
  }
  log(`   Total Attio records cargados: ${Object.keys(attioCache).length}`);

  let syncUpdated = 0, syncSkipped = 0, syncErrors = 0;

  for (const batch of chunk(toSync, 5)) {
    if (outOfTime()) break;
    await Promise.allSettled(batch.map(async p => {
      const attio = p.attio_co ? attioCache[p.attio_co] : null;
      if (!attio) { syncSkipped++; return; }

      const customFields = {};
      let changes = [];
      const putBody = {};

      // Los ambientes anidados nunca se renombran automático — el nombre
      // (ej. "UNIVERSIDAD DEL ISTMO (UDI) | ILUMNO") es intencional y más
      // específico que el de la cuenta de Attio que termina matcheando (puede
      // ser la empresa "general" de la suscripción, no ese ambiente puntual).
      if (topLevelGids.has(p.gid) && attio.name && attio.name.trim() !== p.name?.trim()) {
        putBody.name = attio.name.trim();
        changes.push(`nombre → "${attio.name.trim()}"`);
      }

      if (p._attioCoNewlyDiscovered && p.attio_co) {
        customFields[GID.attio_company] = p.attio_co;
        changes.push(`attio_company_id → ${p.attio_co}`);
      }
      if (!p.atom_id && attio.atom_id) {
        customFields[GID.atom_id] = attio.atom_id;
        changes.push(`atom_id → ${attio.atom_id}`);
      }
      if (!p.plan && attio.plan) {
        const planGid = PLAN_MAP[attio.plan];
        if (planGid) { customFields[GID.plan] = planGid; changes.push(`plan → ${attio.plan}`); }
      }
      if (!p.mrr && attio.mrr !== null) {
        customFields[GID.total_mrr] = attio.mrr;
        changes.push(`mrr → ${attio.mrr}`);
      }
      if (!p.industria && attio.industria) {
        const indGid = INDUSTRIA_MAP[attio.industria] || '1210279392466247';
        customFields[GID.industria] = indGid;
        changes.push(`industria → ${attio.industria}${INDUSTRIA_MAP[attio.industria] ? '' : ' (→Otros)'}`);
      }
      if (!p.pais && attio.country) {
        const paisGid = COUNTRY_MAP[attio.country];
        if (paisGid) { customFields[GID.pais] = paisGid; changes.push(`país → ${attio.country}`); }
      }
      if (!p.url_attio && p.attio_co) {
        customFields[GID.url_attio] = `https://app.attio.com/atomchat/company/${p.attio_co}/overview`;
        changes.push(`url_attio → seteado`);
      }
      if (!p.ciclo) {
        customFields[GID.ciclo_de_vida] = CICLO_CLIENTE_GID;
        changes.push(`ciclo → Cliente`);
      }
      if (Object.keys(customFields).length > 0) putBody.custom_fields = customFields;

      const hasCustomFields = !!putBody.custom_fields && Object.keys(putBody.custom_fields).length > 0;
      const hasNameChange   = !!putBody.name;

      if (!hasCustomFields && !hasNameChange) { syncSkipped++; return; }

      if (dryRun) {
        log(`  ✓  [DRY] "${p.name}": ${changes.join(' | ')}`);
        syncUpdated++;
        return;
      }

      let anySuccess = false;
      const errors = [];

      if (hasNameChange) {
        try {
          await asana(`/portfolios/${p.gid}`, {
            method: 'PUT',
            body: { data: { name: putBody.name } },
          });
          anySuccess = true;
        } catch (e) {
          if (e.message.includes('403')) {
            errors.push(`nombre (403-sin permiso)`);
            changes = changes.filter(c => !c.startsWith('nombre'));
          } else {
            errors.push(`nombre: ${e.message.slice(0, 50)}`);
          }
        }
      }

      if (hasCustomFields) {
        try {
          await asana(`/portfolios/${p.gid}`, {
            method: 'PUT',
            body: { data: { custom_fields: putBody.custom_fields } },
          });
          anySuccess = true;
        } catch (e) {
          errors.push(`campos: ${e.message.slice(0, 50)}`);
        }
      }

      if (anySuccess) {
        const errNote = errors.length ? `  ⚠ ${errors.join(', ')}` : '';
        log(`  ✓  "${p.name}": ${changes.join(' | ')}${errNote}`);
        syncUpdated++;
      } else if (errors.every(e => e.includes('403'))) {
        log(`  –  "${p.name}": rename manual requerido (403)`);
        syncSkipped++;
      } else {
        log(`  ✗  "${p.name}": ${errors.join(', ')}`);
        syncErrors++;
      }
    }));
    await delay(300);
  }

  const summary = {
    dryRun,
    foldersCreated: created, folderCreateErrors: createErrors,
    linked, alreadyLinked, linkErrors,
    nestedPortfoliosFound: nestedCount,
    atomBackfilled, atomErrors,
    syncUpdated, syncSkipped, syncErrors,
  };

  log('══ RESUMEN ═══════════════════════════════════════════════════');
  log(`Fase 0a— Carpetas creadas:     ${created}, errores: ${createErrors}`);
  log(`Fase 0b— Proyectos vinculados: ${linked} nuevos, ${alreadyLinked} ya vinculados, ${linkErrors} errores`);
  log(`Fase 1 — Ambientes anidados encontrados: ${nestedCount}`);
  log(`Fase 2 — Atom ID backfill:     ${atomBackfilled} actualizados, ${atomErrors} errores`);
  if (!hasFilter) log(`Fase 3 — Duplicados mergeados: (ver arriba)`);
  log(`Fase 4 — Campos sincronizados: ${syncUpdated} actualizados, ${syncSkipped} sin cambios, ${syncErrors} errores`);
  if (dryRun) log('⚠  DRY RUN — nada fue escrito en Asana.');

  return summary;
}
