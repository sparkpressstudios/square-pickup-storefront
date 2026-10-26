import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { initializeEmptyMerchantCatalog } from '../server/src/merchant-catalog-import';
import { initializeMerchantCommerce } from '../db/merchant-commerce';
import { MerchantCommerce, merchantCommerceBridge, CommerceError } from '../server/src/merchant-commerce';
import { MerchantSquareProvider } from '../server/src/merchant-square-provider';
import { sandboxConfiguration } from '../server/src/square-sandbox';
import { SandboxWebhookProjector, type SandboxWebhookConfig } from '../server/src/square-webhooks';
const values = { STARTER_DATASET: 'merchant-catalog-v1', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-commerce-test', SQUARE_LOCATION_ID: 'TESTLOCATION', SQUARE_SANDBOX_MERCHANT_ID: 'TESTMERCHANT', SQUARE_SANDBOX_ACCESS_TOKEN: 'unit-commerce-private-token', SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', SQUARE_MERCHANT_COMMERCE_ENABLED: 'true' };
const context = { merchantId: values.SQUARE_SANDBOX_MERCHANT_ID, locationId: values.SQUARE_LOCATION_ID };
const webhookConfig: SandboxWebhookConfig = { ...context, environment: 'sandbox', signatureKey: 'unit-commerce-signing-key', notificationUrl: 'https://merchant.example.invalid/api/merchant-commerce/webhooks' };
const pickup = { name: 'Unit Shopper', email: 'shopper@example.invalid', phone: '+12025550100' };
const cart = { currency: 'USD', fulfillment: 'pickup', items: [{ productId: 'item', variantId: 'item-regular', quantity: 1 }] };
const money = (amount: number) => ({ amount, currency: 'USD' });
const errorCode = (code: string) => (error: unknown) => error instanceof CommerceError && error.code === code;
function providerFixture() {
  const providerOrders=new Map<string,any>();
  const requests: { path: string; body: any }[] = []; let unknownPayment = false; let unknownOrder = false; let paymentStatus = 'COMPLETED'; let changedOrder = false; let paymentFound = true; let unknownRefund = false; let refundStatus = 200; let beforeRefundResponse: ((body: any) => Promise<void>) | undefined;
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if(init?.method==='GET'&&path.startsWith('/v2/orders/')){requests.push({path,body:null});return new Response(JSON.stringify({order:providerOrders.get(path.split('/').at(-1)!)}));}
    if (init?.method === 'GET') {
      const submitted = [...requests].reverse().find(request => request.path === '/v2/payments' && request.body !== null)?.body;
      requests.push({ path, body: null });
      return new Response(JSON.stringify({ payments: paymentFound && submitted ? [{ ...submitted, id: 'PAYMENT_' + submitted.reference_id, status: 'COMPLETED' }] : [] }));
    }
    const body = JSON.parse(String(init?.body)); requests.push({ path, body });
    if (path === '/v2/orders' && unknownOrder) throw new Error('order response lost');
    if (path === '/v2/payments' && unknownPayment) throw new Error('response lost after provider may have accepted payment');
    if (path === '/v2/refunds' && unknownRefund) throw new Error('response lost after provider may have accepted refund');
    if (path === '/v2/refunds' && refundStatus !== 200) return new Response('{}', { status: refundStatus });
    if(init?.method==='PUT'){const id=path.split('/').at(-1)!,prior=providerOrders.get(id);const updated={...prior,version:prior.version+1,fulfillments:body.order.fulfillments,state:body.order.fulfillments[0].state==='COMPLETED'?'COMPLETED':'OPEN'};providerOrders.set(id,updated);return new Response(JSON.stringify({order:updated}));}
    if (path.startsWith('/v2/orders')) {
      const qty = Number(body.order.line_items[0].quantity); const subtotal = 1000 * qty; const discount = 100 * qty; const tax = 90 * qty + (changedOrder && path === '/v2/orders' ? 10 : 0); const total = subtotal - discount + tax;
      const responseOrder={ ...body.order, version:1,state:'OPEN',...(body.order.fulfillments?{fulfillments:body.order.fulfillments.map((f:any)=>({...f,uid:'PICKUP_'+body.order.reference_id}))}:{}), id: path.endsWith('/calculate') ? undefined : 'ORDER_' + body.order.reference_id,
        line_items: body.order.line_items.map((line: any) => ({ ...line, base_price_money: money(1000), gross_sales_money: money(subtotal), total_discount_money: money(discount), total_tax_money: money(tax), total_money: money(total) })),
        total_discount_money: money(discount), total_tax_money: money(tax), total_money: money(total) };if(responseOrder.id)providerOrders.set(responseOrder.id,responseOrder);return new Response(JSON.stringify({order:responseOrder}));
    }
    if (path === '/v2/payments') return new Response(JSON.stringify({ payment: { ...body, id: 'PAYMENT_' + body.reference_id, status: paymentStatus } }));
    await beforeRefundResponse?.(body);
    return new Response(JSON.stringify({ refund: { id: 'REFUND_' + body.idempotency_key, payment_id: body.payment_id, location_id: context.locationId, amount_money: body.amount_money, status: 'PENDING' } }));
  };
  return { requests, create(db: PGlite) { return new MerchantCommerce(db, new MerchantSquareProvider(sandboxConfiguration(values), transport), context); }, setUnknownPayment(value: boolean) { unknownPayment = value; }, setUnknownOrder(value: boolean) { unknownOrder = value; }, setChangedOrder(value: boolean) { changedOrder = value; }, setPaymentStatus(value: string) { paymentStatus = value; }, setPaymentFound(value: boolean) { paymentFound = value; }, setUnknownRefund(value: boolean) { unknownRefund = value; }, setRefundStatus(value: number) { refundStatus = value; }, setBeforeRefundResponse(callback: (body: any) => Promise<void>) { beforeRefundResponse = callback; } };
}
async function initialize(db: PGlite, stock = 3) {
  await initializeEmptyMerchantCatalog(db, { squareMerchantId: context.merchantId, squareLocationId: context.locationId });
  // Equivalent to a reviewed disabled import; no synthetic demo data is introduced.
  await db.exec("UPDATE merchant_catalog_identity SET inventory_owner='website'; INSERT INTO catalog_products(id,name,description,category,options) VALUES('item','Unit item','Synthetic test description','Tests','[]'); INSERT INTO catalog_variants(id,product_id,sku,selections,price_minor) VALUES('item-regular','item','UNIT-SKU','{}',1000); INSERT INTO merchant_square_item_links(square_item_id,product_id) VALUES('SQUARE_ITEM','item'); INSERT INTO merchant_square_variation_links(square_variation_id,variant_id,square_item_id) VALUES('SQUARE_VARIANT','item-regular','SQUARE_ITEM');");
  await initializeMerchantCommerce(db, values); await initializeMerchantCommerce(db, values);
  const service = providerFixture().create(db);
  await service.updateInventory({ variantId: 'item-regular', quantity: stock, enabled: true, revision: 0 }); await service.activate(true);
}
async function stock(db: PGlite) { return (await db.query<{ stock_quantity: number }>("SELECT stock_quantity FROM merchant_commerce_inventory WHERE variant_id='item-regular'")).rows[0]!.stock_quantity; }
async function reservation(db: PGlite, id: string) { return (await db.query<{ state: string }>('SELECT state FROM merchant_commerce_reservations WHERE attempt_id=$1', [id])).rows[0]!.state; }
function event(kind: 'payment' | 'refund', id: string, overrides: Record<string, unknown> = {}) {
  const paymentId = 'PAYMENT_' + id;
  const resource = { id: kind === 'payment' ? paymentId : 'REFUND_TEST', ...(kind === 'refund' ? { payment_id: paymentId } : {}), location_id: context.locationId, order_id: 'ORDER_' + id, reference_id: id, status: 'COMPLETED', amount_money: money(kind === 'payment' ? 990 : 500), updated_at: '2026-10-25T14:00:00.000Z', ...overrides };
  return Buffer.from(JSON.stringify({ event_id: randomUUID(), merchant_id: context.merchantId, type: kind + '.updated', data: { type: kind, id: resource.id, object: { [kind]: resource } } }));
}
function projector(db: PGlite) {
  const target = new SandboxWebhookProjector(db, webhookConfig, merchantCommerceBridge(context));
  return { target, handle(raw: Buffer) { return target.handle(raw, createHmac('sha256', webhookConfig.signatureKey).update(webhookConfig.notificationUrl).update(raw).digest('base64')); } };
}

