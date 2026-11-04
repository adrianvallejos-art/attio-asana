import { runPortfolioReconcile } from '../lib/portfolioReconcile.js';

/**
 * GET /api/daily-portfolio-reconcile
 *
 * Corre lo mismo que update-clientes-portfolio.js (antes solo "a demanda"
 * desde terminal) — crea carpetas de cliente faltantes, vincula proyectos,
 * hace backfill de Atom ID / Attio Company ID, mergea duplicados y sincroniza
 * nombre/plan/MRR/industria/país desde Attio. Ahora corre también todos los
 * días vía Vercel Cron (ver vercel.json).
 *
 * Es idempotente e incremental: una corrida completa mide ~3min probado en
 * local, muy por encima del límite de 60s de esta función — por eso cada
 * fase corta sola cuando se acerca el presupuesto de tiempo (ver DEADLINE_MS
 * abajo) y lo que falta queda para la corrida de mañana, sin corromper nada
 * ni dejar algo a medio escribir. En un backlog grande puede tardar varios
 * días en ponerse al día; después cada corrida diaria es rápida porque hay
 * poco que cambió desde la anterior.
 *
 * Query params (para correrlo manual desde el navegador/curl, ej. para
 * probar con --dry-run antes de confiar en el cron):
 *   ?dryRun=true        — no escribe nada, solo loguea qué haría
 *   ?atomId=XXX          — limita a un solo cliente por Atom ID
 *   ?attioId=UUID         — limita a un solo cliente por Attio Company ID
 *   ?full=true            — ignora el presupuesto de tiempo (corre completo;
 *                           solo para debugging manual, puede hacer timeout)
 */
export const config = { api: { bodyParser: false }, maxDuration: 60 };

// Deja margen bajo los 60s de maxDuration para la respuesta HTTP en sí.
const DEADLINE_BUDGET_MS = 50_000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const dryRun       = req.query?.dryRun === 'true';
  const filterAtomId  = req.query?.atomId || null;
  const filterAttioId = req.query?.attioId || null;
  const full          = req.query?.full === 'true';

  const logLines = [];
  const log = (msg) => { console.log(msg); logLines.push(String(msg)); };

  try {
    const deadlineMs = full ? null : Date.now() + DEADLINE_BUDGET_MS;
    const summary = await runPortfolioReconcile({ dryRun, filterAtomId, filterAttioId, log, deadlineMs });
    return res.status(200).json({ ok: true, summary, log: logLines });
  } catch (e) {
    console.error('[daily-portfolio-reconcile] fatal:', e);
    return res.status(500).json({ ok: false, error: e.message, log: logLines });
  }
}
