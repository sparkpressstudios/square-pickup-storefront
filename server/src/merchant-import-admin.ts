import express from 'express';
import type { StaffPrincipal } from './admin-catalog';
import type { MerchantImportAdministration } from './merchant-import-service';
import { MerchantImportSetupError } from './merchant-import-service';
import { MerchantImportError } from './merchant-catalog-import';
import { SquareCatalogPreviewError } from './square-catalog-readonly';

function report(error: unknown, res: express.Response) {
  if (error instanceof MerchantImportError) {
    const status = error.code === 'STAGE_NOT_FOUND' ? 404 :
      ['IMPORT_CONFLICT','FINGERPRINT_MISMATCH','TARGET_UNVERIFIED'].includes(error.code) ? 409 : 400;
    res.status(status).json({ error: { code: error.code, message: 'Merchant import refused; review the staged batch and database ownership.' } }); return;
  }
  if (error instanceof MerchantImportSetupError || error instanceof SquareCatalogPreviewError) {
    res.status(503).json({ error: { code: error.code, message: 'Merchant import setup or Square sandbox verification is unavailable.' } }); return;
  }
  res.status(503).json({ error: { code: 'IMPORT_UNAVAILABLE', message: 'Unable to process this merchant import request.' } });
}
function isExact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const supplied = Object.keys(value);
  return supplied.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Only mounted behind the main admin route's trusted principal and CSRF/origin guards. */
export function merchantImportAdminRouter(service?: MerchantImportAdministration) {
  const router = express.Router();
  router.use((req, res, next) => {
    const principal = res.locals.staff as StaffPrincipal | undefined;
    if (!principal || principal.role !== 'admin') {
      res.status(403).json({ error: { code: 'ADMIN_REQUIRED', message: 'A verified administrator is required.' } }); return;
    }
    if (!service) {
      res.status(503).json({ error: { code: 'MERCHANT_IMPORT_DISABLED', message: 'A separate verified merchant database and import provider are required.' } }); return;
    }
    next();
  });
  router.get('/status', async (_req, res) => {
    try { res.json(await service!.status()); } catch (error) { report(error, res); }
  });
  router.get('/batches/:fingerprint', async (req, res) => {
    try { res.json(await service!.inspect(req.params.fingerprint as string)); } catch (error) { report(error, res); }
  });
  const json = [ (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: { code: 'INVALID_REQUEST', message: 'Send application/json.' } }); return;
    }
    next();
  }, express.json({ limit: '2kb', strict: true }) ];
  router.post('/stage', ...json, async (req, res) => {
    if (!isExact(req.body, ['inventoryOwner']) ||
        (req.body.inventoryOwner !== 'square' && req.body.inventoryOwner !== 'website')) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Select one inventory authority.' } }); return;
    }
    try { res.json(await service!.stage(req.body.inventoryOwner)); }
    catch (error) { report(error, res); }
  });
  router.post('/batches/:fingerprint/commit', ...json, async (req, res) => {
    if (!isExact(req.body, ['approval']) ||
        req.body.approval !== 'approve-disabled-merchant-import-v1') {
      res.status(400).json({ error: { code: 'REVIEW_REQUIRED', message: 'Review this fingerprint and confirm disabled import explicitly.' } }); return;
    }
    const principal = res.locals.staff as StaffPrincipal;
    try {
      res.json(await service!.commit(req.params.fingerprint as string,
        principal.id, 'approve-disabled-merchant-import-v1'));
    } catch (error) { report(error, res); }
  });
  return router;
}
