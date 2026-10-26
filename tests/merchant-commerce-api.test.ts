import {createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { initializeEmptyMerchantCatalog } from '../server/src/merchant-catalog-import';
import { initializeMerchantCommerce } from '../db/merchant-commerce';
import { createMerchantCommerceApp } from '../server/src/merchant-commerce-app';
import type { MerchantStaffAuth } from '../server/src/merchant-staff-auth';
import type { StaffPrincipal } from '../server/src/admin-catalog';
import { verifyMerchantAttempt, verifyMerchantQuote } from '../client/src/merchant-storefront';
import { merchant } from '../config/merchant';
const origin = 'https://merchant.example.invalid';
const csrf = 'synthetic-test-csrf-at-least-sixteen';
const values = { STARTER_DATASET: 'merchant-catalog-v1', PUBLIC_ORIGIN: origin, SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-commerce-test', SQUARE_LOCATION_ID: 'TESTLOCATION', SQUARE_SANDBOX_MERCHANT_ID: 'TESTMERCHANT', SQUARE_SANDBOX_ACCESS_TOKEN: 'unit-commerce-private-token', SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', SQUARE_MERCHANT_COMMERCE_ENABLED: 'true', SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'synthetic-http-signature-key' };
const pickup = { name: 'Unit Shopper', email: 'shopper@example.invalid', phone: '+12025550100' };
const cart = { currency: 'USD', fulfillment: 'pickup', items: [{ productId: 'item', variantId: 'item-regular', quantity: 1 }] };
const money = (amount: number) => ({ amount, currency: 'USD' });
async function fixture(t: test.TestContext, webhookPath?:string) {
  const db = await PGlite.create();
  await initializeEmptyMerchantCatalog(db, { squareMerchantId: values.SQUARE_SANDBOX_MERCHANT_ID, squareLocationId: values.SQUARE_LOCATION_ID });
  await db.exec("UPDATE merchant_catalog_identity SET inventory_owner='website'; INSERT INTO catalog_products(id,name,description,category,options) VALUES('item','HTTP test item','Synthetic fixture','Tests','[]'); INSERT INTO catalog_variants(id,product_id,sku,selections,price_minor) VALUES('item-regular','item','UNIT-HTTP','{}',1000); INSERT INTO merchant_square_item_links(square_item_id,product_id) VALUES('SQUARE_ITEM','item'); INSERT INTO merchant_square_variation_links(square_variation_id,variant_id,square_item_id) VALUES('SQUARE_VARIANT','item-regular','SQUARE_ITEM');");
  await initializeMerchantCommerce(db, values);
  let principal: StaffPrincipal | null = null;
  const auth: MerchantStaffAuth = { origin, verifyStaff: async () => principal, login: async () => { throw new Error('Not used by integration tests'); }, logout: async () => {} };
  const calls: { path: string; body: Record<string, any> }[] = [];
  const provider: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    assert.equal(new URL(String(url)).origin, 'https://connect.squareupsandbox.com');
    const body = JSON.parse(String(init?.body)); calls.push({ path, body });
    if (path.startsWith('/v2/orders')) {
      return new Response(JSON.stringify({ order: { ...body.order, id: path.endsWith('/calculate') ? undefined : 'ORDER_' + body.order.reference_id,
        line_items: body.order.line_items.map((line: Record<string, unknown>) => ({ ...line, base_price_money: money(1000), gross_sales_money: money(1000), total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) })), total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) } }));
    }
    assert.equal(path, '/v2/payments');
    return new Response(JSON.stringify({ payment: { ...body, id: 'PAYMENT_' + body.reference_id, status: 'COMPLETED' } }));
  };
  const app = createMerchantCommerceApp(db, {...values,...(webhookPath?{SQUARE_MERCHANT_WEBHOOK_PATH:webhookPath}:{})}, auth, merchant, provider);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); });
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  async function send(path: string, body: unknown, overrides: RequestInit = {}) {
    return fetch(url + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body), ...overrides });
  }
  return { db, url, auth, calls, provider, send, principal(next: StaffPrincipal | null) { principal = next; } };
}
const admin: StaffPrincipal = { id: 'test-admin', role: 'admin', csrfToken: csrf };

test('merchant HTTP app requires explicit sandbox, merchant dataset and provider opt-ins', async t => {
  const f = await fixture(t);
  for (const change of [{ STARTER_DATASET: 'synthetic-retail-v1' }, { SQUARE_MERCHANT_COMMERCE_ENABLED: undefined }, { SQUARE_SANDBOX_REQUESTS_ENABLED: 'false' }, { SQUARE_ENVIRONMENT: 'production' }, { SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: undefined }, { PUBLIC_ORIGIN: 'http://merchant.example.invalid' }]) {
    assert.throws(() => createMerchantCommerceApp(f.db, { ...values, ...change }, f.auth, merchant, f.provider));
  }
  assert.equal(f.calls.length, 0);
});

