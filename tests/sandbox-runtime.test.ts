import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { migrateSyntheticDatabase } from '../db/migrate';
import { PostgresCheckoutStore, DurableCheckoutService } from '../server/src/durable-checkout';
import { createRuntimeSandbox } from '../server/src/square-runtime';
import { createApp } from '../server/src/app';
import type { SandboxTransport } from '../server/src/square-sandbox';

const origin = 'https://starter.invalid'; const notification = `${origin}/api/sandbox/webhooks`;
const values = { SQUARE_SANDBOX_REQUESTS_ENABLED: 'true', STARTER_DATASET: 'synthetic-retail-v1', SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-test-application', SQUARE_LOCATION_ID: 'TESTLOCATION', SQUARE_SANDBOX_ACCESS_TOKEN: 'synthetic-unit-token-only', SQUARE_SANDBOX_MERCHANT_ID: 'TESTMERCHANT', SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'synthetic-signature-only' };
test('HTTP sandbox bridge uses synthetic transport and signed callbacks only, with durable identity and closed staff', async (t) => {
  const db = await PGlite.create(); await migrateSyntheticDatabase(db); const checkout = new DurableCheckoutService(new PostgresCheckoutStore(db));
  let losePayment = false; let pendingPayment = false; const calls: { path: string; body: any }[] = [];
  const transport: SandboxTransport = async (request) => {
    const body = JSON.parse(request.body); calls.push({ path: request.url, body });
    if (request.url.endsWith('/orders')) return { status: 200, body: { order: { id: `ORDER_${body.order.reference_id}`, ...body.order, total_money: { amount: 2400, currency: 'USD' } } } };
    if (losePayment) throw new Error('synthetic lost response');
    return { status: 200, body: { payment: { ...body, id: `PAYMENT_${body.reference_id}`, status: pendingPayment ? 'PENDING' : 'COMPLETED' } } };
  };
  const runtime = createRuntimeSandbox(db, values, origin, transport);
  const app = await createApp({ load: () => checkout.getCatalog() }, { origin, checkout, localDatabase: true, sandbox: runtime });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await db.close(); });
  async function request() { const cart = { items: [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }], currency: 'USD', fulfillment: 'pickup' }; const quote = await checkout.quote(cart); return { ...cart, attemptId: randomUUID(), demoSessionId: quote.demoSessionId, expectedTotalMinor: quote.totalMinor }; }
  async function post(path: string, body: unknown, source = origin) { return fetch(`${base}/api/sandbox/checkout/${path}`, { method: 'POST', headers: { Origin: source, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  async function callback(checkoutId: string, paymentId: string, options: { kind?: 'payment' | 'refund'; status?: string; amount?: number; eventId?: string; orderId?: string; reference?: string; signature?: string; timestamp?: string } = {}) {
    const kind = options.kind ?? 'payment'; const resourceId = kind === 'payment' ? paymentId : 'REFUND_TEST';
    const raw = JSON.stringify({ event_id: options.eventId ?? randomUUID(), merchant_id: 'TESTMERCHANT', type: `${kind}.updated`, data: { type: kind, id: resourceId, object: { [kind]: { id: resourceId, ...(kind === 'refund' ? { payment_id: paymentId } : { reference_id: options.reference ?? checkoutId }), ...(options.orderId === '' ? {} : { order_id: options.orderId ?? `ORDER_${checkoutId}` }), location_id: 'TESTLOCATION', status: options.status ?? 'COMPLETED', amount_money: { amount: options.amount ?? (kind === 'payment' ? 2400 : 200), currency: 'USD' }, updated_at: options.timestamp ?? '2026-10-22T12:00:00Z' } } } });
    const signature = options.signature ?? createHmac('sha256', values.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY).update(notification).update(raw).digest('base64');
    return fetch(`${base}/api/sandbox/webhooks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': signature }, body: raw });
  }
  const stock = async () => (await db.query<{ stock_quantity: number }>('SELECT stock_quantity FROM catalog_variants WHERE id=$1', ['candle-cedar-amber'])).rows[0]!.stock_quantity;
  await t.test('origin, input and anonymous staff guards apply before transport; only public metadata is returned', async () => {
    const input = await request(); assert.equal((await post('prepare', input, 'https://evil.invalid')).status, 403);
    assert.equal((await post('prepare', { ...input, expectedTotalMinor: 1 })).status, 409); assert.equal(calls.length, 0);
    const storefront = await (await fetch(`${base}/api/storefront`)).json(); assert.equal(storefront.sandbox.environment, 'sandbox'); assert.equal(storefront.capabilities.square, false);
    assert.doesNotMatch(JSON.stringify(storefront), /synthetic-unit-token|signature-only|TESTMERCHANT/);
    assert.equal((await fetch(`${base}/api/admin/session`)).status, 401); assert.equal((await fetch(`${base}/api/admin/integration`)).status, 401);
    const headers = await fetch(`${base}/api/health`); assert.match(headers.headers.get('content-security-policy')!, /sandbox.web.squarecdn.com/); assert.doesNotMatch(headers.headers.get('content-security-policy')!, /pci-connect.squareup.com/);
  });
  await t.test('matching signed callback recovers an unknown payment and duplicates cannot create another effect', async () => {
    const input = await request(); losePayment = true;
    const uncertain = await (await post('submit', { request: input, cardToken: 'unit-card-token' })).json(); assert.equal(uncertain.state, 'review'); assert.equal(uncertain.mode, 'square-sandbox'); assert.equal(await stock(), 6);
    const paymentId = `PAYMENT_${uncertain.checkoutId}`; const eventId = randomUUID();
    assert.equal((await callback(uncertain.checkoutId, paymentId, { signature: 'invalid' })).status, 403);
    assert.equal((await callback(uncertain.checkoutId, paymentId, { reference: randomUUID() })).status, 409);
    assert.equal((await callback(uncertain.checkoutId, paymentId, { amount: 1 })).status, 409);
    assert.equal((await callback(uncertain.checkoutId, paymentId, { kind: 'refund', orderId: '', amount: 200 })).status, 200); // Arrives before the expected payment is bound.
    assert.equal((await callback(uncertain.checkoutId, paymentId, { eventId })).status, 200); assert.equal((await callback(uncertain.checkoutId, paymentId, { eventId })).status, 200);
    const result = await (await post('prepare', input)).json(); assert.equal(result.state, 'completed'); assert.equal(result.paymentId, paymentId); assert.equal(result.fulfillmentAuthorized, false); assert.equal(result.refundedMinor, 200);
    const retry = await (await post('submit', { request: input, cardToken: 'another-unit-token' })).json(); assert.equal(retry.checkoutId, result.checkoutId); assert.equal(calls.length, 2); assert.equal(await stock(), 6);
    assert.equal((await callback(result.checkoutId, paymentId, { kind: 'refund', orderId: '', amount: 200 })).status, 200);
    const refunded = await (await post('prepare', input)).json(); assert.equal(refunded.refundedMinor, 200); assert.equal(await stock(), 6);
    assert.equal((await callback(result.checkoutId, paymentId, { kind: 'refund', orderId: '', amount: 200 })).status, 200); assert.equal((await (await post('prepare', input)).json()).refundedMinor, 200);
    assert.equal((await callback(result.checkoutId, paymentId, { kind: 'refund', amount: 2401 })).status, 409);
  });
  await t.test('pending payment cancellation releases stock once, and later stale events cannot regress terminal evidence', async () => {
    losePayment = false; pendingPayment = true; const input = await request(); const before = await stock();
    const pending = await (await post('submit', { request: input, cardToken: 'unit-card-token' })).json(); assert.equal(pending.state, 'pending'); assert.equal(await stock(), before - 1);
    assert.equal((await callback(pending.checkoutId, pending.paymentId, { status: 'CANCELED' })).status, 200);
    assert.equal((await callback(pending.checkoutId, pending.paymentId, { status: 'CANCELED', timestamp: '2026-10-22T12:01:00Z' })).status, 200);
    assert.equal((await callback(pending.checkoutId, pending.paymentId, { status: 'PENDING', timestamp: '2026-10-22T11:00:00Z' })).status, 200);
    assert.equal((await (await post('prepare', input)).json()).state, 'failed'); assert.equal(await stock(), before);
  });
});
