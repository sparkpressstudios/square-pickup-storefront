import type {MerchantShippingBuyer} from './merchant-shipping-buyer';
import {shippingRehearsalRouter} from './merchant-shipping-router';
import type {ShippingCheckoutRehearsal} from './merchant-shipping-checkout';
import { createReleaseChecker } from './release-updates';
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type Request } from 'express';
import type { SqlDatabase } from '../../db/sql-database';
import { AdminError, applyProductEdit, parseProductEdit, type EditableProduct } from '../../shared/admin-catalog';
import { validateCatalog, type Catalog, type Product } from '../../shared/catalog';
import { readCatalog } from './durable-checkout';
import type { SandboxReconciliationQueue } from './reconciliation-jobs';
import { integrationAdminRouter } from './integration-admin';
import { merchantImportAdminRouter } from './merchant-import-admin';
import { squareServicesAdminRouter } from './square-services-admin';
import type { SquareServices } from './square-services';
import type { SquarePromotionService } from './square-promotion-preview';
import type { MerchantImportAdministration } from './merchant-import-service';
import { validWriteOrigin } from './origin';
import type { MerchantSettingsStore } from './merchant-settings';

export interface StaffPrincipal { id: string; role: 'admin' | 'manager' | 'staff'; csrfToken: string }
/** Implement with a verified server-side session. Never derive identity from role headers/body. */
export type StaffVerifier = (request: Request) => Promise<StaffPrincipal | null>;
export interface AdminCatalogStore {
  load(): Promise<Catalog>;
  update(id: string, input: unknown): Promise<EditableProduct>;
}
export function productRevision(product: Product): string {
  return createHash('sha256').update(JSON.stringify({ ...product, variants: [...product.variants].sort((a, b) => a.id.localeCompare(b.id)) })).digest('hex');
}
/** Same local synthetic database as checkout; no URL, credentials, or seed/import path. */
export class PostgresAdminCatalog implements AdminCatalogStore {
  constructor(private readonly db: SqlDatabase) {}
  load(): Promise<Catalog> { return this.db.transaction(async (tx) => { await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); return readCatalog(tx); }); }
  async update(id: string, input: unknown): Promise<EditableProduct> {
    const request = parseProductEdit(input);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM catalog_products WHERE id=$1 FOR UPDATE', [id]);
      await tx.query('SELECT id FROM catalog_variants WHERE product_id=$1 ORDER BY id FOR UPDATE', [id]);
      const catalog = await readCatalog(tx);
      const product = catalog.products.find((item) => item.id === id);
      if (!product) throw new AdminError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
      if (productRevision(product) !== request.revision) throw new AdminError(409, 'PRODUCT_CHANGED', 'Product or stock changed. Reload before saving again.');
      const updated = applyProductEdit(product, request);
      validateCatalog({ ...catalog, products: catalog.products.map((item) => item.id === id ? updated : item) });
      await tx.query('UPDATE catalog_products SET name=$2, description=$3, category=$4 WHERE id=$1', [id, updated.name, updated.description, updated.category]);
      for (const variant of updated.variants) {
        await tx.query('UPDATE catalog_variants SET price_minor=$2, stock_quantity=$3, enabled=$4 WHERE id=$1 AND product_id=$5', [variant.id, variant.priceMinor, variant.stockQuantity, variant.enabled, id]);
      }
      return { product: updated, revision: productRevision(updated) };
    });
  }
}
function sameToken(actual: string | undefined, expected: string): boolean {
  if (!actual || expected.length < 16 || expected.length > 256) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
/** Explicit allowlist guard adapted from source; no permissive role fallback or login provisioning. */
export function adminCatalogRouter(options: { shippingBuyer?:MerchantShippingBuyer; shippingRehearsal?:ShippingCheckoutRehearsal; paymentEnvironment?:'sandbox'|'production'; commerce?: express.Router; verifyStaff?: StaffVerifier; store?: AdminCatalogStore; settings?: MerchantSettingsStore; reconciliation?: SandboxReconciliationQueue; merchantImport?: MerchantImportAdministration; squareServices?: SquareServices; promotion?: SquarePromotionService; origin?: string; runtime?: { native?: boolean; sandbox?: boolean } } = {}) {
  const router = express.Router();
  const checkRelease = createReleaseChecker();
  router.use(async (req, res, next) => {
    const principal = options.verifyStaff ? await options.verifyStaff(req) : null;
    if (!principal || !principal.id || !['admin', 'manager', 'staff'].includes(principal.role)) {
      res.status(401).json({ error: { code: 'STAFF_AUTH_REQUIRED', message: 'Verified staff sign-in is not configured for this local demo.' } }); return;
    }
    if (!['admin', 'manager'].includes(principal.role)) {
      res.status(403).json({ error: { code: 'STAFF_FORBIDDEN', message: 'Catalog management requires an administrator or manager.' } }); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!validWriteOrigin(req, options.origin, true) || !sameToken(req.get('X-CSRF-Token'), principal.csrfToken)) {
        res.status(403).json({ error: { code: 'INVALID_CSRF', message: 'Use the staff session and same application origin.' } }); return;
      }
    }
    res.locals.staff = principal; next();
  });
  router.get('/updates', async (_req,res) => {
    res.set('Cache-Control','no-store');
    if ((res.locals.staff as StaffPrincipal).role !== 'admin') { res.status(403).json({error:{code:'ADMIN_REQUIRED'}}); return; }
    res.json(await checkRelease());
  });
  router.get('/session', (_req, res) => {
    const { id, role, csrfToken } = res.locals.staff as StaffPrincipal;
    res.json({ id, role, csrfToken, paymentEnvironment:options.paymentEnvironment, catalogEditing: Boolean(options.store), settingsEditing: role === 'admin' && Boolean(options.settings), merchantImportEnabled: role === 'admin' && Boolean(options.merchantImport), merchantCommerceEnabled: role === 'admin' && Boolean(options.commerce), squareServicesEnabled: role === 'admin' && Boolean(options.squareServices) });
  });
  if(options.commerce) router.use('/commerce', (_req,res,next)=>{if((res.locals.staff as StaffPrincipal).role!=='admin'){res.status(403).json({error:{code:'ADMIN_REQUIRED',message:'Administrator required.'}});return;}next();}, options.commerce);
  router.use('/shipping', shippingRehearsalRouter(options.shippingRehearsal,options.shippingBuyer));
  router.use('/integration', integrationAdminRouter(options.reconciliation, options.runtime));
  router.use('/merchant-import', merchantImportAdminRouter(options.merchantImport));
  router.use('/square-services', squareServicesAdminRouter(options.squareServices,options.promotion));
  router.use('/settings', (req, res, next) => {
    if (!options.settings) { res.status(503).json({ error: { code: 'SETTINGS_EDITING_DISABLED', message: 'Database-backed settings are not configured.' } }); return; }
    // Store-wide settings are administrator-only, including reads.
    if ((res.locals.staff as StaffPrincipal).role !== 'admin') { res.status(403).json({ error: { code: 'STAFF_FORBIDDEN', message: 'Store settings require an administrator.' } }); return; }
    next();
  });
  router.get('/settings', async (_req, res) => res.json(await options.settings!.load()));
  router.put('/settings', (req, res, next) => {
    if (!req.is('application/json')) { res.status(415).json({ error: { code: 'INVALID_REQUEST', message: 'Send application/json.' } }); return; }
    next();
  }, express.json({ limit: '8kb', strict: true }), async (req, res) => res.json(await options.settings!.update(req.body, (res.locals.staff as StaffPrincipal).id)));
  router.use((_req, res, next) => {
    if (!options.store) { res.status(503).json({ error: { code: 'CATALOG_EDITING_DISABLED', message: 'A local catalog editor has not been configured.' } }); return; }
    next();
  });
  router.get('/products', async (_req, res) => {
    const catalog = await options.store!.load();
    res.json({ currency: catalog.currency, products: catalog.products.map((product) => ({ product, revision: productRevision(product) })) });
  });
  router.put('/products/:productId', (req, res, next) => {
    if (!req.is('application/json')) { res.status(415).json({ error: { code: 'INVALID_REQUEST', message: 'Send application/json.' } }); return; }
    next();
  }, express.json({ limit: '32kb', strict: true }), async (req, res) => {
    res.json(await options.store!.update(req.params.productId as string, req.body));
  });
  return router;
}

