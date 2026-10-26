import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createHmac, randomUUID } from 'node:crypto';
import { merchantPaymentConfiguration, publicMerchantPaymentConfiguration, merchantWebhookConfiguration, assertMerchantPaymentConfiguration, MerchantPaymentConfigurationError } from '../server/src/merchant-payment-config';
import { MerchantSquareProvider, MerchantProviderError } from '../server/src/merchant-square-provider';
import { verifyMerchantWebhook, verifySandboxWebhook, SandboxWebhookProjector, MerchantWebhookProjector, type SandboxWebhookConfig } from '../server/src/square-webhooks';
import type { SqlDatabase } from '../db/sql-database';
const production = { SQUARE_ENVIRONMENT: 'production', SQUARE_PRODUCTION_PAYMENTS_ENABLED: 'true', SQUARE_PRODUCTION_APPLICATION_ID: 'sq0idp-unit-production', SQUARE_PRODUCTION_LOCATION_ID: 'PRODUCTIONLOCATION', SQUARE_PRODUCTION_MERCHANT_ID: 'PRODUCTIONMERCHANT', SQUARE_PRODUCTION_ACCESS_TOKEN: 'injected-production-token-only', SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY: 'injected-production-signature-only' };
const sandbox = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-unit-sandbox', SQUARE_LOCATION_ID: 'SANDBOXLOCATION', SQUARE_SANDBOX_MERCHANT_ID: 'SANDBOXMERCHANT', SQUARE_SANDBOX_ACCESS_TOKEN: 'injected-sandbox-token-only', SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'injected-sandbox-signature-only' };
const errorCode = (code: string) => (error: unknown) => (error instanceof MerchantPaymentConfigurationError || error instanceof MerchantProviderError) && error.code === code;
test('production is disabled by default and cannot fall back to sandbox/generic secrets or identifiers', () => {
  assert.throws(() => merchantPaymentConfiguration({}), errorCode('PROVIDERS_DISABLED'));
  for (const value of [undefined, 'false','TRUE','1']) assert.throws(() => merchantPaymentConfiguration({ ...production, SQUARE_PRODUCTION_PAYMENTS_ENABLED: value }), errorCode('PROVIDERS_DISABLED'));
  for (const field of ['SQUARE_PRODUCTION_APPLICATION_ID','SQUARE_PRODUCTION_LOCATION_ID','SQUARE_PRODUCTION_MERCHANT_ID','SQUARE_PRODUCTION_ACCESS_TOKEN','SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY']) assert.throws(() => merchantPaymentConfiguration({ ...sandbox, ...production, [field]: undefined }), errorCode('INVALID_CONFIGURATION'));
  for (const changes of [{ SQUARE_PRODUCTION_APPLICATION_ID: sandbox.SQUARE_APPLICATION_ID }, { SQUARE_PRODUCTION_ACCESS_TOKEN: sandbox.SQUARE_SANDBOX_ACCESS_TOKEN }, { SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY: sandbox.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY }]) assert.throws(() => merchantPaymentConfiguration({ ...sandbox, ...production, ...changes }), errorCode('INVALID_CONFIGURATION'));
});
test('environment endpoints are fixed, public config has no secrets, production config is immutable and cannot be structurally forged', () => {
  const config = merchantPaymentConfiguration(production); assert.equal(config.apiOrigin, 'https://connect.squareup.com'); assert.equal(config.sdkUrl, 'https://web.squarecdn.com/v1/square.js');
  assert.deepEqual(Object.keys(publicMerchantPaymentConfiguration(config)).sort(), ['applicationId','environment','locationId','sdkUrl']); assert.doesNotMatch(JSON.stringify(publicMerchantPaymentConfiguration(config)), /token|signature|merchantId/);
  assert.throws(() => { (config as any).apiOrigin = 'https://attacker.invalid'; });
  assert.throws(() => assertMerchantPaymentConfiguration({ ...config }), errorCode('UNVALIDATED_CONFIGURATION'));
  assert.throws(() => new MerchantSquareProvider({ ...config }, async () => { throw new Error('never'); }), errorCode('UNVALIDATED_CONFIGURATION'));
  const testConfig = merchantPaymentConfiguration(sandbox); assert.equal(testConfig.apiOrigin, 'https://connect.squareupsandbox.com'); assert.equal(testConfig.sdkUrl, 'https://sandbox.web.squarecdn.com/v1/square.js');
});
test('production signatures use exact gated key and URL while sandbox verification/projector remain sandbox-only', async () => {
  const config = merchantPaymentConfiguration(production); const webhook = merchantWebhookConfiguration(config, 'https://merchant.example.invalid/api/webhook');
  const raw = Buffer.from('{"event_id":"fixture"}'); const signature = createHmac('sha256', config.webhookSignatureKey).update(webhook.notificationUrl).update(raw).digest('base64');
  assert.equal(verifyMerchantWebhook(raw, signature, webhook), true); assert.equal(verifyMerchantWebhook(Buffer.concat([raw, Buffer.from(' ')]), signature, webhook), false);
  assert.equal(verifyMerchantWebhook(raw, signature, { ...webhook }), false);
  assert.equal(verifySandboxWebhook(raw, signature, webhook as SandboxWebhookConfig), false);
  assert.throws(() => new SandboxWebhookProjector({} as SqlDatabase, webhook as SandboxWebhookConfig));
  const db = { async query() { throw new Error('DB must not be queried'); }, async transaction() { throw new Error('DB must not be queried'); } } as unknown as SqlDatabase;
  const projector = new MerchantWebhookProjector(db, webhook); await assert.rejects(projector.handle(raw, 'wrong'), (error: any) => error.code === 'SIGNATURE');
  for (const url of ['http://merchant.example.invalid/webhook','https://user:pass@merchant.example.invalid/webhook','https://merchant.example.invalid/webhook#fragment']) assert.throws(() => merchantWebhookConfiguration(config, url));
});
test('injected production calculation/order/payment/refund use production origin and bound evidence with scheduled pickup', async () => {
  const config = merchantPaymentConfiguration(production); const calls: {path: string; body: any}[] = []; const money = (amount: number) => ({ amount, currency: 'USD' });
  const provider = new MerchantSquareProvider(config, async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://connect.squareup.com'); assert.equal(init!.redirect, 'error');
    const body = JSON.parse(String(init!.body)); calls.push({ path: url.pathname, body });
    if (url.pathname.startsWith('/v2/orders')) return Response.json({ order: { ...body.order, id: 'ORDER_UNIT', line_items: body.order.line_items.map((line: any) => ({ ...line, base_price_money: money(200), gross_sales_money: money(200), total_money: money(200) })), total_money: money(200) } });
    if (url.pathname === '/v2/payments') return Response.json({ payment: { ...body, id: 'PAYMENT_UNIT', status: 'COMPLETED' } });
    return Response.json({ refund: { id: 'REFUND_UNIT', payment_id: body.payment_id, location_id: config.locationId, amount_money: body.amount_money, status: 'PENDING' } });
  });
  const pricing = await provider.calculate([{ variantId: 'test-variant', squareVariationId: 'VARIATION_UNIT', quantity: 1 }], randomUUID());
  assert.equal(pricing.environment, 'production'); assert.equal(pricing.merchantId, config.merchantId); assert.equal(pricing.applicationId, config.applicationId);
  const pickup = { name: 'Unit Test', email: 'test@example.invalid', phone: '+12025550100' };
  await assert.rejects(provider.createOrder(pricing, pickup), errorCode('INVALID_INPUT')); assert.equal(calls.length, 1);
  await assert.rejects(provider.createOrder({ ...pricing, environment: undefined }, { ...pickup, promisedAt: '2030-01-01T12:00:00Z' }), errorCode('INVALID_INPUT'));
  const order = await provider.createOrder(pricing, { ...pickup, promisedAt: '2030-01-01T12:00:00Z' }); const payment = await provider.pay(order, 'unit-token'); await provider.refund(payment, randomUUID(), 100);
  assert.equal(calls[1]!.body.order.fulfillments[0].pickup_details.schedule_type, 'SCHEDULED'); assert.equal(calls[1]!.body.order.fulfillments[0].pickup_details.pickup_at, '2030-01-01T12:00:00.000Z');
  assert.equal(payment.environment, 'production'); assert.equal(payment.fulfillmentAuthorized, false); assert.equal(calls.length, 4);
  await assert.rejects(provider.refund({ ...payment, merchantId: 'FOREIGN' }, randomUUID(), 100), errorCode('INVALID_INPUT'));
});

