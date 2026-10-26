/** Local-only acceptance: generated merchant data, injected provider and routed fake card SDK.
 * Never loads environment credentials or contacts Square. Chromium/Playwright must already exist.
 * Run after pnpm build: node --import tsx scripts/merchant-browser-acceptance.ts
 * Browser-free fixture proof: append --fixture-check. Narrow windows are not real-device proof.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { initializeEmptyMerchantCatalog, MerchantCatalogImportStore } from '../server/src/merchant-catalog-import';
import { previewSquareSandboxCatalog } from '../server/src/square-catalog-readonly';
import { initializeMerchantCommerce } from '../db/merchant-commerce';
import { createMerchantCommerceApp } from '../server/src/merchant-commerce-app';
import { MerchantCommerce } from '../server/src/merchant-commerce';
import { MerchantSquareProvider } from '../server/src/merchant-square-provider';
import { sandboxConfiguration } from '../server/src/square-sandbox';
import type { MerchantStaffAuth } from '../server/src/merchant-staff-auth';
const require = createRequire(import.meta.url);
const origin = 'https://merchant-browser.example.invalid';
const serveOnly = process.argv.includes('--serve-only');
const fixtureCheck = process.argv.includes('--fixture-check');
assert.ok(!(serveOnly && fixtureCheck), 'Choose one fixture mode');
// Probe browser availability before opening any fixture database/listener. Never disable
// Chromium's sandbox to work around a restricted host. serve-only needs no browser package.
const browser = serveOnly || fixtureCheck ? undefined : await (async () => {
  const { chromium } = require('playwright');
  return chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, chromiumSandbox: true });
})();
let local = '';
// Local synthetic fixture ONLY: no production env values, no actual Square calls.
// The fixed loopback server is intentionally not tunneled or exposed publicly.
const settings = { STARTER_DATASET: 'merchant-catalog-v1', PUBLIC_ORIGIN: origin, SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-browser-fixture', SQUARE_LOCATION_ID: 'BROWSERLOCATION', SQUARE_SANDBOX_MERCHANT_ID: 'BROWSERMERCHANT', SQUARE_SANDBOX_ACCESS_TOKEN: 'synthetic-browser-fixture-token', SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', SQUARE_MERCHANT_COMMERCE_ENABLED: 'true', SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'synthetic-browser-signing-key' };
const identity = { squareMerchantId: settings.SQUARE_SANDBOX_MERCHANT_ID, squareLocationId: settings.SQUARE_LOCATION_ID };
const output = join(process.cwd(), '.local-data', 'merchant-browser-acceptance');
await mkdir(output, { recursive: true });
const db = await PGlite.create();
const money = (amount: number) => ({ amount, currency: 'USD' });
const calls: { path: string; body: any }[] = [];
const provider: typeof fetch = async (url, init) => {
  assert.equal(new URL(String(url)).origin, 'https://connect.squareupsandbox.com', 'Only injected sandbox provider requests are permitted');
  const path = new URL(String(url)).pathname; const body = JSON.parse(String(init?.body)); calls.push({ path, body });
  if (path.startsWith('/v2/orders')) return new Response(JSON.stringify({ order: { ...body.order, id: path.endsWith('/calculate') ? undefined : 'ORDER_' + body.order.reference_id,
    line_items: body.order.line_items.map((line: any) => ({ ...line, base_price_money: money(1000), gross_sales_money: money(1000), total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) })), total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) } }));
  if (path === '/v2/payments') return new Response(JSON.stringify({ payment: { ...body, id: 'PAYMENT_' + body.reference_id, status: 'COMPLETED' } }));
  if (path === '/v2/refunds') {
    const refund = { id: 'REFUND_' + body.idempotency_key, payment_id: body.payment_id, location_id: settings.SQUARE_LOCATION_ID, amount_money: body.amount_money, status: 'COMPLETED', updated_at: new Date().toISOString() };
    // Project completion only via a signed synthetic webhook, just like production state rules.
    setTimeout(() => {
      const raw = JSON.stringify({ event_id: randomUUID(), merchant_id: settings.SQUARE_SANDBOX_MERCHANT_ID, type: 'refund.updated', data: { type: 'refund', id: refund.id, object: { refund } } });
      const signature = createHmac('sha256', settings.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY).update(origin + '/api/commerce/webhooks').update(raw).digest('base64');
      void fetch(local + '/api/commerce/webhooks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': signature }, body: raw }).then(response => { if (!response.ok) console.error('Synthetic refund webhook rejected:', response.status); }).catch(() => console.error('Synthetic refund webhook unavailable'));
    }, 100);
    return new Response(JSON.stringify({ refund }));
  }
  throw new Error('Unexpected injected provider request ' + path);
};
await initializeEmptyMerchantCatalog(db, identity);
const preview = await previewSquareSandboxCatalog({ environment: 'sandbox', locationId: settings.SQUARE_LOCATION_ID, token: settings.SQUARE_SANDBOX_ACCESS_TOKEN }, async () => new Response(JSON.stringify({ objects: [{ type: 'ITEM', id: 'BROWSER_ITEM', present_at_all_locations: true, item_data: { name: 'Cedar studio candle', description: 'A small-batch candle, ready for pickup.', tax_ids: ['CATALOG_TAX'], variations: [{ type: 'ITEM_VARIATION', id: 'BROWSER_VARIANT', present_at_all_locations: true, item_variation_data: { name: 'Amber jar', sku: 'BROWSER-CANDLE', pricing_type: 'FIXED_PRICING', price_money: money(1000) } }] } }] })), { taxTreatment: 'square-order-authoritative' });
const store = new MerchantCatalogImportStore(db, { taxTreatment: 'square-order-authoritative' });
const staged = await store.stage(preview, identity, 'website');
await store.commit(staged.fingerprint, identity, 'fixture-operator', 'approve-disabled-merchant-import-v1');
await initializeMerchantCommerce(db, settings);
const auth: MerchantStaffAuth = { origin, verifyStaff: async () => ({ id: 'fixture-admin', role: 'admin', csrfToken: 'fixture-csrf-token-long-enough' }), login: async () => { throw new Error('No credentials in this fixture'); }, logout: async () => {} };
const merchant = { name: 'Studio Market', descriptor: 'Made for everyday moments', tagline: 'Good things, close to home.', introduction: 'Thoughtful favorites from our studio to yours.', currency: 'USD' as const, fulfillment: 'pickup' as const, pickup: { label: 'Studio counter', instructions: 'Pick up at the studio counter during posted hours.' }, theme: { accent: '#A1AB74', background: '#f9f8f4' } };
const commerce = new MerchantCommerce(db, new MerchantSquareProvider(sandboxConfiguration(settings), provider), {merchantId:identity.squareMerchantId,locationId:identity.squareLocationId});
const readiness = await commerce.configure({reviewed:true,branding:{name:merchant.name,tagline:merchant.tagline,accentColor:merchant.theme.accent,backgroundColor:merchant.theme.background},support:{email:'support@example.invalid',url:'https://example.invalid/support'},policies:{termsUrl:'https://example.invalid/terms',privacyUrl:'https://example.invalid/privacy',refundUrl:'https://example.invalid/refunds'},inventory:{authority:'website-allocation',allocationReviewed:true},pickup:{timeZone:'UTC',leadMinutes:15,weeklyHours:Array.from({length:7},(_,weekday)=>({weekday,opens:'00:00',closes:'24:00'})),blackoutDates:[]}});
assert.equal(readiness.ready,true);
assert.equal((await db.query<{enabled:boolean}>('SELECT enabled FROM merchant_commerce_config')).rows[0]!.enabled,false,'Readiness must not activate checkout');
assert.equal((await commerce.catalog()).products[0]!.variants[0]!.enabled,false);
if(fixtureCheck){
  assert.equal(calls.length,0);
  await db.close();
  console.log('FIXTURE_ONLY_PASS: schema2, imported disabled catalog, reviewed Studio Market pickup/readiness, checkout remains closed; zero provider dispatches. No browser acceptance or screenshots claimed.');
  process.exit(0);
}
const app = createMerchantCommerceApp(db, settings, auth, merchant, provider);
app.use(express.static(join(process.cwd(), 'dist/client')));
app.get(['/', '/admin', '/admin/*rest'], (_req, res) => res.sendFile(join(process.cwd(), 'dist/client/index.html')));
const wrapper = express();
if (serveOnly) {
  // Fixture-only adapter: preserve the production app's HTTPS-origin guard unchanged.
  // Permit ONLY this exact loopback browser origin, not arbitrary cross-origin requests.
  wrapper.use((req, _res, next) => { if (req.get('Origin') === 'http://127.0.0.1:43210') req.headers.origin = origin; next(); });
}
wrapper.use(app);
const server = wrapper.listen(serveOnly ? 43210 : 0, '127.0.0.1'); await once(server, 'listening');
local = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
if (serveOnly) {
  console.log('SYNTHETIC LOCAL FIXTURE ONLY — injected merchant/admin/provider; no real credentials or Square calls.');
  console.log('Storefront: ' + local + ' | Admin: ' + local + '/admin/commerce');
  console.log('Use staff controls to save stock and open storefront, then test pickup/quote/prepare. Real SDK remains HTTPS-blocked.');
  const shutdown = async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); process.exit(0); };
  process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
  await new Promise<void>(() => {});
}
const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 } });
const browserErrors: string[] = [];
const fakeSdk = `window.Square={payments(){return{async card(){return{async attach(target){document.querySelector(target).innerHTML='<label>Fake sandbox card (injected test only)<input aria-label="Fake sandbox card" value="4111111111111111"></label>'},async destroy(){},async tokenize(details){window.__tokenizationAmount=details.amount;return{status:'OK',token:'browser-injected-test-card'}}}}}}};`;
await context.route('**/*', async (route: any) => {
  const url = new URL(route.request().url());
  if (url.href === 'https://sandbox.web.squarecdn.com/v1/square.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: fakeSdk });
  if (url.origin !== origin) return route.abort('blockedbyclient');
  const response = await route.fetch({ url: local + url.pathname + url.search });
  return route.fulfill({ response });
});
const page = await context.newPage();
page.on('pageerror', (error: Error) => browserErrors.push(error.message));
try {
  // Activate imported inventory using the real browser staff controls with injected test auth.
  await page.goto(origin + '/admin/commerce');
  await page.getByLabel('Units allocated to this website').fill('3');
  await page.getByLabel('Available for sandbox purchase').check();
  await Promise.all([page.waitForResponse((response: any) => response.url().endsWith('/api/admin/commerce/inventory') && response.request().method() === 'GET'), page.getByRole('button', { name: 'Save reviewed stock' }).click()]);
  await page.getByRole('button', { name: 'Open sandbox storefront' }).click();
  await page.getByText('Sandbox storefront opened. Production payments remain disabled.').waitFor();
  await page.screenshot({ path: join(output, '01-admin-stock-desktop.png'), fullPage: true });
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Cedar studio candle' }).waitFor();
  await page.screenshot({ path: join(output, '02-storefront-desktop.png'), fullPage: true });
  assert.equal(await page.getByRole('button', { name: '3 Checkout' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.getByRole('button', { name: 'Choose pickup · 1 items' }).click();
  await page.screenshot({ path: join(output, '02b-cart-desktop.png'), fullPage: true });
  await page.getByLabel('Pickup name').fill('Browser Test Shopper');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.invalid');
  await page.getByLabel('Phone (with country code').fill('+12025550100');
  await page.getByRole('button', { name: 'Review Square total' }).click();
  await page.getByText('Square total', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, '03-authoritative-total-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Accept total & continue to test card' }).click();
  await page.getByRole('button', { name: 'Pay $9.90 in sandbox' }).waitFor();
  await page.getByRole('button', { name: 'Pay $9.90 in sandbox' }).click();
  await page.getByRole('heading', { name: 'Sandbox payment confirmed' }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).__tokenizationAmount), '9.90');
  const storageKey = `merchant-sandbox-attempt:${settings.SQUARE_APPLICATION_ID}:${settings.SQUARE_LOCATION_ID}`;
  const storage = Object.fromEntries(await page.evaluate(() => Object.entries(sessionStorage)));
  assert.deepEqual(Object.keys(storage).sort(), [storageKey, storageKey + ':confirmation', storageKey + ':write'].sort());
  const attemptId = storage[storageKey];
  assert.match(attemptId, /^[a-f0-9-]{36}$/);
  const writeAuthorization = JSON.parse(storage[storageKey + ':write']);
  assert.deepEqual(Object.keys(writeAuthorization).sort(), ['attemptId', 'token']);
  assert.equal(writeAuthorization.attemptId, attemptId);
  const canonicalCapability = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
  assert.match(writeAuthorization.token, canonicalCapability);
  const lookupToken = storage[storageKey + ':confirmation'];
  assert.match(lookupToken, canonicalCapability);
  assert.equal(writeAuthorization.token !== lookupToken, true, 'Read and write capabilities must be distinct');
  assert.doesNotMatch(JSON.stringify(storage), /browser@example|Test Shopper|test-card/);
  await page.getByText('Save this private link; no confirmation email is sent by this template.', { exact: true }).waitFor();
  const privateLink = await page.getByRole('link', { name: 'Save this private order-status link', exact: true }).getAttribute('href');
  assert.equal(privateLink === '#order=' + lookupToken, true);
  assert.equal(privateLink.includes(writeAuthorization.token), false);
  const confirmation = page.getByRole('region', { name: 'Order confirmation' });
  await confirmation.getByText('Cedar studio candle', { exact: true }).waitFor();
  await confirmation.getByText('Quantity 1', { exact: true }).waitFor();
  assert.doesNotMatch(await confirmation.innerText(), /browser@example|Test Shopper|12025550100/);
  // A separate tab starts with no write capability. The private receipt is read-only.
  const receiptPage = await context.newPage();
  const receiptRequests: string[] = [];
  receiptPage.on('request', (request: any) => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/commerce/')) receiptRequests.push(request.method() + ' ' + url.pathname); });
  try {
    await receiptPage.goto(origin + '/' + privateLink);
    await receiptPage.getByRole('heading', { name: 'Payment confirmed', exact: true }).waitFor();
    assert.equal(new URL(receiptPage.url()).hash, '');
    const receiptStorage = Object.fromEntries(await receiptPage.evaluate(() => Object.entries(sessionStorage)));
    assert.deepEqual(Object.keys(receiptStorage), [storageKey + ':lookup']);
    assert.equal(receiptStorage[storageKey + ':lookup'] === lookupToken, true);
    assert.equal(await receiptPage.getByRole('button', { name: /Pay |Cancel before payment|Start a new cart/ }).count(), 0);
    assert.equal(receiptRequests.includes('POST /api/commerce/lookup'), true);
    assert.equal(receiptRequests.some(request => /\/(prepare|submit|cancel|status)$/.test(request)), false);
  } finally { await receiptPage.close(); }
  await page.screenshot({ path: join(output, '04-receipt-desktop.png'), fullPage: true });
  await page.reload();
  await page.getByRole('heading', { name: 'Sandbox payment confirmed' }).waitFor();
  assert.equal(calls.filter(call => call.path === '/v2/payments').length, 1);
  assert.equal(calls.filter(call => call.path === '/v2/orders').length, 1);
  await page.setViewportSize({ width: 390, height: 844 }); // Ordinary responsive resize, not device emulation.
  await page.screenshot({ path: join(output, '05-reloaded-receipt-narrow.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.goto(origin + '/admin/commerce');
  await page.getByLabel('Sandbox refund amount (USD)').fill('5.00');
  await page.getByRole('button', { name: 'Submit / recover same sandbox refund' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText(/Refunded \$5\.00/).waitFor();
  await page.screenshot({ path: join(output, '06-admin-refund-narrow.png'), fullPage: true });
  assert.equal(calls.filter(call => call.path === '/v2/refunds').length, 1);
  assert.equal((await db.query<{stock_quantity:number}>('SELECT stock_quantity FROM merchant_commerce_inventory')).rows[0]!.stock_quantity, 2);
  await page.goto(origin);
  await page.getByText('Refunded: $5.00').waitFor();
  await page.getByRole('button', { name: 'Start a new cart' }).click();
  await page.getByRole('heading', { name: 'Cedar studio candle' }).waitFor();
  await page.screenshot({ path: join(output, '07-storefront-narrow.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ result: 'PASS', provider: 'injected fake; no Square network', sdk: 'routed fake; not real SDK acceptance', checks: ['persisted taxed catalog import', 'admin stock and activation', 'pickup', 'authoritative total', 'amount-bound tokenization', 'single payment', 'reload same identity', 'desktop and ordinary narrow window (not mobile emulation or real-phone proof)', 'admin partial refund without restock', 'receipt refund recovery', 'distinct persisted read/write capabilities', 'private receipt tab has no checkout authority', 'explicit no-email confirmation'], screenshots: output, providerRequests: calls.map(call => call.path) }, null, 2));
} finally { await context.close(); await browser!.close(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
