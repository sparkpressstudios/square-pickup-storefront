import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { demoCatalog } from '../config/demo-catalog';
import { SquareSandboxAdapter, SandboxError, publicSandboxConfiguration, sandboxConfiguration, sandboxIntent, sandboxKeys, squareApiVersion, type SandboxTransportRequest } from '../server/src/square-sandbox';

const values = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-unit-application', SQUARE_LOCATION_ID: 'TESTLOCATION01', SQUARE_SANDBOX_ACCESS_TOKEN: 'unit-test-only-access-token' };
const cart = { items: [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }], currency: 'USD', fulfillment: 'pickup' };
const code = (value: SandboxError['code']) => (error: unknown) => error instanceof SandboxError && error.code === value;
function transport() {
  const requests: SandboxTransportRequest[] = []; const effects = new Map<string, unknown>();
  const send = async (request: SandboxTransportRequest) => {
    requests.push(request); const body = JSON.parse(request.body);
    if (!effects.has(body.idempotency_key)) effects.set(body.idempotency_key, request.url.endsWith('/orders') ? { order: { id: 'ORDER_TEST', ...body.order, total_money: { amount: 2400, currency: 'USD' } } } : { payment: { id: 'PAYMENT_TEST', ...body, status: 'COMPLETED' } });
    return { status: 200, body: effects.get(body.idempotency_key) };
  };
  return { requests, effects, send };
}

test('sandbox configuration refuses missing credentials, IDs, and non-sandbox environments', () => {
  for (const field of Object.keys(values)) assert.throws(() => sandboxConfiguration({ ...values, [field]: undefined }), code('CONFIGURATION'));
  for (const bad of [{ ...values, SQUARE_ENVIRONMENT: 'production' }, { ...values, SQUARE_APPLICATION_ID: 'sq0idp-production' }, { ...values, SQUARE_SANDBOX_ACCESS_TOKEN: ' ' }, { ...values, SQUARE_LOCATION_ID: 'other\nlocation' }]) assert.throws(() => sandboxConfiguration(bad), code('CONFIGURATION'));
});

test('public metadata and serialized adapter never expose its access token', () => {
  const config = sandboxConfiguration(values); const mock = transport(); const adapter = new SquareSandboxAdapter(config, mock.send);
  assert.deepEqual(Object.keys(publicSandboxConfiguration(config)).sort(), ['applicationId','environment','locationId']);
  assert.doesNotMatch(JSON.stringify(adapter), /access-token|Bearer/);
  assert.equal(mock.requests.length, 0);
});

test('order/payment requests use only sandbox endpoint, version, authoritative total, and distinct stable keys', async () => {
  const mock = transport(); const intent = sandboxIntent(demoCatalog, cart, randomUUID());
  const adapter = new SquareSandboxAdapter(sandboxConfiguration(values), mock.send);
  const order = await adapter.createOrder(intent); const payment = await adapter.createPayment(intent, order, 'unit-card-token');
  assert.equal(payment.status, 'COMPLETED'); assert.equal(payment.amountMinor, 2400);
  assert.deepEqual(mock.requests.map((request) => request.url), ['https://connect.squareupsandbox.com/v2/orders', 'https://connect.squareupsandbox.com/v2/payments']);
  for (const request of mock.requests) { assert.equal(request.redirect, 'error'); assert.equal(request.headers['Square-Version'], squareApiVersion); }
  const orderBody = JSON.parse(mock.requests[0]!.body); const paymentBody = JSON.parse(mock.requests[1]!.body);
  assert.equal(orderBody.order.line_items[0].base_price_money.amount, 2400);
  assert.equal(paymentBody.amount_money.amount, 2400); assert.equal(paymentBody.location_id, values.SQUARE_LOCATION_ID);
  assert.equal(paymentBody.order_id, order.id); assert.equal(paymentBody.reference_id, intent.checkoutId);
  assert.notEqual(orderBody.idempotency_key, paymentBody.idempotency_key); assert.ok(paymentBody.idempotency_key.length <= 45);
});

test('reconstructed adapters/intents preserve provider keys and mocked retries produce one payment effect', async () => {
  const mock = transport(); const checkoutId = randomUUID();
  for (let index = 0; index < 2; index += 1) {
    const adapter = new SquareSandboxAdapter(sandboxConfiguration(values), mock.send); const intent = sandboxIntent(demoCatalog, cart, checkoutId);
    const order = await adapter.createOrder(intent); await adapter.createPayment(intent, order, 'same-unit-card-token');
  }
  assert.equal(mock.effects.size, 2); // One order effect and one payment effect.
  assert.deepEqual(sandboxKeys(checkoutId), sandboxKeys(checkoutId.toUpperCase()));
  assert.equal(JSON.parse(mock.requests[1]!.body).idempotency_key, JSON.parse(mock.requests[3]!.body).idempotency_key);
});