test('merchant commerce routes enforce origin, JSON, scoped staff role and CSRF before writes', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'Content-Type': 'application/json' }, { 'Content-Type': 'application/json', Origin: 'https://attacker.example.invalid' }] as Record<string, string>[]) {
    assert.equal((await f.send('/api/commerce/quote', cart, { headers })).status, 403);
  }
  assert.equal((await f.send('/api/commerce/quote', cart, { headers: { Origin: origin, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(f.url + '/api/admin/commerce/inventory', { headers: { 'X-Role': 'admin' } })).status, 401);
  f.principal({ ...admin, role: 'manager' });
  assert.equal((await fetch(f.url + '/api/admin/commerce/inventory')).status, 403);
  assert.equal((await f.send('/api/admin/commerce/activation', { enabled: true })).status, 403);
  f.principal(admin);
  assert.equal((await f.send('/api/admin/commerce/activation', { enabled: true }, { headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.send('/api/admin/commerce/activation', { enabled: true }, { headers: { Origin: 'https://attacker.example.invalid', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('activated merchant inventory runs actual quote/prepare/pay/status HTTP contracts without client prices or token persistence', async t => {
  const f = await fixture(t);
  let storefront = await (await fetch(f.url + '/api/storefront')).json();
  assert.equal(storefront.mode, 'merchant-sandbox');
  assert.equal(storefront.sandbox.environment, 'sandbox');
  assert.equal(storefront.catalog.products[0].variants[0].enabled, false);
  assert.equal((await f.send('/api/commerce/quote', cart)).status, 409);
  f.principal(admin);
  assert.equal((await f.send('/api/admin/commerce/inventory', { variantId: 'item-regular', quantity: 3, enabled: true, revision: 0 }, { method: 'PUT' })).status, 200);
  assert.equal((await f.send('/api/admin/commerce/activation', { enabled: true })).status, 200);
  const response = await fetch(f.url + '/api/storefront');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  storefront = await response.json();
  assert.equal(storefront.catalog.products[0].variants[0].enabled, true);
  assert.equal(storefront.catalog.products[0].variants[0].stockQuantity, 3);
  assert.doesNotMatch(JSON.stringify(storefront), /private-token|signature-key/);
  for (const body of [{ ...cart, totalMinor: 1 }, { ...cart, taxMinor: 0 }, { ...cart, items: [{ ...cart.items[0], unitPriceMinor: 1 }] }]) {
    assert.equal((await f.send('/api/commerce/quote', body)).status, 400);
  }
  assert.equal(f.calls.length, 0);
  const quoted = await f.send('/api/commerce/quote', cart); assert.equal(quoted.status, 200);
  const quote = verifyMerchantQuote(await quoted.json());
  assert.deepEqual([quote.subtotalMinor, quote.discountMinor, quote.taxMinor, quote.totalMinor], [1000, 100, 90, 990]);
  assert.equal((await f.send('/api/commerce/prepare', { quoteId: quote.quoteId, pickup, checkoutToken: quote.checkoutToken, amountMinor: 1 })).status, 400);
  const prepare = await f.send('/api/commerce/prepare', { quoteId: quote.quoteId, pickup, checkoutToken: quote.checkoutToken }); assert.equal(prepare.status, 200);
  assert.equal(verifyMerchantAttempt(await prepare.json(), quote.quoteId).state, 'reserved');
  const paid = await f.send('/api/commerce/submit', { attemptId: quote.quoteId, checkoutToken: quote.checkoutToken, cardToken: 'sandbox-unit-token' }); assert.equal(paid.status, 200);
  assert.equal(verifyMerchantAttempt(await paid.json(), quote.quoteId).state, 'completed');
  const replay = await f.send('/api/commerce/submit', { attemptId: quote.quoteId, checkoutToken: quote.checkoutToken, cardToken: 'sandbox-unit-token' }); assert.equal(replay.status, 200);
  const status = await f.send('/api/commerce/status', { attemptId: quote.quoteId, checkoutToken: quote.checkoutToken }); assert.equal(status.status, 200);
  assert.equal(verifyMerchantAttempt(await status.json(), quote.quoteId).fulfillmentAuthorized, false);
  assert.equal(f.calls.filter(call => call.path === '/v2/orders').length, 1);
  assert.equal(f.calls.filter(call => call.path === '/v2/payments').length, 1);
  assert.equal(f.calls.find(call => call.path === '/v2/payments')?.body.amount_money.amount, 990);
  assert.doesNotMatch(JSON.stringify((await f.db.query('SELECT * FROM merchant_commerce_attempts')).rows), /sandbox-unit-token/);
  const badWebhook = await f.send('/api/commerce/webhooks', { event_id: 'unsigned-event' }, { headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': 'invalid' } });
  assert.equal(badWebhook.status, 403);
  assert.match((await badWebhook.json()).error, /webhook rejected/i);
  assert.equal((await f.db.query<{ stock_quantity: number }>('SELECT stock_quantity FROM merchant_commerce_inventory')).rows[0]?.stock_quantity, 2);
});


test('merchant callback can preserve existing sandbox URL without weakening exact-URL signatures',async t=>{
 const f=await fixture(t,'/api/sandbox/webhooks');
 const event={merchant_id:values.SQUARE_SANDBOX_MERCHANT_ID,event_id:'merchant-path-test',type:'catalog.version.updated'};
 const signature=(path:string)=>createHmac('sha256',values.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY).update(origin+path).update(JSON.stringify(event)).digest('base64');
 const send=(path:string)=>f.send('/api/sandbox/webhooks',event,{headers:{'Content-Type':'application/json','x-square-hmacsha256-signature':signature(path)}});
 assert.equal((await send('/api/commerce/webhooks')).status,403);
 const valid=await send('/api/sandbox/webhooks');assert.equal(valid.status,200);assert.equal((await valid.json()).outcome,'ignored');
 assert.throws(()=>createMerchantCommerceApp(f.db,{...values,SQUARE_MERCHANT_WEBHOOK_PATH:'https://elsewhere.invalid'},f.auth,merchant,f.provider));
 assert.equal(f.calls.length,0);
});

test('admin checkout status is authenticated, DB-authoritative rather than readiness, read-only and branding-consistent', async t => {
  const f=await fixture(t);
  assert.equal((await fetch(f.url+'/api/admin/commerce/status')).status,401);
  f.principal({...admin,role:'manager'});assert.equal((await fetch(f.url+'/api/admin/commerce/status')).status,403);
  f.principal(admin);
  const settings={reviewed:true,branding:{name:'Configured Merchant',tagline:'Current configured tagline',accentColor:'#123456',backgroundColor:'#F9F8F4',logoUrl:'https://example.com/logo.png'},support:{email:'help@example.com',url:'https://example.com/help'},policies:{termsUrl:'https://example.com/terms',privacyUrl:'https://example.com/privacy',refundUrl:'https://example.com/refunds'},inventory:{authority:'website-allocation',allocationReviewed:true},pickup:{timeZone:'UTC',leadMinutes:15,weeklyHours:Array.from({length:7},(_,weekday)=>({weekday,opens:'00:00',closes:'24:00'})),blackoutDates:[]}};
  assert.equal((await f.send('/api/admin/commerce/settings',settings,{method:'PUT'})).status,200);
  const readiness=await (await fetch(f.url+'/api/admin/commerce/readiness')).json();assert.equal(readiness.ready,true);
  for(const enabled of [false,true,false]){
    if(enabled)assert.equal((await f.send('/api/admin/commerce/activation',{enabled:true})).status,200);
    else await f.db.query('UPDATE merchant_commerce_config SET enabled=false');
    const before=(await f.db.query('SELECT * FROM merchant_commerce_config')).rows;
    const response=await fetch(f.url+'/api/admin/commerce/status');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const status=await response.json();assert.equal(status.checkoutEnabled,enabled);assert.equal(status.merchant.name,'Configured Merchant');assert.equal(status.merchant.theme.accent,'#123456');
    assert.deepEqual((await f.db.query('SELECT * FROM merchant_commerce_config')).rows,before);
    const storefront=await (await fetch(f.url+'/api/storefront')).json();
    assert.deepEqual(status.merchant,storefront.merchant);assert.equal(storefront.checkoutEnabled,enabled);assert.equal(storefront.capabilities.sandboxCheckout,enabled);assert.equal(storefront.capabilities.checkout,false);
    assert.equal(storefront.configuration.branding.logoUrl,'https://example.com/logo.png');
  }
  assert.equal(f.calls.length,0);
  await f.db.query('DELETE FROM merchant_commerce_config');
  assert.equal((await (await fetch(f.url+'/api/admin/commerce/status')).json()).checkoutEnabled,false);
});

test('optional email administration is scoped and CSRF-protected while disabled mode creates no email tables or sends',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.url+'/api/admin/commerce/email')).status,401);
 assert.equal((await f.send('/api/admin/commerce/email/drain',{})).status,401);
 f.principal({...admin,role:'manager'});assert.equal((await fetch(f.url+'/api/admin/commerce/email')).status,403);
 f.principal(admin);
 const status=await (await fetch(f.url+'/api/admin/commerce/email')).json();
 assert.equal(status.enabled,false);assert.equal(status.dispatchAllowed,false);assert.equal(status.deliveryMode,'disabled');assert.equal(status.acceptedIsNotDelivered,true);
 assert.equal((await f.send('/api/admin/commerce/email/drain',{}, {headers:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':'wrong'}})).status,403);
 assert.equal((await f.send('/api/admin/commerce/email/drain',{})).status,409);
 const publicConfig=await (await fetch(f.url+'/api/storefront')).json();assert.equal(publicConfig.confirmationEmailEnabled,false);assert.equal(publicConfig.capabilities.outboundMail,false);
 assert.equal((await f.db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'merchant_email_%'")).rows.length,0);
 assert.equal(f.calls.length,0);
});
