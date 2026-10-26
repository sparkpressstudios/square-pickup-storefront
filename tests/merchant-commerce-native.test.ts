import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { NativeSqlDatabase } from '../db/native-database';
import { initializeMerchantCommerce, assertMerchantCommerce } from '../db/merchant-commerce';
import { initializeEmptyMerchantCatalog, MerchantCatalogImportStore } from '../server/src/merchant-catalog-import';
import { previewSquareSandboxCatalog } from '../server/src/square-catalog-readonly';
import { MerchantCommerce, merchantCommerceBridge } from '../server/src/merchant-commerce';
import { MerchantSquareProvider } from '../server/src/merchant-square-provider';
import { sandboxConfiguration } from '../server/src/square-sandbox';
import { SandboxWebhookProjector, type SandboxWebhookConfig } from '../server/src/square-webhooks';

/** This suite creates/drops only its random disposable database on an explicitly supplied
 * literal loopback server. No Railway/internal/external host, URL option, or existing DB is used.
 * Example: MERCHANT_NATIVE_TEST_URL=postgres://agent@127.0.0.1:55439/merchant_acceptance_test
 */
export function localMerchantAcceptanceTarget(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('Invalid local merchant acceptance URL'); }
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','[::1]'].includes(url.hostname) ||
      url.pathname !== '/merchant_acceptance_test' || !url.username || url.search || url.hash)
    throw new Error('Merchant native acceptance requires literal loopback and merchant_acceptance_test name');
  return url;
}
test('merchant native acceptance target refuses external, ambiguous and non-test database URLs', () => {
  assert.equal(localMerchantAcceptanceTarget('postgres://agent@127.0.0.1:55439/merchant_acceptance_test').hostname, '127.0.0.1');
  for (const target of ['postgres://agent@example.com/merchant_acceptance_test','postgres://agent@database.railway.internal/merchant_acceptance_test','postgres://agent@localhost/merchant_acceptance_test','postgres://agent@127.0.0.1/production','postgres://agent@127.0.0.1/merchant_acceptance_test?options=x','https://agent@127.0.0.1/merchant_acceptance_test']) assert.throws(() => localMerchantAcceptanceTarget(target));
});
const target = process.env.MERCHANT_NATIVE_TEST_URL;
test('native merchant acceptance: genuine independent PostgreSQL connections, imported storefront, recovery and refunds', { skip: target ? false : 'Set explicitly approved loopback MERCHANT_NATIVE_TEST_URL to run native merchant acceptance' }, async () => {
  const url = localMerchantAcceptanceTarget(target!); const databaseName = 'merchant_acceptance_test_' + randomUUID().replaceAll('-', '');
  const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
  const admin = new pg.Pool({ connectionString: adminUrl.href, max: 1, connectionTimeoutMillis: 5000 });
  const testUrl = new URL(url); testUrl.pathname = '/' + databaseName;
  const pools: pg.Pool[] = []; let created = false;
  const open = () => { const pool = new pg.Pool({ connectionString: testUrl.href, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, application_name: 'square-merchant-native-acceptance' }); pools.push(pool); return pool; };
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    let poolA = open(), poolB = open(); let dbA = new NativeSqlDatabase(poolA), dbB = new NativeSqlDatabase(poolB);
    const [pidA, pidB] = await Promise.all([poolA.query('SELECT pg_backend_pid() AS id, version() AS version'), poolB.query('SELECT pg_backend_pid() AS id')]);
    assert.notEqual(pidA.rows[0].id, pidB.rows[0].id);
    console.log('Native merchant evidence:', pidA.rows[0].version, 'independent backend PIDs', pidA.rows[0].id, pidB.rows[0].id);
    const values = { STARTER_DATASET: 'merchant-catalog-v1', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-native-acceptance', SQUARE_LOCATION_ID: 'NATIVELOCATION', SQUARE_SANDBOX_MERCHANT_ID: 'NATIVEMERCHANT', SQUARE_SANDBOX_ACCESS_TOKEN: 'unit-native-injected-token', SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', SQUARE_MERCHANT_COMMERCE_ENABLED: 'true' };
    const context = { merchantId: values.SQUARE_SANDBOX_MERCHANT_ID, locationId: values.SQUARE_LOCATION_ID };
    const identity = { squareMerchantId: context.merchantId, squareLocationId: context.locationId };
    await initializeEmptyMerchantCatalog(dbA, identity);
    const preview = await previewSquareSandboxCatalog({ environment: 'sandbox', token: values.SQUARE_SANDBOX_ACCESS_TOKEN, locationId: context.locationId }, async () => new Response(JSON.stringify({ objects: [{ type: 'ITEM', id: 'NATIVEITEM', present_at_all_locations: true, item_data: { name: 'Native synthetic test item', description: 'No real merchant data', tax_ids: ['NATIVETAX'], variations: [{ type: 'ITEM_VARIATION', id: 'NATIVEVARIATION', present_at_all_locations: true, item_variation_data: { name: 'Regular', sku: 'NATIVE-SKU', pricing_type: 'FIXED_PRICING', price_money: { amount: 1000, currency: 'USD' } } }] } }] })), { taxTreatment: 'square-order-authoritative' });
    const importer = new MerchantCatalogImportStore(dbA, { taxTreatment: 'square-order-authoritative' });
    const staged = await importer.stage(preview, identity, 'website'); await importer.commit(staged.fingerprint, identity, 'native-test-admin', 'approve-disabled-merchant-import-v1');
    // Build an actual frozen v1 installation, including its original checksum and history.
    const v1Files = ['merchant-commerce.sql', 'migrations/0002_sandbox_events.sql', 'migrations/0003_sandbox_reconciliation_jobs.sql'];
    const v1Sql = (await Promise.all(v1Files.map(file => readFile(new URL('../db/' + file, import.meta.url), 'utf8')))).join('\n');
    const v1Checksum = createHash('sha256').update(v1Sql).digest('hex');
    await dbA.exec(v1Sql);
    await dbA.query('INSERT INTO merchant_commerce_config(singleton,version,checksum,application_id) VALUES(true,1,$1,$2)', [v1Checksum, values.SQUARE_APPLICATION_ID]);
    const historicalId = randomUUID();
    await dbA.query("INSERT INTO merchant_commerce_quotes(id,pricing,cart,expires_at) VALUES($1,'{}','[]',now()-interval '1 day')", [historicalId]);
    await dbA.query("INSERT INTO merchant_commerce_attempts(id,pickup,state,failure_code) VALUES($1,$2::jsonb,'failed','HISTORICAL_DECLINE')", [historicalId, JSON.stringify({name:'Historical synthetic buyer'})]);
    const historicalBefore = (await dbA.query('SELECT id,pickup,state,failure_code,created_at,updated_at FROM merchant_commerce_attempts WHERE id=$1', [historicalId])).rows[0];
    assert.equal((await dbA.query<{version:number;checksum:string}>('SELECT version,checksum FROM merchant_commerce_config')).rows[0]!.checksum, v1Checksum);
    await initializeMerchantCommerce(dbA, values); await initializeMerchantCommerce(dbB, values); await assertMerchantCommerce(dbA, values);
    assert.deepEqual((await dbA.query('SELECT id,pickup,state,failure_code,created_at,updated_at FROM merchant_commerce_attempts WHERE id=$1', [historicalId])).rows[0], historicalBefore);
    assert.equal((await dbA.query<{version:number}>('SELECT version FROM merchant_commerce_config')).rows[0]!.version, 2);
    assert.equal((await dbA.query('SELECT checkout_token_hash FROM merchant_commerce_quotes WHERE id=$1',[historicalId])).rows[0]!.checkout_token_hash, null);
    console.log('Native v2 evidence: frozen v1 checksum accepted; additive v2 upgrade preserves historical attempt and timestamps; repeat migration is idempotent');
    const requests: { path: string; body: any; method?:string }[] = []; let unknownPayment = false, unknownFulfillment = false; const providerOrders = new Map<string, any>();
    const money = (amount: number) => ({ amount, currency: 'USD' });
    const transport: typeof fetch = async (endpoint, init) => {
      assert.equal(new URL(String(endpoint)).origin, 'https://connect.squareupsandbox.com'); // Injected only, no network.
      const path = new URL(String(endpoint)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ path, body, method:init?.method });
      if(init?.method==='GET') return new Response(JSON.stringify({order:providerOrders.get(path.split('/').at(-1)!)}));
      if(init?.method==='PUT') { const id=path.split('/').at(-1)!, prior=providerOrders.get(id); const order={...prior,version:prior.version+1,fulfillments:body.order.fulfillments,state:body.order.fulfillments[0].state==='COMPLETED'?'COMPLETED':'OPEN'};providerOrders.set(id,order);if(unknownFulfillment)throw new Error('Injected fulfillment accepted but response lost');return new Response(JSON.stringify({order})); }
      if (path === '/v2/payments' && unknownPayment) throw new Error('Injected lost response');
      if (path.startsWith('/v2/orders')) {const order = { ...body.order, version:1,state:'OPEN',fulfillments:(body.order.fulfillments??[]).map((f:any)=>({...f,uid:'PICKUP_'+body.order.reference_id})), id: path.endsWith('/calculate') ? undefined : 'ORDER_' + body.order.reference_id,
        line_items: body.order.line_items.map((line: any) => ({ ...line, base_price_money: money(1000), gross_sales_money: money(1000), total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) })), total_discount_money: money(100), total_tax_money: money(90), total_money: money(990) }; if(order.id)providerOrders.set(order.id,order);return new Response(JSON.stringify({order}));}
      if (path === '/v2/payments') return new Response(JSON.stringify({ payment: { ...body, id: 'PAYMENT_' + body.reference_id, status: 'COMPLETED' } }));
      return new Response(JSON.stringify({ refund: { id: 'REFUND_' + body.idempotency_key, payment_id: body.payment_id, location_id: context.locationId, amount_money: body.amount_money, status: 'PENDING' } }));
    };
    const service = (db: NativeSqlDatabase) => new MerchantCommerce(db, new MerchantSquareProvider(sandboxConfiguration(values), transport), context);
    let a = service(dbA), b = service(dbB);
    const imported = (await a.catalog()).products[0]!; const variant = imported.variants[0]!;
    assert.equal(variant.enabled, false); assert.equal(variant.stockQuantity, 0);
    await a.updateInventory({ variantId: variant.id, quantity: 1, enabled: true, revision: 0 }); await a.activate(true);
    const cart = { currency: 'USD', fulfillment: 'pickup', items: [{ productId: imported.id, variantId: variant.id, quantity: 1 }] };
    const pickup = { name: 'Native Test', email: 'native@example.invalid', phone: '+12025550100' };
    const [qA, qB] = await Promise.all([a.quote(cart), b.quote(cart)]);
    const attempts = await Promise.allSettled([a.prepare(qA.quoteId, pickup), b.prepare(qB.quoteId, pickup)]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    const winner = attempts[0]!.status === 'fulfilled' ? qA.quoteId : qB.quoteId;
    const winnerQuote = winner===qA.quoteId?qA:qB;
    const winnerPrepared = attempts.find(result=>result.status==='fulfilled')!;
    assert.ok(winnerPrepared.status==='fulfilled'); const lookupToken=winnerPrepared.value.confirmation!.lookupToken;
    await a.authorizeCheckout(winner,winnerQuote.checkoutToken);
    await assert.rejects(a.authorizeCheckout(winner,lookupToken));
    const hashes=(await dbA.query('SELECT q.checkout_token_hash,a.customer_lookup_hash FROM merchant_commerce_quotes q JOIN merchant_commerce_attempts a ON a.id=q.id WHERE q.id=$1',[winner])).rows[0]!;
    assert.equal(hashes.checkout_token_hash,createHash('sha256').update(winnerQuote.checkoutToken).digest('hex'));
    assert.equal(hashes.customer_lookup_hash,createHash('sha256').update(lookupToken).digest('hex'));
    await Promise.all([a.submit(winner, 'unit-native-card'), b.submit(winner, 'unit-native-card')]);
    assert.equal((await a.status(winner)).state, 'completed'); assert.equal(requests.filter(r => r.path === '/v2/orders').length, 1); assert.equal(requests.filter(r => r.path === '/v2/payments').length, 1);
    console.log('Native merchant evidence: last-stock race has one winner; concurrent duplicate submits have one order and one payment dispatch');
    await Promise.all([poolA.end(), poolB.end()]); pools.splice(0, pools.length);
    poolA = open(); poolB = open(); dbA = new NativeSqlDatabase(poolA); dbB = new NativeSqlDatabase(poolB); a = service(dbA); b = service(dbB);
    await assertMerchantCommerce(dbA, values); assert.equal((await b.status(winner)).state, 'completed'); await b.submit(winner, 'unit-native-card'); assert.equal(requests.filter(r => r.path === '/v2/payments').length, 1);
    await b.authorizeCheckout(winner,winnerQuote.checkoutToken);
    const receipt=await b.lookup(lookupToken); assert.equal(receipt.attemptId,winner);assert.equal(receipt.lines[0]!.name,'Native synthetic test item');
    assert.ok(!JSON.stringify(receipt).includes(pickup.email));
    assert.equal((await b.prepare(winner,pickup)).confirmation,undefined);
    unknownFulfillment=true;
    const uncertainFulfillment=await a.fulfill(winner,'ready','native-test-admin');
    assert.equal(uncertainFulfillment.requiresReconciliation,true);assert.equal(uncertainFulfillment.fulfillmentState,'unfulfilled');
    const operationBefore=(await dbA.query('SELECT id,idempotency_key,state FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1',[winner])).rows[0]!;
    assert.equal(operationBefore.state,'review');
    await assert.rejects(b.refund(winner,randomUUID(),100,'native-test-admin'));
    await Promise.all([poolA.end(),poolB.end()]);pools.splice(0,pools.length);
    poolA=open();poolB=open();dbA=new NativeSqlDatabase(poolA);dbB=new NativeSqlDatabase(poolB);a=service(dbA);b=service(dbB);
    const recovered=await b.recoverFulfillment(winner,'native-test-admin');
    assert.equal(recovered.fulfillmentState,'ready');assert.equal(recovered.requiresReconciliation,false);
    const operationAfter=(await dbB.query('SELECT id,idempotency_key,state FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1',[winner])).rows[0]!;
    assert.deepEqual(operationAfter,{...operationBefore,state:'completed'});
    assert.equal(requests.filter(r=>r.method==='PUT').length,1);
    assert.equal((await b.lookup(lookupToken)).fulfillmentState,'ready');
    console.log('Native v2 evidence: hashed checkout/lookup capabilities survive reopened pools; lost fulfillment response remains durable review, blocks refund, and read-only provider recovery completes same operation without a second PUT');
    const stockRow = (await a.inventory())[0] as { revision: number }; await a.updateInventory({ variantId: variant.id, quantity: 2, enabled: true, revision: stockRow.revision });
    const unknown = await a.quote(cart); await a.prepare(unknown.quoteId, pickup); unknownPayment = true;
    assert.equal((await a.submit(unknown.quoteId, 'unit-native-card')).state, 'review'); await b.submit(unknown.quoteId, 'unit-native-card');
    assert.equal((await dbA.query<{ state: string }>('SELECT state FROM merchant_commerce_reservations WHERE attempt_id=$1', [unknown.quoteId])).rows[0]!.state, 'held');
    const webhookConfig: SandboxWebhookConfig = { ...context, environment: 'sandbox', signatureKey: 'unit-native-signature-key', notificationUrl: 'https://native.example.invalid/webhooks' };
    const projectorA = new SandboxWebhookProjector(dbA, webhookConfig, merchantCommerceBridge(context)); const projectorB = new SandboxWebhookProjector(dbB, webhookConfig, merchantCommerceBridge(context));
    const event = (kind: 'payment' | 'refund', resourceId: string, amount: number) => Buffer.from(JSON.stringify({ event_id: randomUUID(), merchant_id: context.merchantId, type: kind + '.updated', data: { type: kind, id: resourceId, object: { [kind]: { id: resourceId, ...(kind === 'refund' ? { payment_id: 'PAYMENT_' + unknown.quoteId } : {}), location_id: context.locationId, order_id: 'ORDER_' + unknown.quoteId, reference_id: unknown.quoteId, status: 'COMPLETED', amount_money: money(amount), updated_at: '2026-10-25T14:00:00.000Z' } } } }));
    const sign = (raw: Buffer) => createHmac('sha256', webhookConfig.signatureKey).update(webhookConfig.notificationUrl).update(raw).digest('base64');
    const raw = event('payment', 'PAYMENT_' + unknown.quoteId, 990);
    await assert.rejects(projectorA.handle(raw, 'invalid'));
    const outcomes = await Promise.all([projectorA.handle(raw, sign(raw)), projectorB.handle(raw, sign(raw))]);
    assert.deepEqual(outcomes.map(result => result.outcome).sort(), ['applied','duplicate']); assert.equal((await a.status(unknown.quoteId)).state, 'completed');
    const refundId = randomUUID(); const refund = await a.refund(unknown.quoteId, refundId, 600, 'native-test-admin');
    await assert.rejects(b.refund(unknown.quoteId, randomUUID(), 391, 'native-test-admin'));
    const refundRaw = event('refund', refund!.refund_id!, 600); await projectorA.handle(refundRaw, sign(refundRaw)); await projectorB.handle(refundRaw, sign(refundRaw));
    assert.equal((await b.status(unknown.quoteId)).refundedMinor, 600);
    assert.equal((await dbA.query<{ stock_quantity: number }>('SELECT stock_quantity FROM merchant_commerce_inventory WHERE variant_id=$1', [variant.id])).rows[0]!.stock_quantity, 1);
    assert.equal((await dbA.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('demo_database_state','mock_payment_ledger')")).rows.length, 0);
    console.log('Native merchant evidence: reopened pools preserve checkout; unknown payment held then recovered by concurrent signed webhook replay; partial refund deduplicates without restock');
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});