test('merchant quote, preparation and payment persist through actual database close/reopen without synthetic adoption', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merchant-commerce-')); const path = join(directory, 'pgdata');
  let db = await PGlite.create(path); t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); }); await initialize(db);
  const mock = providerFixture(); let service = mock.create(db); const quote = await service.quote(cart);
  assert.deepEqual([quote.subtotalMinor, quote.discountMinor, quote.taxMinor, quote.totalMinor], [1000, 100, 90, 990]);
  await db.close(); db = await PGlite.create(path); service = mock.create(db); await service.prepare(quote.quoteId, pickup);
  assert.equal(await stock(db), 2); assert.equal(await reservation(db, quote.quoteId), 'held');
  await db.close(); db = await PGlite.create(path); service = mock.create(db);
  const paid = await service.submit(quote.quoteId, 'unit-card-token'); assert.equal(paid.state, 'completed'); assert.equal(paid.fulfillmentAuthorized, false);
  await service.prepare(quote.quoteId, pickup); await service.submit(quote.quoteId, 'unit-card-token');
  assert.equal(mock.requests.filter(r => r.path === '/v2/orders').length, 1); assert.equal(mock.requests.filter(r => r.path === '/v2/payments').length, 1);
  assert.equal(await reservation(db, quote.quoteId), 'committed'); assert.equal(await stock(db), 2);
  const raw = await db.query('SELECT * FROM merchant_commerce_attempts'); assert.doesNotMatch(JSON.stringify(raw.rows), /unit-card-token|private-token/);
  assert.equal((await db.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('demo_database_state','checkout_attempts','mock_payment_ledger')")).rows.length, 0);
});
test('concurrent submissions claim one order and payment, while concurrent final-stock reservations admit one shopper', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db, 1); const mock = providerFixture(); const service = mock.create(db);
  const [q1, q2] = await Promise.all([service.quote(cart), service.quote(cart)]);
  const prepared = await Promise.allSettled([service.prepare(q1.quoteId, pickup), service.prepare(q2.quoteId, pickup)]);
  assert.equal(prepared.filter(p => p.status === 'fulfilled').length, 1); assert.equal(await stock(db), 0);
  const id = prepared[0]!.status === 'fulfilled' ? q1.quoteId : q2.quoteId;
  await Promise.all([service.submit(id, 'token'), service.submit(id, 'token'), mock.create(db).submit(id, 'token')]);
  assert.equal((await service.status(id)).state, 'completed'); assert.equal(mock.requests.filter(r => r.path === '/v2/orders').length, 1); assert.equal(mock.requests.filter(r => r.path === '/v2/payments').length, 1);
});
test('expired unprepared quotes refuse reservation, expired reservations release stock without order or payment calls', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db);
  const q1 = await service.quote(cart); await db.query("UPDATE merchant_commerce_quotes SET expires_at=now()-interval '1 second' WHERE id=$1", [q1.quoteId]);
  await assert.rejects(service.prepare(q1.quoteId, pickup), errorCode('QUOTE_EXPIRED')); assert.equal(await stock(db), 3);
  const q2 = await service.quote(cart); await service.prepare(q2.quoteId, pickup); await db.query("UPDATE merchant_commerce_quotes SET expires_at=now()-interval '1 second' WHERE id=$1", [q2.quoteId]);
  const result = await service.submit(q2.quoteId, 'token'); assert.equal(result.state, 'failed'); assert.equal(result.failureCode, 'QUOTE_EXPIRED');
  assert.equal(await stock(db), 3); assert.equal(await reservation(db, q2.quoteId), 'released'); assert.equal(mock.requests.filter(r => r.path !== '/v2/orders/calculate').length, 0);
});
test('unknown payment retains stock and identity; signed webhook recovers it, deduplicates and rejects bad signatures', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup); mock.setUnknownPayment(true);
  const unknown = await service.submit(quote.quoteId, 'token'); assert.equal(unknown.state, 'review'); assert.equal(unknown.requiresReconciliation, true); assert.equal(await reservation(db, quote.quoteId), 'held');
  await mock.create(db).submit(quote.quoteId, 'token'); await service.cancel(quote.quoteId); assert.equal(mock.requests.filter(r => r.path === '/v2/payments').length, 1); assert.equal(await stock(db), 2);
  const webhook = projector(db); const raw = event('payment', quote.quoteId);
  await assert.rejects(webhook.target.handle(raw, 'wrong')); assert.equal((await service.status(quote.quoteId)).state, 'review');
  assert.equal((await webhook.handle(raw)).outcome, 'applied'); assert.equal((await webhook.handle(raw)).outcome, 'duplicate');
  assert.equal((await service.status(quote.quoteId)).state, 'completed'); assert.equal(await reservation(db, quote.quoteId), 'committed'); assert.equal(await stock(db), 2);
  assert.equal((await webhook.handle(event('payment', quote.quoteId, { status: 'PENDING', updated_at: '2026-10-25T15:00:00.000Z' }))).outcome, 'ignored'); assert.equal((await service.status(quote.quoteId)).state, 'completed');
});
test('pending and unknown refunds reserve financial liability without restocking; signed completion counts once', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup); await service.submit(quote.quoteId, 'token');
  const refundId = randomUUID(); const refund = await service.refund(quote.quoteId, refundId, 600, 'merchant-admin'); assert.equal(refund!.state, 'pending');
  await service.refund(quote.quoteId, refundId, 600, 'merchant-admin'); assert.equal(mock.requests.filter(r => r.path === '/v2/refunds').length, 1);
  await assert.rejects(service.refund(quote.quoteId, randomUUID(), 391, 'merchant-admin'), errorCode('REFUND_EXCEEDS_BALANCE')); assert.equal(await stock(db), 2);
  const webhook = projector(db); const raw = event('refund', quote.quoteId, { id: refund!.refund_id, amount_money: money(600) });
  assert.equal((await webhook.handle(raw)).outcome, 'applied'); assert.equal((await webhook.handle(raw)).outcome, 'duplicate'); assert.equal((await service.status(quote.quoteId)).refundedMinor, 600);
  mock.setUnknownRefund(true); const unknownId = randomUUID(); assert.equal((await service.refund(quote.quoteId, unknownId, 390, 'merchant-admin'))!.state, 'review');
  await assert.rejects(service.refund(quote.quoteId, randomUUID(), 1, 'merchant-admin'), errorCode('REFUND_EXCEEDS_BALANCE')); await service.refund(quote.quoteId, unknownId, 390, 'merchant-admin');
  assert.equal(mock.requests.filter(r => r.path === '/v2/refunds').length, 2); assert.equal(await stock(db), 2); assert.equal(await reservation(db, quote.quoteId), 'committed');
});
test('signed refund completion arriving before HTTP response remains completed in staff history', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup); await service.submit(quote.quoteId, 'token');
  const webhook = projector(db);
  mock.setBeforeRefundResponse(async body => { await webhook.handle(event('refund', quote.quoteId, { id: 'REFUND_' + body.idempotency_key, amount_money: body.amount_money })); });
  const refund = await service.refund(quote.quoteId, randomUUID(), 600, 'merchant-admin');
  assert.equal((await service.status(quote.quoteId)).refundedMinor, 600);
  assert.equal(refund!.state, 'completed');
  assert.equal(await stock(db), 2);
});
test('cancel is idempotent and cannot release paid or unknown stock, while pickup identity is immutable', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup);
  await assert.rejects(service.prepare(quote.quoteId, { ...pickup, name: 'Different shopper' }), errorCode('ATTEMPT_CHANGED'));
  await service.cancel(quote.quoteId); await service.cancel(quote.quoteId); assert.equal(await stock(db), 3);
  assert.equal((await service.submit(quote.quoteId, 'token')).state, 'failed'); assert.equal(mock.requests.filter(r => r.path !== '/v2/orders/calculate').length, 0);
  const paidQuote = await service.quote(cart); await service.prepare(paidQuote.quoteId, pickup); await service.submit(paidQuote.quoteId, 'token'); await service.cancel(paidQuote.quoteId); assert.equal(await stock(db), 2); assert.equal((await service.status(paidQuote.quoteId)).state, 'completed');
});
test('pending refund blocks fulfillment and completed pickup cannot regress to ready', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db);
  const q1 = await service.quote(cart); await service.prepare(q1.quoteId, pickup); await service.submit(q1.quoteId, 'token'); await service.refund(q1.quoteId, randomUUID(), 990, 'merchant-admin');
  await assert.rejects(service.fulfill(q1.quoteId, 'ready'));
  const q2 = await service.quote(cart); await service.prepare(q2.quoteId, pickup); await service.submit(q2.quoteId, 'token');
  await assert.rejects(service.fulfill(q2.quoteId, 'picked_up'));
  await service.fulfill(q2.quoteId, 'ready'); await service.fulfill(q2.quoteId, 'picked_up'); await assert.rejects(service.fulfill(q2.quoteId, 'ready'));
  assert.equal((await service.status(q2.quoteId)).fulfillmentAuthorized, false);
});
test('catalog/status expiry releases only undispatched reservations, not sending or unknown holds', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db, 5); const mock = providerFixture(); const service = mock.create(db);
  const quotes = await Promise.all([service.quote(cart), service.quote(cart), service.quote(cart)]);
  for (const q of quotes) await service.prepare(q.quoteId, pickup);
  await db.query("UPDATE merchant_commerce_attempts SET state='order_sending' WHERE id=$1", [quotes[1]!.quoteId]);
  await db.query("UPDATE merchant_commerce_attempts SET state='review',failure_code='UNKNOWN_OUTCOME' WHERE id=$1", [quotes[2]!.quoteId]);
  await db.query("UPDATE merchant_commerce_quotes SET expires_at=now()-interval '1 second'");
  await service.catalog(); await service.status(quotes[0]!.quoteId); await service.catalog();
  assert.equal(await stock(db), 3); assert.equal(await reservation(db, quotes[0]!.quoteId), 'released');
  for (const q of quotes.slice(1)) assert.equal(await reservation(db, q.quoteId), 'held');
  assert.equal(mock.requests.filter(r => r.path !== '/v2/orders/calculate').length, 0);
});
test('explicit unknown order recovery replays the original order key, not a new payment or reservation', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup);
  mock.setUnknownOrder(true); assert.equal((await service.submit(quote.quoteId, 'token')).state, 'review');
  mock.setUnknownOrder(false); assert.equal((await service.recover(quote.quoteId)).state, 'order_ready');
  const calls = mock.requests.filter(r => r.path === '/v2/orders'); assert.equal(calls.length, 2); assert.equal(calls[0]!.body.idempotency_key, calls[1]!.body.idempotency_key); assert.deepEqual(calls[0]!.body, calls[1]!.body);
  assert.equal(mock.requests.filter(r => r.path === '/v2/payments').length, 0); assert.equal(await stock(db), 2);
  assert.equal((await service.submit(quote.quoteId, 'token')).state, 'completed');
  const next = await service.quote(cart); await service.prepare(next.quoteId, pickup); await db.query("UPDATE merchant_commerce_attempts SET state='order_sending' WHERE id=$1", [next.quoteId]);
  await service.recover(next.quoteId); assert.equal(mock.requests.filter(r => r.path === '/v2/orders').length, 2);
  await db.query("UPDATE merchant_commerce_attempts SET updated_at=now()-interval '31 seconds' WHERE id=$1", [next.quoteId]);
  assert.equal((await service.recover(next.quoteId)).state, 'order_ready'); assert.equal(mock.requests.filter(r => r.path === '/v2/orders').length, 3);
});
test('read-only payment recovery leaves not-yet-visible liability held, then recovers without a second charge', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup);
  mock.setUnknownPayment(true); await service.submit(quote.quoteId, 'token'); mock.setPaymentFound(false);
  assert.equal((await service.recover(quote.quoteId)).state, 'review'); assert.equal(await reservation(db, quote.quoteId), 'held');
  mock.setPaymentFound(true); assert.equal((await mock.create(db).recover(quote.quoteId)).state, 'completed'); assert.equal(await reservation(db, quote.quoteId), 'committed');
  assert.equal(mock.requests.filter(r => r.path === '/v2/payments' && r.body !== null).length, 1); assert.equal(mock.requests.filter(r => r.path === '/v2/payments' && r.body === null).length, 2); assert.equal(await stock(db), 2);
});
test('explicit unknown refund recovery reuses original key and amount while ordinary refund replay does not dispatch', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup); await service.submit(quote.quoteId, 'token');
  mock.setUnknownRefund(true); const id = randomUUID(); assert.equal((await service.refund(quote.quoteId, id, 500, 'merchant-admin'))!.state, 'review');
  await service.refund(quote.quoteId, id, 500, 'merchant-admin'); assert.equal(mock.requests.filter(r => r.path === '/v2/refunds').length, 1);
  mock.setUnknownRefund(false); assert.equal((await service.recoverRefund(id, 'merchant-admin'))!.state, 'pending');
  const calls = mock.requests.filter(r => r.path === '/v2/refunds'); assert.equal(calls.length, 2); assert.deepEqual(calls[0]!.body, calls[1]!.body); assert.equal(await stock(db), 2);
});
test('external pending refunds prevent overspending or fulfillment until their terminal result is known', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup); await service.submit(quote.quoteId, 'token');
  const webhook = projector(db); await webhook.handle(event('refund', quote.quoteId, { id: 'EXTERNAL_REFUND', amount_money: money(600), status: 'PENDING' }));
  await assert.rejects(service.refund(quote.quoteId, randomUUID(), 391, 'merchant-admin'), errorCode('REFUND_EXCEEDS_BALANCE'));
  await assert.rejects(service.fulfill(quote.quoteId, 'ready'));
  await webhook.handle(event('refund', quote.quoteId, { id: 'EXTERNAL_REFUND', amount_money: money(600), status: 'FAILED', updated_at: '2026-10-25T15:00:00.000Z' }));
  assert.equal((await service.refund(quote.quoteId, randomUUID(), 990, 'merchant-admin'))!.state, 'pending'); assert.equal(await stock(db), 2);
});
test('persisted quote-rate limit atomically permits only remaining allowance and resets its elapsed window', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db);
  await db.query('UPDATE merchant_commerce_config SET quote_count=59,quote_window=now()');
  const results = await Promise.allSettled([service.quote(cart), mock.create(db).quote(cart)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); const rejected = results.find(r => r.status === 'rejected'); assert.ok(rejected?.status === 'rejected'); assert.equal(rejected.reason.code, 'QUOTE_RATE_LIMITED');
  assert.equal(mock.requests.length, 1); await assert.rejects(service.quote(cart), errorCode('QUOTE_RATE_LIMITED')); assert.equal(mock.requests.length, 1);
  await db.query("UPDATE merchant_commerce_config SET quote_window=now()-interval '61 seconds'"); await service.quote(cart); assert.equal(mock.requests.length, 2);
});
test('read-only recovery advances both checkout and financial projection from pending to completed', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup);
  mock.setPaymentStatus('PENDING'); assert.equal((await service.submit(quote.quoteId, 'token')).state, 'pending');
  assert.equal((await projector(db).target.projection('PAYMENT_' + quote.quoteId))!.classification, 'unconfirmed');
  assert.equal((await service.recover(quote.quoteId)).state, 'completed');
  assert.equal((await projector(db).target.projection('PAYMENT_' + quote.quoteId))!.classification, 'paid');
  assert.equal(mock.requests.filter(r => r.path === '/v2/payments' && r.body !== null).length, 1);
});
test('known order price change records changed order evidence, releases stock and permits a fresh accepted quote without charging', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db, 1); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup);
  mock.setChangedOrder(true); const changed = await service.submit(quote.quoteId, 'token');
  assert.equal(changed.state, 'failed'); assert.equal(changed.failureCode, 'PRICE_CHANGED'); assert.equal(changed.orderId, 'ORDER_' + quote.quoteId);
  const stored = (await db.query<{order_evidence: {totalMinor: number}; payment_id: string | null}>('SELECT order_evidence,payment_id FROM merchant_commerce_attempts WHERE id=$1', [quote.quoteId])).rows[0]!;
  assert.equal(stored.order_evidence.totalMinor, 1000); assert.equal(stored.payment_id, null);
  assert.equal(await stock(db), 1); assert.equal(await reservation(db, quote.quoteId), 'released'); assert.equal(mock.requests.filter(r => r.path === '/v2/payments').length, 0);
  await service.submit(quote.quoteId, 'token'); assert.equal(mock.requests.filter(r => r.path === '/v2/orders').length, 1);
  mock.setChangedOrder(false); const fresh = await service.quote(cart); assert.notEqual(fresh.quoteId, quote.quoteId); await service.prepare(fresh.quoteId, pickup); assert.equal((await service.submit(fresh.quoteId, 'new-token')).state, 'completed');
  assert.equal(mock.requests.filter(r => r.path === '/v2/payments').length, 1); assert.equal(await stock(db), 0);
});
test('merchant commerce migration is repeatable but refuses checksum drift, foreign tables and foreign merchant identity', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const before = (await db.query('SELECT * FROM merchant_catalog_identity')).rows;
  await initializeMerchantCommerce(db, values); assert.deepEqual((await db.query('SELECT * FROM merchant_catalog_identity')).rows, before);
  await assert.rejects(initializeMerchantCommerce(db, { ...values, SQUARE_SANDBOX_MERCHANT_ID: 'FOREIGNMERCHANT' }));
  await db.exec('CREATE TABLE foreign_data(id integer)'); await assert.rejects(initializeMerchantCommerce(db, values));
  await db.exec('DROP TABLE foreign_data'); await db.query("UPDATE merchant_commerce_config SET checksum='unrecognized-schema'"); await assert.rejects(initializeMerchantCommerce(db, values));
  assert.deepEqual((await db.query('SELECT * FROM merchant_catalog_identity')).rows, before);
});
test('authentication failure recovering an unknown refund cannot erase the original charge liability', async t => {
  const db = await PGlite.create(); t.after(() => db.close()); await initialize(db); const mock = providerFixture(); const service = mock.create(db); const quote = await service.quote(cart); await service.prepare(quote.quoteId, pickup); await service.submit(quote.quoteId, 'token');
  const refundId = randomUUID(); mock.setUnknownRefund(true);
  assert.equal((await service.refund(quote.quoteId, refundId, 990, 'merchant-admin'))!.state, 'review');
  mock.setUnknownRefund(false); mock.setRefundStatus(401);
  assert.equal((await service.recoverRefund(refundId, 'merchant-admin'))!.state, 'review');
  await assert.rejects(service.refund(quote.quoteId, randomUUID(), 1, 'merchant-admin'), errorCode('REFUND_EXCEEDS_BALANCE'));
  const calls = mock.requests.filter(r => r.path === '/v2/refunds'); assert.equal(calls.length, 2); assert.deepEqual(calls[0]!.body, calls[1]!.body);
  assert.equal(await stock(db), 2); await assert.rejects(service.fulfill(quote.quoteId, 'ready'));
});
