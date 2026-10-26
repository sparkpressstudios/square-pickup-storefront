import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { demoCatalog } from '../config/demo-catalog';
import { migrateSyntheticDatabase } from '../db/migrate';
import { sandboxCheckoutAttempts, sandboxCheckoutReservations } from '../db/schema/sandbox-checkout';
import { CheckoutError, type CheckoutRequest, type CartItem } from '../shared/checkout';
import { SandboxCheckoutError, type SandboxCheckoutPort } from '../shared/sandbox-checkout';
import { PreparedSandboxStore } from '../server/src/prepared-sandbox-store';
import { PreparedSandboxCheckout, type SandboxProtocolTestDependencies } from '../server/src/prepared-sandbox-checkout';
import { DurableCheckoutService, PostgresCheckoutStore } from '../server/src/durable-checkout';
import { SquareSandboxAdapter, sandboxIntent, type SandboxTransportRequest } from '../server/src/square-sandbox';
import { preparedSandboxCardCheckout } from '../client/src/prepared-sandbox-checkout';
import { attachSandboxCard, type VerificationDetails } from '../client/src/square-tokenization';

const configuration = { environment: 'sandbox', applicationId: 'sandbox-sq0idb-unit-application', locationId: 'TESTLOCATION01', accessToken: 'synthetic-test-access-token' } as const;
const candle: CartItem = { productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 };
const granola: CartItem = { productId: 'pantry-granola', variantId: 'granola-maple', quantity: 1 };
const cardToken = 'ephemeral-unit-card-token';
type Fault = 'lost-before' | 'lost-after' | 'reject' | 'decline' | 'malformed' | 'auth' | null;
function transportFixture() {
  const requests: SandboxTransportRequest[] = []; const effects = new Map<string, unknown>();
  let orderFault: Fault = null; let paymentFault: Fault = null; let paymentStatus: 'COMPLETED' | 'APPROVED' | 'PENDING' = 'COMPLETED';
  const send = async (request: SandboxTransportRequest) => {
    requests.push(request); const input = JSON.parse(request.body); const isOrder = request.url.endsWith('/orders'); const fault = isOrder ? orderFault : paymentFault;
    if (fault === 'lost-before') throw new Error('untrusted-secret-transport-detail');
    if (fault === 'reject') return { status: 400, body: { errors: [{ code: 'BAD_REQUEST', detail: 'do-not-persist-this' }] } };
    if (fault === 'auth') return { status: 401, body: {} };
    if (fault === 'decline') return { status: 400, body: { errors: [{ code: 'CARD_DECLINED' }] } };
    if (!effects.has(input.idempotency_key)) {
      const suffix = input.idempotency_key.slice(4).replaceAll('-', '');
      effects.set(input.idempotency_key, isOrder ? { order: { id: `ORDER_${suffix}`, ...input.order, total_money: { amount: input.order.line_items.reduce((sum: number, line: { quantity: string; base_price_money: { amount: number } }) => sum + Number(line.quantity) * line.base_price_money.amount, 0), currency: 'USD' } } }
        : { payment: { id: `PAYMENT_${suffix}`, ...input, status: paymentStatus } });
    }
    if (fault === 'lost-after') throw new Error('response-lost-after-synthetic-effect');
    if (fault === 'malformed') return { status: 200, body: isOrder ? { order: { id: 'WRONG_ORDER' } } : { payment: { id: 'WRONG_PAYMENT' } } };
    return { status: 200, body: effects.get(input.idempotency_key) };
  };
  return { requests, effects, send, setOrderFault(value: Fault) { orderFault = value; }, setPaymentFault(value: Fault) { paymentFault = value; }, setPaymentStatus(value: typeof paymentStatus) { paymentStatus = value; } };
}
function dependencies(mock: ReturnType<typeof transportFixture>): SandboxProtocolTestDependencies { return { execution: 'injected-test-transport', configuration, transport: mock.send }; }

