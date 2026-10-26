import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { initializeEmptyMerchantCatalog } from '../server/src/merchant-catalog-import';
import { initializeMerchantCommerce } from '../db/merchant-commerce';
import { MerchantCommerce, CommerceError } from '../server/src/merchant-commerce';
import { MerchantSquareProvider } from '../server/src/merchant-square-provider';
import { sandboxConfiguration } from '../server/src/square-sandbox';
import { createMerchantCommerceApp } from '../server/src/merchant-commerce-app';
import type { MerchantStaffAuth } from '../server/src/merchant-staff-auth';
import { merchant } from '../config/merchant';

const values = { STARTER_DATASET: 'merchant-catalog-v1', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-buyer-security', SQUARE_LOCATION_ID: 'TESTLOCATION', SQUARE_SANDBOX_MERCHANT_ID: 'TESTMERCHANT', SQUARE_SANDBOX_ACCESS_TOKEN: 'injected-private-provider-token', SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', SQUARE_MERCHANT_COMMERCE_ENABLED: 'true', SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'injected-signature-key', PUBLIC_ORIGIN: 'https://merchant.example.invalid' };
const context = { merchantId: values.SQUARE_SANDBOX_MERCHANT_ID, locationId: values.SQUARE_LOCATION_ID };
const pickup = { name: 'PRIVATE_BUYER_NAME', email: 'private-buyer@example.invalid', phone: '+12025550100' };
const cart = { currency: 'USD', fulfillment: 'pickup', items: [{ productId: 'security-item', variantId: 'security-variant', quantity: 1 }] };
const money = (amount: number) => ({ amount, currency: 'USD' });
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const denied = (error: unknown) => error instanceof CommerceError && error.status === 404;
const operating = (reviewed = true) => ({ reviewed, branding: { name: 'Public shop', tagline: 'Carefully selected', accentColor: '#a1ab74', backgroundColor: '#f9f8f4' }, support: { email: 'support@example.com', url: 'https://example.com/support' }, policies: { termsUrl: 'https://example.com/terms', privacyUrl: 'https://example.com/privacy', refundUrl: 'https://example.com/refunds' }, inventory: { authority: 'website-allocation', allocationReviewed: true }, pickup: { timeZone: 'America/New_York', leadMinutes: 15, weeklyHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, opens: '00:00', closes: '24:00' })), blackoutDates: [] } });
async function fixture(t: test.TestContext) {
  const db = await PGlite.create(); t.after(() => db.close());
  await initializeEmptyMerchantCatalog(db, { squareMerchantId: context.merchantId, squareLocationId: context.locationId });
  await db.exec("UPDATE merchant_catalog_identity SET inventory_owner='website'; INSERT INTO catalog_products(id,name,description,category,options) VALUES('security-item','Original public item','Public description','Tests','[]'); INSERT INTO catalog_variants(id,product_id,sku,selections,price_minor) VALUES('security-variant','security-item','SECURITY-SKU','{}',1000); INSERT INTO merchant_square_item_links(square_item_id,product_id) VALUES('SQUARE_ITEM','security-item'); INSERT INTO merchant_square_variation_links(square_variation_id,variant_id,square_item_id) VALUES('SQUARE_VARIANT','security-variant','SQUARE_ITEM');");
  await initializeMerchantCommerce(db, values);
  const calls: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    const body = JSON.parse(String(init?.body));
    if (path.startsWith('/v2/orders')) return new Response(JSON.stringify({ order: { ...body.order, id: path.endsWith('/calculate') ? undefined : 'ORDER_' + body.order.reference_id, line_items: body.order.line_items.map((line: Record<string, unknown>) => ({ ...line, base_price_money: money(1000), gross_sales_money: money(1000), total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) })), total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) } }));
    assert.equal(path, '/v2/payments'); return new Response(JSON.stringify({ payment: { ...body, id: 'PAYMENT_' + body.reference_id, status: 'COMPLETED' } }));
  };
  const provider = new MerchantSquareProvider(sandboxConfiguration(values), transport);
  const service = new MerchantCommerce(db, provider, context);
  await service.updateInventory({ variantId: 'security-variant', quantity: 10, enabled: true, revision: 0 }); await service.activate(true);
  return { db, service, provider, transport, calls };
}
async function stock(db: PGlite) { return (await db.query<{ stock_quantity: number }>("SELECT stock_quantity FROM merchant_commerce_inventory WHERE variant_id='security-variant'")).rows[0]!.stock_quantity; }

