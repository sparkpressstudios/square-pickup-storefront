import express, { type ErrorRequestHandler } from 'express';
import { merchant } from '../../config/merchant';
import { validateCatalog } from '../../shared/catalog';
import type { Storefront } from '../../shared/storefront';
import { demoRepository, type CatalogRepository } from './catalog-repository';
import { DemoCheckoutService } from './demo-checkout';
import { CheckoutError } from '../../shared/checkout';
import type { CheckoutBackend } from './checkout-backend';
import { adminCatalogRouter, type AdminCatalogStore, type StaffVerifier } from './admin-catalog';
import { AdminError } from '../../shared/admin-catalog';
import type { SandboxReconciliationQueue } from './reconciliation-jobs';
import { publicOrigin, validWriteOrigin, sandboxCsp } from './origin';
import type { RuntimeSandbox } from './square-runtime';
import { SandboxCheckoutError } from '../../shared/sandbox-checkout';
import type { MerchantSettingsStore } from './merchant-settings';
import type { MerchantImportAdministration } from './merchant-import-service';
import type { SquareServices } from './square-services';
import type { SquarePromotionService } from './square-promotion-preview';
import type { MerchantStaffAuth } from './merchant-staff-auth';
import { merchantAuthRouter } from './merchant-auth-router';
import { applyMerchantDraft } from '../../shared/merchant-draft';

// Deliberately literal and immutable: environment variables cannot enable these.
export const capabilities = Object.freeze({
  checkout: false, mockCheckout: true, square: false, outboundMail: false, schedulers: false, databaseConnected: false,
} as const);

export async function createApp(repository: CatalogRepository = demoRepository, options: { checkout?: CheckoutBackend; localDatabase?: boolean; storage?: 'native-postgres'; origin?: string; healthcheck?: () => Promise<void>; sandbox?: RuntimeSandbox; merchantAuth?: MerchantStaffAuth; setupOnly?: boolean; admin?: { verifyStaff?: StaffVerifier; store?: AdminCatalogStore; settings?: MerchantSettingsStore; reconciliation?: SandboxReconciliationQueue; merchantImport?: MerchantImportAdministration; squareServices?: SquareServices; promotion?: SquarePromotionService } } = {}) {
  const catalog = await repository.load();
  validateCatalog(catalog);
  if (merchant.currency !== catalog.currency || merchant.fulfillment !== 'pickup') throw new Error('Unsupported merchant configuration');
  // Store a private serialized snapshot, so an injected repository cannot mutate it later.
  const origin = options.origin ? publicOrigin(options.origin) : undefined;
  if (options.sandbox && !origin?.startsWith('https://')) throw new Error('Sandbox routes require canonical HTTPS origin and CSP');
  if (options.merchantAuth && (origin !== options.merchantAuth.origin || options.admin?.verifyStaff))
    throw new Error('Merchant auth requires its exact configured HTTPS origin and one unambiguous staff verifier');
  if (Boolean(options.setupOnly) !== Boolean(options.merchantAuth) || (options.setupOnly && options.sandbox))
    throw new Error('Merchant setup and staff auth must be explicitly enabled together without checkout');
  const activeCapabilities = { ...capabilities, databaseConnected: options.localDatabase === true || options.storage === 'native-postgres' };
  const payload = JSON.stringify({ merchant, catalog, mode: 'synthetic-demo', capabilities: activeCapabilities } satisfies Storefront);
  const snapshot = JSON.parse(payload) as Storefront;
  const checkout = options.checkout ?? new DemoCheckoutService(snapshot.catalog);
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); if (origin) res.set('Content-Security-Policy', sandboxCsp); next(); });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (!options.setupOnly) app.use('/api/demo', (req, res, next) => {
    if (!validWriteOrigin(req, origin)) { res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Requests must use the configured application origin.' } }); return; }
    if (req.method === 'POST' && !req.is('application/json')) { res.status(415).json({ error: { code: 'INVALID_REQUEST', message: 'Send application/json.' } }); return; }
    next();
  }, express.json({ limit: '16kb', strict: true }));
  app.get('/api/health', async (_req, res) => { try { await options.healthcheck?.(); res.json({ status: 'ok', mode: options.setupOnly ? 'merchant-setup' : 'synthetic-demo', storage: options.storage ?? (options.localDatabase ? 'embedded-postgres' : 'memory'), capabilities: options.setupOnly ? { ...activeCapabilities, mockCheckout: false } : activeCapabilities }); } catch { res.status(503).json({ status: 'unavailable' }); } });
  if (!options.setupOnly) app.get('/api/storefront', async (_req, res) => res.json({ ...snapshot, merchant: options.admin?.settings ? applyMerchantDraft(snapshot.merchant, (await options.admin.settings.load()).settings) : snapshot.merchant, catalog: await checkout.getCatalog(), ...(options.sandbox ? { sandbox: options.sandbox.publicConfig } : {}) }));
  if (!options.setupOnly) app.get('/api/catalog/:productId', async (req, res) => {
    const product = (await checkout.getCatalog()).products.find((item) => item.id === req.params.productId);
    if (!product) { res.status(404).json({ error: 'Product not found' }); return; }
    res.json({ currency: snapshot.catalog.currency, product });
  });
  if (!options.setupOnly) {
    app.post('/api/demo/quote', async (req, res) => res.json(await checkout.quote(req.body)));
    app.post('/api/demo/checkouts', async (req, res) => res.json(await checkout.checkout(req.body)));
  }
  if (options.sandbox) { app.use('/api/sandbox', options.sandbox.router); }
  app.use('/api/merchant-auth', merchantAuthRouter(options.merchantAuth));
  app.use('/api/admin', adminCatalogRouter({ ...options.admin, verifyStaff: options.merchantAuth?.verifyStaff ?? options.admin?.verifyStaff, origin, runtime: { native: options.storage === 'native-postgres', sandbox: Boolean(options.sandbox) } }));
  // Real checkout, provider, email, order, and scheduling endpoints remain unavailable.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint unavailable in catalog demo' }));
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof SandboxCheckoutError) { res.status(503).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof AdminError) { res.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof CheckoutError) { res.status(error.status).json({ error: { code: error.code, message: error.message }, mode: 'mock-only' }); return; }
    const status = (error as { status?: number })?.status;
    if (status === 400 || status === 413) { res.status(status).json({ error: { code: 'INVALID_REQUEST', message: status === 413 ? 'Demo request is too large.' : 'Malformed JSON request.' } }); return; }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unable to serve demo request.' } });
  };
  app.use(handleError);
  return app;
}