test('prepared backend/client gates reject execution before database, card or transport access', async () => {
  const service = new PreparedSandboxCheckout({} as PreparedSandboxStore);
  const request = { ...{ items: [candle], currency: 'USD', fulfillment: 'pickup' }, attemptId: randomUUID(), demoSessionId: randomUUID(), expectedTotalMinor: 2400 } as CheckoutRequest;
  for (const action of [() => service.prepare(request), () => service.submit(request, cardToken), () => service.cancelBeforeDispatch(request), () => preparedSandboxCardCheckout().pay(request, { countryCode: 'US' })]) await assert.rejects(action(), (error: unknown) => error instanceof SandboxCheckoutError && error.code === 'PROVIDERS_DISABLED');
  const mock = transportFixture(); assert.throws(() => new PreparedSandboxCheckout({} as PreparedSandboxStore, { ...dependencies(mock), configuration: { ...configuration, accessToken: '' } }));
  assert.throws(() => new PreparedSandboxCheckout({} as PreparedSandboxStore, { ...dependencies(mock), execution: 'live' } as unknown as SandboxProtocolTestDependencies));
  assert.equal(mock.requests.length, 0);
});

test('prepared sandbox lifecycle connects mocked card/protocol to durable isolated order/payment state', async (t) => {
  const directory = join(await mkdtemp(join(tmpdir(), 'square-prepared-synthetic-')), 'pgdata');
  let db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db);
  let store = new PreparedSandboxStore(db); let legacy = new PostgresCheckoutStore(db);
  t.after(async () => { await db.close(); });
  t.beforeEach(async () => {
    await db.exec('TRUNCATE sandbox_checkout_reservations,sandbox_checkout_attempts,inventory_reservations,mock_payment_ledger,checkout_attempts');
    for (const product of demoCatalog.products) for (const variant of product.variants) await db.query('UPDATE catalog_variants SET price_minor=$2,stock_quantity=$3,enabled=$4 WHERE id=$1', [variant.id, variant.priceMinor, variant.stockQuantity, variant.enabled]);
  });
  async function request(items: readonly CartItem[] = [candle]): Promise<CheckoutRequest> {
    const quote = await new DurableCheckoutService(legacy).quote({ items, currency: 'USD', fulfillment: 'pickup' });
    return { items, currency: 'USD', fulfillment: 'pickup', attemptId: randomUUID(), demoSessionId: quote.demoSessionId, expectedTotalMinor: quote.totalMinor };
  }
  async function stock(id = candle.variantId) { return (await db.query<{ stock_quantity: number }>('SELECT stock_quantity FROM catalog_variants WHERE id=$1', [id])).rows[0]!.stock_quantity; }
  async function count(table: 'sandbox_checkout_attempts' | 'sandbox_checkout_reservations' | 'checkout_attempts' | 'mock_payment_ledger') { return (await db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0]!.count; }
  async function reopen() { await db.close(); db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db); store = new PreparedSandboxStore(db); legacy = new PostgresCheckoutStore(db); }

  await t.test('additive schema agrees with Drizzle and preserves prior migration checksums/catalog', async () => {
    const before = await legacy.getCatalog(); const checksums = await db.query('SELECT id,checksum FROM starter_schema_migrations ORDER BY id'); await migrateSyntheticDatabase(db);
    assert.deepEqual((await db.query('SELECT id,checksum FROM starter_schema_migrations ORDER BY id')).rows, checksums.rows); assert.deepEqual(await legacy.getCatalog(), before);
    for (const table of [sandboxCheckoutAttempts, sandboxCheckoutReservations]) {
      const declared = getTableConfig(table); const actual = await db.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_name=$1', [declared.name]);
      assert.deepEqual(actual.rows.map((row) => row.column_name).sort(), declared.columns.map((column) => column.name).sort());
    }
  });
  await t.test('invalid quantities/variants, tampering, session and card tokens stop before reservation or protocol dispatch', async () => {
    const mock = transportFixture(); const service = new PreparedSandboxCheckout(store, dependencies(mock)); const valid = await request();
    for (const value of [0, -1, 1.5, '1', 100]) await assert.rejects(service.submit({ ...valid, items: [{ ...candle, quantity: value }] } as CheckoutRequest, cardToken));
    for (const input of [{ ...valid, expectedTotalMinor: 1 }, { ...valid, demoSessionId: randomUUID() }, { ...valid, priceMinor: 1 }, { ...valid, items: [{ ...candle, variantId: 'missing' }] }, { ...valid, items: [{ ...candle, variantId: 'candle-sage-chalk' }] }]) await assert.rejects(service.submit(input, cardToken));
    for (const token of ['', 'CASH', 'EXTERNAL', 'bad token']) await assert.rejects(service.submit(valid, token));
    assert.equal(await count('sandbox_checkout_attempts'), 0); assert.equal(mock.requests.length, 0); assert.equal(await stock(), 7);
  });
  await t.test('card lifecycle uses a server-reserved mixed cart, stores no token and returns one durable linked result', async () => {
    const mock = transportFixture(); const service = new PreparedSandboxCheckout(store, dependencies(mock)); const input = await request([candle, granola]); const details: VerificationDetails[] = [];
    const card = await attachSandboxCard(configuration, '#test-card', { isSecureContext: true, async loadSdk() { return { payments() { return { async card() { return { async attach() {}, async destroy() {}, async tokenize(value: VerificationDetails) { details.push(value); return { status: 'OK', token: cardToken }; } }; } }; } }; } });
    const client = preparedSandboxCardCheckout({ execution: 'injected-test-transport', card, port: service });
    const result = await client.pay(input, { countryCode: 'US' }); assert.equal(result.state, 'completed'); assert.equal(result.mode, 'mocked-sandbox-protocol'); assert.equal(result.fulfillmentAuthorized, false);
    assert.equal(details[0]!.amount, '32.00'); assert.equal(result.amountMinor, 3200); assert.ok(result.orderId); assert.ok(result.paymentId);
    assert.equal(mock.requests.length, 2); assert.equal(mock.effects.size, 2); assert.equal(await stock(), 6); assert.equal(await stock(granola.variantId), 5);
    assert.equal(await count('sandbox_checkout_attempts'), 1); assert.equal(await count('sandbox_checkout_reservations'), 2); assert.equal(await count('checkout_attempts'), 0); assert.equal(await count('mock_payment_ledger'), 0);
    const stored = await store.get(input.attemptId); assert.notEqual(stored.order_key, stored.payment_key); assert.equal(stored.order_key, JSON.parse(mock.requests[0]!.body).idempotency_key); assert.equal(stored.payment_key, JSON.parse(mock.requests[1]!.body).idempotency_key);
    assert.doesNotMatch(JSON.stringify(stored), /ephemeral-unit-card-token|synthetic-test-access-token|countryCode|billingContact|Authorization|source_id/);
    assert.deepEqual(await client.pay(input, { countryCode: 'US' }), result); assert.equal(details.length, 1); await card.destroy();
  });
  await t.test('parallel duplicate submissions and completed retries create one order/payment and one reservation', async () => {
    const mock = transportFixture(); const input = await request(); const services = [new PreparedSandboxCheckout(store, dependencies(mock)), new PreparedSandboxCheckout(new PreparedSandboxStore(db), dependencies(mock))];
    await Promise.all([services[0]!.submit(input, cardToken), services[1]!.submit(input, 'another-ephemeral-token')]);
    const result = await services[0]!.submit(input, cardToken); assert.equal(result.state, 'completed'); assert.equal(mock.requests.length, 2); assert.equal(mock.effects.size, 2); assert.equal(await stock(), 6);
    await reopen(); assert.deepEqual(await new PreparedSandboxCheckout(store, dependencies(mock)).submit(input, cardToken), result); assert.equal(mock.requests.length, 2);
  });
  await t.test('same attempt cannot change cart/total/context or cross simulated and prepared checkout modes', async () => {
    const input = await request(); const mock = transportFixture(); const service = new PreparedSandboxCheckout(store, dependencies(mock)); await service.prepare(input);
    for (const changed of [{ ...input, expectedTotalMinor: 4800, items: [{ ...candle, quantity: 2 }] }, { ...input, expectedTotalMinor: 1 }]) await assert.rejects(service.prepare(changed), (error: unknown) => error instanceof CheckoutError && error.code === 'IDEMPOTENCY_CONFLICT');
    const other = new PreparedSandboxCheckout(store, { ...dependencies(mock), configuration: { ...configuration, locationId: 'OTHERLOCATION' } }); await assert.rejects(other.prepare(input), /another cart or sandbox context/);
    await assert.rejects(new DurableCheckoutService(legacy).checkout(input), /another checkout mode/);
    const legacyRequest = await request([granola]); await legacy.reserve(legacyRequest); await assert.rejects(service.prepare(legacyRequest), /simulated checkout/);
    assert.equal(mock.requests.length, 0); assert.equal(await stock(), 6);
  });
  await t.test('frozen server reservation survives later catalog price/availability changes and order-stage restart', async () => {
    const input = await request(); const mock = transportFixture(); const attempt = await store.reserve(input, configuration);
    await store.claim(input.attemptId, 'order'); const adapter = new SquareSandboxAdapter(configuration, mock.send); const intent = sandboxIntent(attempt.catalog_snapshot, { items: input.items, currency: 'USD', fulfillment: 'pickup' }, attempt.checkout_id);
    const order = await adapter.createOrder(intent); await store.recordOrder(input.attemptId, order);
    await db.query('UPDATE catalog_variants SET price_minor=9999,enabled=false WHERE id=$1', [candle.variantId]); await reopen();
    const result = await new PreparedSandboxCheckout(store, dependencies(mock)).submit(input, cardToken); assert.equal(result.state, 'completed'); assert.equal(result.amountMinor, 2400);
    assert.equal(mock.requests.filter((call) => call.url.endsWith('/orders')).length, 1); assert.equal(JSON.parse(mock.requests[1]!.body).amount_money.amount, 2400);
    const restored = new SquareSandboxAdapter(configuration, mock.send); const stored = await store.get(input.attemptId); const restoredIntent = sandboxIntent(stored.catalog_snapshot, { items: input.items, currency: 'USD', fulfillment: 'pickup' }, stored.checkout_id);
    assert.throws(() => restored.restoreOrder(restoredIntent, { ...order, amountMinor: 1 }), /Persisted order context/);
  });
  await t.test('competing prepared/simulated last-unit reservations share the stock constraint', async () => {
    await db.query('UPDATE catalog_variants SET stock_quantity=1 WHERE id=$1', [candle.variantId]); const a = await request(); const b = { ...a, attemptId: randomUUID() }; const mock = transportFixture();
    const results = await Promise.allSettled([new PreparedSandboxCheckout(store, dependencies(mock)).submit(a, cardToken), new DurableCheckoutService(legacy).checkout(b)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1); assert.equal(await stock(), 0);
    assert.equal(await count('sandbox_checkout_attempts') + await count('checkout_attempts'), 1); assert.ok(mock.requests.length === 0 || mock.requests.length === 2);
  });
  await t.test('tokenization cancellation releases only never-dispatched holds; repeated cancellation is harmless', async () => {
    const input = await request(); const mock = transportFixture(); const service = new PreparedSandboxCheckout(store, dependencies(mock));
    const client = preparedSandboxCardCheckout({ execution: 'injected-test-transport', port: service, card: { async tokenize() { throw new Error('synthetic-cancel'); } } });
    await assert.rejects(client.pay(input, { countryCode: 'US' }), /Keep this checkout identity/); assert.equal((await service.prepare(input)).state, 'failed'); assert.equal(await stock(), 7);
    await service.cancelBeforeDispatch(input); assert.equal(await stock(), 7); assert.equal(mock.requests.length, 0);
    const other = await request(); await service.prepare(other); await store.claim(other.attemptId, 'order'); await service.cancelBeforeDispatch(other);
    assert.equal((await store.get(other.attemptId)).state, 'order_sending'); assert.equal(await stock(), 6);
  });
  await t.test('definite order rejection and payment decline release stock once and never redispatch', async () => {
    for (const stage of ['order','payment'] as const) {
      const mock = transportFixture(); if (stage === 'order') mock.setOrderFault('reject'); else mock.setPaymentFault('decline');
      const input = await request(); const before = await stock(); const service = new PreparedSandboxCheckout(store, dependencies(mock)); const result = await service.submit(input, cardToken);
      assert.equal(result.state, 'failed'); assert.equal(result.failureCode, stage === 'order' ? 'ORDER_REJECTED' : 'PAYMENT_DECLINED'); assert.equal(await stock(), before);
      const calls = mock.requests.length; assert.deepEqual(await service.submit(input, cardToken), result); assert.equal(mock.requests.length, calls); assert.equal(await stock(), before);
    }
  });
  await t.test('unknown/malformed order outcomes retain stock and cannot automatically dispatch payment or order again', async () => {
    for (const fault of ['lost-before','lost-after','malformed'] as const) {
      const mock = transportFixture(); mock.setOrderFault(fault); const input = await request(); const before = await stock(); const service = new PreparedSandboxCheckout(store, dependencies(mock));
      const result = await service.submit(input, cardToken); assert.equal(result.state, 'review'); assert.equal(result.requiresReconciliation, true); assert.equal(await stock(), before - 1);
      await reopen(); const retry = await new PreparedSandboxCheckout(store, dependencies(mock)).submit(input, cardToken); assert.deepEqual(retry, result); assert.equal(mock.requests.length, 1); assert.equal(result.paymentId, null);
    }
  });
  await t.test('unknown/malformed/auth payment outcomes retain stock and cannot automatically dispatch again', async () => {
    for (const fault of ['lost-before','lost-after','malformed','auth'] as const) {
      const mock = transportFixture(); mock.setPaymentFault(fault); const input = await request(); const before = await stock(); const service = new PreparedSandboxCheckout(store, dependencies(mock));
      const result = await service.submit(input, cardToken); assert.equal(result.state, 'review'); assert.equal(result.failureCode, 'PAYMENT_OUTCOME_UNKNOWN'); assert.equal(await stock(), before - 1);
      assert.ok(result.orderId); assert.equal(result.paymentId, null); await reopen(); await new PreparedSandboxCheckout(store, dependencies(mock)).submit(input, cardToken); assert.equal(mock.requests.length, 2);
      await new PreparedSandboxCheckout(store, dependencies(mock)).cancelBeforeDispatch(input); assert.equal(await stock(), before - 1);
    }
  });
  await t.test('persisted dispatch claims surviving interruption never assume an unsent request', async () => {
    const mock = transportFixture(); const input = await request(); await store.reserve(input, configuration); await store.claim(input.attemptId, 'order'); await reopen();
    const service = new PreparedSandboxCheckout(store, dependencies(mock)); const result = await service.submit(input, cardToken); assert.equal(result.state, 'order_sending'); assert.equal(result.requiresReconciliation, true); assert.equal(mock.requests.length, 0); assert.equal(await stock(), 6);
  });
  await t.test('persistence failure after mocked payment effect holds review rather than duplicating the effect', async () => {
    class FailingStore extends PreparedSandboxStore { override async recordPayment() { throw new Error('private-database-error'); } }
    const mock = transportFixture(); const input = await request(); const broken = new PreparedSandboxCheckout(new FailingStore(db), dependencies(mock));
    const result = await broken.submit(input, cardToken); assert.equal(result.state, 'review'); assert.equal(result.paymentId, null); assert.equal(mock.effects.size, 2); assert.equal(await stock(), 6);
    await reopen(); await new PreparedSandboxCheckout(store, dependencies(mock)).submit(input, cardToken); assert.equal(mock.requests.length, 2); assert.equal(await stock(), 6);
  });
  await t.test('a reused provider order identity across different attempts cannot create a second local linked order or payment', async () => {
    const mock = transportFixture(); const first = await request(); const firstService = new PreparedSandboxCheckout(store, dependencies(mock));
    const completed = await firstService.submit(first, cardToken); const second = await request([granola]); const before = await stock(granola.variantId);
    const colliding = new PreparedSandboxCheckout(store, { ...dependencies(mock), transport: async (call) => {
      const response = await mock.send(call);
      return call.url.endsWith('/orders') ? { ...response, body: { order: { ...(response.body as { order: object }).order, id: completed.orderId } } } : response;
    } });
    const result = await colliding.submit(second, cardToken); assert.equal(result.state, 'review'); assert.equal(result.orderId, null); assert.equal(result.paymentId, null);
    assert.equal(mock.requests.filter((call) => call.url.endsWith('/payments')).length, 1); assert.equal(await stock(granola.variantId), before - 1);
    assert.equal((await db.query<{ count: number }>('SELECT count(order_id)::integer AS count FROM sandbox_checkout_attempts')).rows[0]!.count, 1);
  });
  await t.test('pending/approved payments remain held, require reconciliation and never authorize fulfillment', async () => {
    for (const status of ['PENDING','APPROVED'] as const) {
      const mock = transportFixture(); mock.setPaymentStatus(status); const input = await request(); const service = new PreparedSandboxCheckout(store, dependencies(mock)); const before = await stock();
      const result = await service.submit(input, cardToken); assert.equal(result.state, 'pending'); assert.equal(result.fulfillmentAuthorized, false); assert.equal(result.requiresReconciliation, true); assert.equal(await stock(), before - 1);
      const reservations = await db.query<{ state: string }>('SELECT state FROM sandbox_checkout_reservations WHERE attempt_id=$1', [input.attemptId]); assert.equal(reservations.rows[0]!.state, 'held');
      await service.submit(input, cardToken); assert.equal(mock.requests.length, 2);
    }
  });
  await t.test('client deduplicates identical in-flight requests and refuses changed prepare identity/amount before tokenization', async () => {
    const mock = transportFixture(); const input = await request(); const service = new PreparedSandboxCheckout(store, dependencies(mock)); let tokens = 0;
    const client = preparedSandboxCardCheckout({ execution: 'injected-test-transport', port: service, card: { async tokenize() { tokens++; return cardToken; } } });
    const a = client.pay(input, { countryCode: 'US' }); const b = client.pay(input, { countryCode: 'US' });
    await assert.rejects(client.pay({ ...input, attemptId: randomUUID() }, { countryCode: 'US' }), /Another checkout identity/);
    await Promise.all([a,b]); assert.equal(tokens, 1); assert.equal(mock.requests.length, 2);
    const other = await request([granola]); const port: SandboxCheckoutPort = { prepare: async (request) => ({ ...await service.prepare(request), amountMinor: 1 }), submit: (request, token) => service.submit(request, token), cancelBeforeDispatch: (request) => service.cancelBeforeDispatch(request) };
    const unsafe = preparedSandboxCardCheckout({ execution: 'injected-test-transport', port, card: { async tokenize() { tokens++; return cardToken; } } });
    await assert.rejects(unsafe.pay(other, { countryCode: 'US' }), /context changed/); assert.equal(tokens, 1); assert.equal(mock.requests.length, 2);
  });
});
