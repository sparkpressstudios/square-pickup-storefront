import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { initializeEmptyMerchantCatalog, MerchantCatalogImportStore } from '../server/src/merchant-catalog-import';
import { previewSquareMerchantCatalog } from '../server/src/square-catalog-readonly';
import { initializeMerchantCommerce, assertMerchantCommerce } from '../db/merchant-commerce';
import { MerchantCommerce, merchantCommerceBridge } from '../server/src/merchant-commerce';
import { MerchantSquareProvider } from '../server/src/merchant-square-provider';
import { merchantPaymentConfiguration, merchantWebhookConfiguration } from '../server/src/merchant-payment-config';
import { MerchantWebhookProjector } from '../server/src/square-webhooks';
const values = { STARTER_DATASET: 'merchant-catalog-v1', SQUARE_MERCHANT_COMMERCE_ENABLED: 'true', SQUARE_ENVIRONMENT: 'production', SQUARE_PRODUCTION_PAYMENTS_ENABLED: 'true', SQUARE_PRODUCTION_APPLICATION_ID: 'sq0idp-production-flow-test', SQUARE_PRODUCTION_LOCATION_ID: 'FLOWLOCATION', SQUARE_PRODUCTION_MERCHANT_ID: 'FLOWMERCHANT', SQUARE_PRODUCTION_ACCESS_TOKEN: 'injected-flow-production-token', SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY: 'injected-flow-production-signature' };
const money = (amount: number) => ({ amount, currency: 'USD' });
test('injected gated production merchant import, scheduled checkout, signed recovery, pickup and refunds persist in v2', async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  const config = merchantPaymentConfiguration(values);
  const context = { merchantId: config.merchantId, locationId: config.locationId, environment: 'production' as const, applicationId: config.applicationId };
  const identity = { squareMerchantId: context.merchantId, squareLocationId: context.locationId };
  await initializeEmptyMerchantCatalog(db, identity);
  const preview = await previewSquareMerchantCatalog(config, async endpoint => {
    assert.equal(new URL(String(endpoint)).origin, 'https://connect.squareup.com');
    return Response.json({ objects: [{ type: 'ITEM', id: 'FLOWITEM', present_at_all_locations: true, item_data: { name: 'Fictional flow item', tax_ids: ['FLOWTAX'], variations: [{ type: 'ITEM_VARIATION', id: 'FLOWVAR', present_at_all_locations: true, item_variation_data: { name: 'Regular', sku: 'FLOW-SKU', pricing_type: 'FIXED_PRICING', price_money: money(1000) } }] } }] });
  }, { taxTreatment: 'square-order-authoritative', environment: 'production' });
  const importer = new MerchantCatalogImportStore(db, { taxTreatment: 'square-order-authoritative', environment: 'production' });
  const stage = await importer.stage(preview, identity, 'website'); await importer.commit(stage.fingerprint, identity, 'flow-admin', 'approve-disabled-merchant-import-v1');
  await assert.rejects(initializeMerchantCommerce(db, { ...values, SQUARE_PRODUCTION_PAYMENTS_ENABLED: 'false' }));
  assert.equal((await db.query("SELECT table_name FROM information_schema.tables WHERE table_name='merchant_commerce_config'")).rows.length, 0);
  await initializeMerchantCommerce(db, values); await assertMerchantCommerce(db, values);
  await assert.rejects(assertMerchantCommerce(db, { ...values, SQUARE_PRODUCTION_APPLICATION_ID: 'sq0idp-another-app' }));
  await db.query("UPDATE merchant_commerce_config SET environment='sandbox'");
  await assert.rejects(assertMerchantCommerce(db, values));
  await db.query("UPDATE merchant_commerce_config SET environment='production'");
  const requests: { path: string; body: any }[] = []; const orders = new Map<string, any>(); let unknownPayment = false;
  let holdPut: (() => Promise<Response>) | undefined;
  let holdGet: ((snapshot: any) => Promise<Response>) | undefined;
  const transport: typeof fetch = async (endpoint, init) => {
    const url = new URL(String(endpoint)); assert.equal(url.origin, 'https://connect.squareup.com');
    const body = init?.body ? JSON.parse(String(init.body)) : null; requests.push({ path: url.pathname, body });
    if (init?.method === 'GET') { const snapshot = structuredClone(orders.get(url.pathname.split('/').at(-1)!)); const hook = holdGet; holdGet = undefined; return hook ? hook(snapshot) : Response.json({ order: snapshot }); }
    if (init?.method === 'PUT') {
      if (holdPut) { const hook = holdPut; holdPut = undefined; return hook(); }
      const id = url.pathname.split('/').at(-1)!; const prior = orders.get(id);
      const result = { ...prior, version: prior.version + 1, fulfillments: body.order.fulfillments, state: body.order.fulfillments[0].state === 'COMPLETED' ? 'COMPLETED' : 'OPEN' }; orders.set(id, result); return Response.json({ order: result });
    }
    if (url.pathname.startsWith('/v2/orders')) {
      const result = { ...body.order, id: 'ORDER_' + body.order.reference_id, version: 1, state: 'OPEN',
        ...(body.order.fulfillments ? { fulfillments: body.order.fulfillments.map((f: any) => ({ ...f, uid: 'PICKUP_' + body.order.reference_id })) } : {}),
        line_items: body.order.line_items.map((l: any) => ({ ...l, base_price_money: money(1000), gross_sales_money: money(1000), total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) })),
        total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) };
      if (url.pathname === '/v2/orders') orders.set(result.id, result); return Response.json({ order: result });
    }
    if (url.pathname === '/v2/payments') {
      assert.equal(Object.hasOwn(body, 'buyer_email_address'), false);
      if (unknownPayment) throw new Error('Injected lost production response; no network');
      return Response.json({ payment: { ...body, id: 'PAYMENT_' + body.reference_id, status: 'COMPLETED', receipt_url: 'https://squareup.com/receipt/preview/flow-test' } });
    }
    assert.equal(url.pathname, '/v2/refunds');
    return Response.json({ refund: { id: 'REFUND_' + body.idempotency_key, payment_id: body.payment_id, location_id: config.locationId, amount_money: body.amount_money, status: 'PENDING' } });
  };
  const service = new MerchantCommerce(db, new MerchantSquareProvider(config, transport), context);
  const item = (await service.catalog()).products[0]!, variant = item.variants[0]!;
  await service.updateInventory({ variantId: variant.id, quantity: 10, enabled: true, revision: 0 });
  await assert.rejects(service.activate(true));
  await service.configure({ reviewed: true, branding: { name: 'Flow Test Shop', tagline: 'Fictional tests', accentColor: '#A1AB74', backgroundColor: '#F9F8F4' }, support: { email: 'support@example.com', url: 'https://example.com/help' }, policies: { termsUrl: 'https://example.com/terms', privacyUrl: 'https://example.com/privacy', refundUrl: 'https://example.com/refunds' }, inventory: { authority: 'website-allocation', allocationReviewed: true }, pickup: { timeZone: 'UTC', leadMinutes: 15, weeklyHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, opens: '00:00', closes: '24:00' })), blackoutDates: [] } });
  await service.activate(true);
  const cart = { currency: 'USD', fulfillment: 'pickup', items: [{ productId: item.id, variantId: variant.id, quantity: 1 }] };
  const pickup = { name: 'Private Shopper Canary', email: 'private-canary@example.invalid', phone: '+12025550100' };
  const q = await service.quote(cart); assert.ok(q.pickupAt); assert.equal(q.totalMinor, 990);
  const prepared = await service.prepare(q.quoteId, pickup); assert.ok(prepared.confirmation);
  assert.equal((await service.submit(q.quoteId, 'injected-card-token')).state, 'completed');
  const created = requests.find(r => r.path === '/v2/orders')!.body.order;
  assert.equal(created.fulfillments[0].pickup_details.schedule_type, 'SCHEDULED'); assert.equal(created.fulfillments[0].pickup_details.pickup_at, q.pickupAt);
  assert.equal((await service.fulfill(q.quoteId, 'ready')).fulfillmentState, 'ready');
  assert.equal((await service.fulfill(q.quoteId, 'picked_up')).fulfillmentState, 'picked_up');
  const reopened = new MerchantCommerce(db, new MerchantSquareProvider(config, transport), context);
  const receipt = await reopened.lookup(prepared.confirmation!.lookupToken); assert.equal(receipt.state, 'completed'); assert.equal(receipt.mode, 'merchant-production');
  assert.doesNotMatch(JSON.stringify(receipt), /Private Shopper Canary|private-canary|12025550100|injected-card-token|production-token|signature/);
  await assert.rejects(reopened.lookup(q.quoteId));
  unknownPayment = true;
  const second = await reopened.quote(cart); await reopened.prepare(second.quoteId, pickup); assert.equal((await reopened.submit(second.quoteId, 'another-token')).state, 'review');
  const webhook = merchantWebhookConfiguration(config, 'https://example.com/api/merchant-commerce/webhooks');
  const projector = new MerchantWebhookProjector(db, webhook, merchantCommerceBridge(context));
  const event = (kind: 'payment' | 'refund', resourceId: string, amount: number) => Buffer.from(JSON.stringify({ event_id: randomUUID(), merchant_id: config.merchantId, type: kind + '.updated', data: { type: kind, id: resourceId, object: { [kind]: { id: resourceId, payment_id: 'PAYMENT_' + second.quoteId, order_id: 'ORDER_' + second.quoteId, reference_id: second.quoteId, location_id: config.locationId, status: 'COMPLETED', amount_money: money(amount), updated_at: new Date().toISOString() } } } }));
  const handle = (raw: Buffer) => projector.handle(raw, createHmac('sha256', config.webhookSignatureKey).update(webhook.notificationUrl).update(raw).digest('base64'));
  const paid = event('payment', 'PAYMENT_' + second.quoteId, 990); assert.equal((await handle(paid)).outcome, 'applied'); assert.equal((await handle(paid)).outcome, 'duplicate'); assert.equal((await reopened.status(second.quoteId)).state, 'completed');
  const evidence = (await db.query<{ payment_evidence: any }>('SELECT payment_evidence FROM merchant_commerce_attempts WHERE id=$1', [second.quoteId])).rows[0]!.payment_evidence;
  assert.equal(evidence.environment, 'production'); assert.equal(evidence.applicationId, config.applicationId); assert.equal(evidence.merchantId, config.merchantId);
  const refundId = randomUUID(); await reopened.refund(second.quoteId, refundId, 400, 'flow-admin');
  assert.equal((await reopened.status(second.quoteId)).requiresReconciliation, true);
  await handle(event('refund', 'REFUND_ref_' + refundId, 400)); assert.equal((await reopened.status(second.quoteId)).refundedMinor, 400);
  assert.equal((await db.query<{ stock_quantity: number }>('SELECT stock_quantity FROM merchant_commerce_inventory')).rows[0]!.stock_quantity, 8);
  unknownPayment = false;
  await t.test('expired order-ready quote or pickup never sends a first card payment and releases stock', async () => {
    for (const expiry of ['quote', 'pickup']) {
      const quote = await reopened.quote(cart); await reopened.prepare(quote.quoteId, pickup);
      const row = (await db.query<{pricing: any}>('SELECT pricing FROM merchant_commerce_quotes WHERE id=$1', [quote.quoteId])).rows[0]!;
      const order = await new MerchantSquareProvider(config, transport).createOrder(row.pricing, { ...pickup, promisedAt: quote.pickupAt });
      await db.query("UPDATE merchant_commerce_attempts SET state='order_ready',order_id=$2,order_evidence=$3::jsonb WHERE id=$1", [quote.quoteId, order.id, JSON.stringify(order)]);
      await db.query(expiry === 'quote' ? "UPDATE merchant_commerce_quotes SET expires_at=now()-interval '1 second' WHERE id=$1" : "UPDATE merchant_commerce_quotes SET pickup_at=now()-interval '1 second' WHERE id=$1", [quote.quoteId]);
      const payments = requests.filter(r => r.path === '/v2/payments').length;
      assert.equal((await reopened.submit(quote.quoteId, 'must-not-dispatch')).state, 'failed');
      assert.equal(requests.filter(r => r.path === '/v2/payments').length, payments);
      assert.equal((await db.query<{state:string}>('SELECT state FROM merchant_commerce_reservations WHERE attempt_id=$1', [quote.quoteId])).rows[0]!.state, 'released');
    }
  });
  await t.test('stale fulfillment claimant cannot overwrite recovered completion or regress picked-up', async () => {
    const quote = await reopened.quote(cart); await reopened.prepare(quote.quoteId, pickup); await reopened.submit(quote.quoteId, 'race-card');
    let entered!: () => void, rejectStale!: (error: Error) => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    holdPut = () => { entered(); return new Promise<Response>((_resolve, reject) => { rejectStale = reject; }); };
    const stale = reopened.fulfill(quote.quoteId, 'ready'); await enteredPromise;
    const initial = (await db.query<{claim_token:string}>('SELECT claim_token FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1', [quote.quoteId])).rows[0]!;
    await db.query("UPDATE merchant_commerce_fulfillment_requests SET updated_at=now()-interval '1 minute' WHERE attempt_id=$1", [quote.quoteId]);
    assert.equal((await reopened.recoverFulfillment(quote.quoteId, 'flow-admin')).fulfillmentState, 'ready');
    const recovered = (await db.query<{claim_token:string;state:string}>('SELECT claim_token,state FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1', [quote.quoteId])).rows[0]!;
    assert.notEqual(initial.claim_token, recovered.claim_token); assert.equal(recovered.state, 'completed');
    await reopened.fulfill(quote.quoteId, 'picked_up'); rejectStale(new Error('Late original transport failure'));
    assert.equal((await stale).fulfillmentState, 'picked_up');
    assert.ok((await db.query<{state:string}>('SELECT state FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1', [quote.quoteId])).rows.every(r => r.state === 'completed'));
  });
  await t.test('stale read-confirmed ready snapshot cannot regress a later completed pickup', async () => {
    const quote = await reopened.quote(cart); await reopened.prepare(quote.quoteId, pickup); await reopened.submit(quote.quoteId, 'snapshot-card');
    const order = orders.get('ORDER_' + quote.quoteId); order.fulfillments[0].state = 'PREPARED'; order.version++;
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    holdGet = snapshot => { entered(); return new Promise<Response>(resolve => { release = () => resolve(Response.json({ order: snapshot })); }); };
    const stale = reopened.fulfill(quote.quoteId, 'ready'); await enteredPromise;
    await reopened.fulfill(quote.quoteId, 'ready'); await reopened.fulfill(quote.quoteId, 'picked_up');
    release(); assert.equal((await stale).fulfillmentState, 'picked_up');
  });
  const count = requests.length; assert.throws(() => merchantPaymentConfiguration({ ...values, SQUARE_PRODUCTION_PAYMENTS_ENABLED: 'false' })); assert.equal(requests.length, count);
});
