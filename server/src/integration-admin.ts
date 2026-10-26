import express from 'express';
import { integrationStatus } from '../../shared/integration';
import type { StaffPrincipal } from './admin-catalog';
import type { SandboxReconciliationQueue } from './reconciliation-jobs';

/** Mounted only behind the existing verified role and same-origin CSRF guards. */
export function integrationAdminRouter(queue?: SandboxReconciliationQueue, runtime?: { native?: boolean; sandbox?: boolean }) {
  const router = express.Router();
  router.get('/', async (_req, res) => res.json(integrationStatus(queue ? await queue.summary() : null, runtime)));
  router.post('/jobs/:id/retry', async (req, res) => {
    if ((res.locals.staff as StaffPrincipal).role !== 'admin') { res.status(403).json({ error: { code: 'ADMIN_REQUIRED', message: 'Only an administrator can requeue a reconciliation job.' } }); return; }
    if (!queue) { res.status(503).json({ error: { code: 'RECONCILIATION_DISABLED', message: 'Local durable reconciliation storage is not configured.' } }); return; }
    await queue.retry(req.params.id as string); res.json({ requeued: true, workerEnabled: false });
  });
  return router;
}