test('client price fields, forged intents, and mutation cannot alter authoritative money', async () => {
  assert.throws(() => sandboxIntent(demoCatalog, { ...cart, items: [{ ...cart.items[0], priceMinor: 1 }] }, randomUUID()));
  const intent = sandboxIntent(demoCatalog, cart, randomUUID()); const mock = transport(); const adapter = new SquareSandboxAdapter(sandboxConfiguration(values), mock.send);
  assert.throws(() => { (intent.quote as unknown as { totalMinor: number }).totalMinor = 1; }, TypeError);
  await assert.rejects(adapter.createOrder({ ...intent, quote: { ...intent.quote, totalMinor: 1 } }), code('REJECTED'));
  assert.equal(mock.requests.length, 0);
});

test('unverified orders and non-card source methods cannot reach payment transport', async () => {
  const intent = sandboxIntent(demoCatalog, cart, randomUUID()); const mock = transport(); const adapter = new SquareSandboxAdapter(sandboxConfiguration(values), mock.send);
  await assert.rejects(adapter.createPayment(intent, { id: 'UNVERIFIED_ORDER' }, 'unit-card-token'), code('REJECTED'));
  const order = await adapter.createOrder(intent);
  for (const token of ['', 'CASH', 'EXTERNAL', 'bad token']) await assert.rejects(adapter.createPayment(intent, order, token), code('REJECTED'));
  assert.equal(mock.requests.length, 1);
});

test('mismatched order subtotal/location/reference never creates an accepted order', async () => {
  const intent = sandboxIntent(demoCatalog, cart, randomUUID());
  for (const mismatch of [{ total_money: { amount: 1, currency: 'USD' } }, { location_id: 'WRONGLOCATION' }, { reference_id: randomUUID() }]) {
    const adapter = new SquareSandboxAdapter(sandboxConfiguration(values), async () => ({ status: 200, body: { order: { id: 'ORDER_TEST', location_id: values.SQUARE_LOCATION_ID, reference_id: intent.checkoutId, total_money: { amount: 2400, currency: 'USD' }, ...mismatch } } }));
    await assert.rejects(adapter.createOrder(intent), code('INVALID_RESPONSE'));
  }
});

test('payment response must match identity, location, order, reference, and currency/amount', async () => {
  const intent = sandboxIntent(demoCatalog, cart, randomUUID());
  for (const mismatch of [{ amount_money: { amount: 1, currency: 'USD' } }, { amount_money: { amount: 2400, currency: 'EUR' } }, { location_id: 'WRONGLOCATION' }, { order_id: 'OTHER_ORDER' }, { reference_id: randomUUID() }, { id: 'mock_wrong' }, { status: 'UNRECOGNIZED' }]) {
    const mock = transport(); const adapter = new SquareSandboxAdapter(sandboxConfiguration(values), async (request) => {
      if (request.url.endsWith('/orders')) return mock.send(request);
      return { status: 200, body: { payment: { id: 'PAYMENT_TEST', ...JSON.parse(request.body), status: 'COMPLETED', ...mismatch } } };
    });
    await assert.rejects(adapter.createPayment(intent, await adapter.createOrder(intent), 'unit-card-token'), code('INVALID_RESPONSE'));
  }
});

test('pending/approved sandbox responses are distinct from completed payment', async () => {
  for (const status of ['PENDING', 'APPROVED'] as const) {
    const intent = sandboxIntent(demoCatalog, cart, randomUUID()); const mock = transport();
    const adapter = new SquareSandboxAdapter(sandboxConfiguration(values), async (request) => request.url.endsWith('/orders') ? mock.send(request) : { status: 200, body: { payment: { id: 'PAYMENT_TEST', ...JSON.parse(request.body), status } } });
    assert.equal((await adapter.createPayment(intent, await adapter.createOrder(intent), 'unit-card-token')).status, status);
  }
});

test('transport/auth/decline errors are sanitized, and unknown outcomes do not retry automatically', async () => {
  const intent = sandboxIntent(demoCatalog, cart, randomUUID());
  for (const [status, errorCode] of [[401,'AUTHENTICATION'], [403,'AUTHENTICATION'], [400,'DECLINED'], [429,'UNKNOWN_OUTCOME'], [500,'UNKNOWN_OUTCOME']] as const) {
    let calls = 0;
    const adapter = new SquareSandboxAdapter(sandboxConfiguration(values), async () => { calls += 1; return { status, body: { errors: [{ code: 'CARD_DECLINED', detail: values.SQUARE_SANDBOX_ACCESS_TOKEN }] } }; });
    await assert.rejects(adapter.createOrder(intent), (error: unknown) => code(errorCode)(error) && !(error as Error).message.includes(values.SQUARE_SANDBOX_ACCESS_TOKEN));
    assert.equal(calls, 1);
  }
  const unavailable = new SquareSandboxAdapter(sandboxConfiguration(values), async () => { throw new Error(values.SQUARE_SANDBOX_ACCESS_TOKEN); });
  await assert.rejects(unavailable.createOrder(intent), code('UNKNOWN_OUTCOME'));
});