test('gated merchant webhook projector applies signed production payment/refund fixtures with deduplication and scope isolation', async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(await readFile(new URL('../db/migrations/0002_sandbox_events.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../db/migrations/0003_sandbox_reconciliation_jobs.sql', import.meta.url), 'utf8'));
  const cfg = merchantPaymentConfiguration(production); const webhook = merchantWebhookConfiguration(cfg, 'https://merchant.example.invalid/api/webhook'); const projector = new MerchantWebhookProjector(db, webhook);
  const checkoutId = randomUUID(); await projector.registerExpectedPayment({ paymentId: 'PAYMENT_PRODUCTION_FIXTURE', checkoutId, orderId: 'ORDER_PRODUCTION_FIXTURE', amountMinor: 200, currency: 'USD' });
  const event = (kind: 'payment' | 'refund') => Buffer.from(JSON.stringify({ event_id: randomUUID(), merchant_id: cfg.merchantId, type: kind + '.updated', data: { type: kind, id: kind === 'payment' ? 'PAYMENT_PRODUCTION_FIXTURE' : 'REFUND_PRODUCTION_FIXTURE', object: { [kind]: { id: kind === 'payment' ? 'PAYMENT_PRODUCTION_FIXTURE' : 'REFUND_PRODUCTION_FIXTURE', payment_id: 'PAYMENT_PRODUCTION_FIXTURE', order_id: 'ORDER_PRODUCTION_FIXTURE', reference_id: checkoutId, location_id: cfg.locationId, status: 'COMPLETED', amount_money: { amount: kind === 'payment' ? 200 : 100, currency: 'USD' }, updated_at: '2026-10-25T16:00:00Z' } } } }));
  const sign = (raw: Buffer) => createHmac('sha256', cfg.webhookSignatureKey).update(webhook.notificationUrl).update(raw).digest('base64');
  const payment = event('payment'), refund = event('refund'); assert.equal((await projector.handle(payment, sign(payment))).outcome, 'applied'); assert.equal((await projector.handle(refund, sign(refund))).outcome, 'applied'); assert.equal((await projector.handle(refund, sign(refund))).outcome, 'duplicate');
  assert.equal((await projector.projection('PAYMENT_PRODUCTION_FIXTURE'))!.netMinor, 100);
  const foreign = JSON.parse(event('payment').toString()); foreign.merchant_id = 'OTHER'; const raw = Buffer.from(JSON.stringify(foreign)); await assert.rejects(projector.handle(raw, sign(raw)), (error: any) => error.code === 'PAYLOAD');
});

test('production seller verification requires an active USD card-processing location', async () => {
  const {verifySquareImportSeller}=await import('../server/src/merchant-import-service');
  const config=merchantPaymentConfiguration(production);
  const identity={squareMerchantId:config.merchantId,squareLocationId:config.locationId};
  const valid={id:config.locationId,merchant_id:config.merchantId,currency:'USD',status:'ACTIVE',capabilities:['CARD_PROCESSING']};
  for(const changes of [{currency:'CAD'},{status:'INACTIVE'},{capabilities:[]},{currency:undefined},{status:undefined},{capabilities:undefined}]){
    const fetcher:typeof fetch=async input=>Response.json(String(input).endsWith('/merchants')?{merchant:[{id:config.merchantId}]}:{locations:[{...valid,...changes}]});
    await assert.rejects(verifySquareImportSeller({token:config.accessToken,locationId:config.locationId},identity,fetcher,config),/SELLER_UNVERIFIED/);
  }
  await verifySquareImportSeller({token:config.accessToken,locationId:config.locationId},identity,async input=>Response.json(String(input).endsWith('/merchants')?{merchant:[{id:config.merchantId}]}:{locations:[valid]}),config);
});
