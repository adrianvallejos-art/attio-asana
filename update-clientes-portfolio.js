/**
 * update-clientes-portfolio.js
 *
 * Wrapper CLI delgado — la lógica real vive en lib/portfolioReconcile.js
 * (compartida con api/daily-portfolio-reconcile.js, que corre esto mismo
 * todos los días vía Vercel Cron). Uso sin cambios:
 *
 * Ejecutar:   node --env-file=.env.local update-clientes-portfolio.js
 * Dry run:    node --env-file=.env.local update-clientes-portfolio.js --dry-run
 * Filtrar:    ... --atom-id=XXX   (solo ese cliente por Atom ID)
 *             ... --attio-id=UUID (solo ese cliente por Attio Company ID)
 */

import { runPortfolioReconcile } from './lib/portfolioReconcile.js';

const dryRun       = process.argv.includes('--dry-run');
const filterAtomId  = process.argv.find(a => a.startsWith('--atom-id='))?.split('=')[1] || null;
const filterAttioId = process.argv.find(a => a.startsWith('--attio-id='))?.split('=')[1] || null;

await runPortfolioReconcile({ dryRun, filterAtomId, filterAttioId });