test('checkout and receipt capabilities are distinct random values and only SHA256 hashes persist', async t => {
  const f = await fixture(t); const quote = await f.service.quote(cart);
  assert.match(quote.checkoutToken, /^[A-Za-z0-9_-]{43}$/); await f.service.authorizeCheckout(quote.quoteId, quote.checkoutToken);
  const prepared = await f.service.prepare(quote.quoteId, pickup); const token = prepared.confirmation!.lookupToken;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(token, quote.checkoutToken);
  const q = (await f.db.query<{ checkout_token_hash: string }>('SELECT checkout_token_hash FROM merchant_commerce_quotes WHERE id=$1', [quote.quoteId])).rows[0]!;
  const a = (await f.db.query<{ customer_lookup_hash: string; customer_lookup_expires_at: Date | string }>('SELECT customer_lookup_hash,customer_lookup_expires_at FROM merchant_commerce_attempts WHERE id=$1', [quote.quoteId])).rows[0]!;
  assert.equal(q.checkout_token_hash, hash(quote.checkoutToken)); assert.equal(a.customer_lookup_hash, hash(token));
  assert.ok(new Date(a.customer_lookup_expires_at).getTime() > Date.now() + 89 * 86400_000);
  const rows = await f.db.query('SELECT to_jsonb(q) AS quote,to_jsonb(a) AS attempt FROM merchant_commerce_quotes q JOIN merchant_commerce_attempts a ON a.id=q.id');
  assert.ok(!JSON.stringify(rows.rows).includes(quote.checkoutToken)); assert.ok(!JSON.stringify(rows.rows).includes(token));
});
test('wrong checkout capabilities uniformly reject without reserving stock or making effects', async t => {
  const f = await fixture(t); const quote = await f.service.quote(cart); const before = f.calls.length;
  for (const [id, token] of [[quote.quoteId, randomBytes(32).toString('base64url')], [randomUUID(), quote.checkoutToken], [quote.quoteId, undefined], [quote.quoteId, 'not-a-token'], [quote.quoteId, 'A'.repeat(42) + 'B']]) await assert.rejects(f.service.authorizeCheckout(id, token), denied);
  assert.equal(await stock(f.db), 10); assert.equal(f.calls.length, before);
  assert.equal((await f.db.query('SELECT id FROM merchant_commerce_attempts')).rows.length, 0);
});
test('lookup capability is read-only even when the attempt UUID is known; checkout capability cannot be used as receipt token', async t => {
  const f = await fixture(t); const quote = await f.service.quote(cart); const prepared = await f.service.prepare(quote.quoteId, pickup);
  await assert.rejects(f.service.authorizeCheckout(quote.quoteId, prepared.confirmation!.lookupToken), denied);
  await assert.rejects(f.service.lookup(quote.checkoutToken), denied);
  await assert.rejects(f.service.lookup(quote.quoteId), denied);
  assert.equal((await f.service.lookup(prepared.confirmation!.lookupToken)).attemptId, quote.quoteId);
  assert.equal((await f.service.status(quote.quoteId)).state, 'reserved'); assert.equal(await stock(f.db), 9);
  assert.equal(f.calls.filter(path => path === '/v2/payments').length, 0);
});
test('only first preparation discloses lookup token, including concurrent repeat preparations', async t => {
  const f = await fixture(t); const quote = await f.service.quote(cart);
  const replies = await Promise.all([f.service.prepare(quote.quoteId, pickup), f.service.prepare(quote.quoteId, pickup)]);
  assert.equal(replies.filter(reply => reply.confirmation).length, 1);
  assert.equal((await f.service.prepare(quote.quoteId, pickup)).confirmation, undefined);
  assert.equal((await f.db.query('SELECT id FROM merchant_commerce_attempts')).rows.length, 1);
  assert.equal(await stock(f.db), 9);
});
test('receipt capability expires and malformed or unrelated tokens reveal no existence detail', async t => {
  const f = await fixture(t); const quote = await f.service.quote(cart); const prepared = await f.service.prepare(quote.quoteId, pickup); const token = prepared.confirmation!.lookupToken;
  for (const invalid of [undefined, '', 'A'.repeat(42) + 'B', randomBytes(32).toString('base64url')]) await assert.rejects(f.service.lookup(invalid), denied);
  await f.db.query("UPDATE merchant_commerce_attempts SET customer_lookup_expires_at=now()-interval '1 second' WHERE id=$1", [quote.quoteId]);
  await assert.rejects(f.service.lookup(token), denied);
  assert.equal(await stock(f.db), 9);
});
test('lookup returns immutable purchased names and safe public metadata without buyer contact or write capabilities', async t => {
  const f = await fixture(t); await f.service.configure(operating()); const quote = await f.service.quote(cart); const prepared = await f.service.prepare(quote.quoteId, pickup); const token = prepared.confirmation!.lookupToken;
  await f.service.submit(quote.quoteId, 'fake-card-token-not-stored');
  await f.db.query("UPDATE catalog_products SET name='New unrelated item name' WHERE id='security-item'");
  const receipt = await f.service.lookup(token); const output = JSON.stringify(receipt);
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.lines[0]?.name, 'Original public item'); assert.equal(receipt.lines[0]?.quantity, 1);
  assert.equal(receipt.merchant?.branding.name, 'Public shop'); assert.equal(receipt.pickupAt, quote.pickupAt);
  for (const secret of [pickup.name, pickup.email, pickup.phone, quote.checkoutToken, token, 'fake-card-token-not-stored', values.SQUARE_SANDBOX_ACCESS_TOKEN]) assert.ok(!output.includes(secret), 'Sensitive value unexpectedly disclosed');
  assert.doesNotMatch(output, /customer_lookup_hash|checkout_token_hash|password_digest|New unrelated item name/);
});
test('HTTP public writes reject UUID-only and receipt-token requests without cancel or payment effects', async t => {
  const f = await fixture(t); const quote = await f.service.quote(cart); const prepared = await f.service.prepare(quote.quoteId, pickup); const lookupToken = prepared.confirmation!.lookupToken;
  const auth: MerchantStaffAuth = { origin: values.PUBLIC_ORIGIN, verifyStaff: async () => null, login: async () => { throw new Error('Not used'); }, logout: async () => {} };
  const app = createMerchantCommerceApp(f.db, values, auth, merchant, f.transport);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function send(path: string, body: unknown) { return fetch(url + '/api/commerce/' + path, { method: 'POST', headers: { Origin: values.PUBLIC_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  for (const path of ['prepare', 'submit', 'status', 'cancel']) {
    const body = path === 'prepare' ? { quoteId: quote.quoteId, pickup } : path === 'submit' ? { attemptId: quote.quoteId, cardToken: 'fake-token' } : { attemptId: quote.quoteId };
    assert.equal((await send(path, body)).status, 400);
    assert.equal((await send(path, { ...body, checkoutToken: lookupToken })).status, 404);
  }
  assert.equal((await send('lookup', { token: lookupToken })).status, 200);
  assert.equal((await send('status', { attemptId: quote.quoteId, checkoutToken: quote.checkoutToken })).status, 200);
  assert.equal((await f.service.status(quote.quoteId)).state, 'reserved'); assert.equal(await stock(f.db), 9);
  assert.equal(f.calls.filter(path => path === '/v2/payments').length, 0);
});
test('production activation remains closed until operating configuration and website allocation are reviewed', async t => {
  const f = await fixture(t); await f.service.activate(false);
  const production = new MerchantCommerce(f.db, f.provider, { ...context, environment: 'production' });
  await assert.rejects(production.activate(true), error => error instanceof CommerceError && error.code === 'MERCHANT_NOT_READY');
  await production.configure(operating(false));
  await assert.rejects(production.activate(true), error => error instanceof CommerceError && error.code === 'MERCHANT_NOT_READY');
  await production.configure(operating()); await production.activate(true);
  assert.equal((await production.readiness()).ready, true);
  await production.configure({ ...operating(), inventory: { authority: 'square-pos', allocationReviewed: true } });
  await assert.rejects(production.activate(true), error => error instanceof CommerceError && error.code === 'MERCHANT_NOT_READY');
  assert.equal((await f.db.query<{ enabled: boolean }>('SELECT enabled FROM merchant_commerce_config')).rows[0]?.enabled, false);
});
