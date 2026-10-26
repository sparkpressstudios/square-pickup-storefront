import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { demoCatalog } from '../config/demo-catalog';
import { CheckoutError, parseCartRequest, type CartRequest, type CheckoutRequest, type CheckoutErrorCode } from '../shared/checkout';
import { DemoCheckoutService } from '../server/src/demo-checkout';
import { MockDecline, MockSquareAdapter, type MockSquareBoundary } from '../server/src/mock-square';
import { createApp } from '../server/src/app';

const candle = { productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 };
const granola = { productId: 'pantry-granola', variantId: 'granola-maple', quantity: 1 };
const cart = (items = [candle]): CartRequest => ({ items, currency: 'USD', fulfillment: 'pickup' });
function request(service: DemoCheckoutService, body = cart()): CheckoutRequest {
  const quote = service.quote(body);
  return { ...body, attemptId: randomUUID(), demoSessionId: quote.demoSessionId, expectedTotalMinor: quote.totalMinor };
}
const code = (expected: CheckoutErrorCode) => (error: unknown) => error instanceof CheckoutError && error.code === expected;

test('mixed food/non-food cart uses server catalog prices and explicit pickup/USD subtotal', () => {
  const service = new DemoCheckoutService(demoCatalog);
  const quote = service.quote(cart([{ ...candle, quantity: 2 }, granola]));
  assert.equal(quote.totalMinor, 5600);
  assert.deepEqual(quote.lines.map((line) => line.unitPriceMinor), [800, 2400]);
  assert.equal(quote.currency, 'USD'); assert.equal(quote.fulfillment, 'pickup');
  assert.equal(quote.pricing, 'demo-subtotal-only');
  assert.equal(service.getCatalog().products[0]!.variants[0]!.stockQuantity, 7);
});

test('quantities must be numeric positive integers within the bounded limit', () => {
  const service = new DemoCheckoutService(demoCatalog);
  for (const quantity of [0, -1, 0.5, '1', null, undefined, Number.NaN, Infinity, 100, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => service.quote(cart([{ ...candle, quantity: quantity as number }])), code('INVALID_QUANTITY'));
  }
  assert.throws(() => service.quote(cart([{ ...candle, quantity: 99 }, candle])), code('INVALID_QUANTITY'));
});

test('unknown, mismatched, sold-out, disabled, and excessive-stock variants cannot be quoted', () => {
  const service = new DemoCheckoutService(demoCatalog);
  for (const [item, error] of [
    [{ ...candle, variantId: 'unknown-variant' }, 'UNKNOWN_VARIANT'],
    [{ ...candle, productId: 'ceramic-tray' }, 'UNKNOWN_VARIANT'],
    [{ ...candle, variantId: 'candle-sage-amber' }, 'INSUFFICIENT_STOCK'],
    [{ ...candle, variantId: 'candle-sage-chalk' }, 'UNAVAILABLE'],
    [{ ...candle, quantity: 8 }, 'INSUFFICIENT_STOCK'],
  ] as const) assert.throws(() => service.quote(cart([item])), code(error));
});

test('strict request fields reject price, totals, payment/card input, unsupported currency, and non-pickup', () => {
  const service = new DemoCheckoutService(demoCatalog);
  for (const input of [
    { ...cart(), totalMinor: 1 },
    { ...cart(), items: [{ ...candle, priceMinor: 1 }] },
    { ...cart(), currency: 'EUR' }, { ...cart(), fulfillment: 'shipping' },
    { ...cart(), sourceId: 'not-accepted' }, { ...cart(), customer: {} },
    { ...cart(), items: [] }, { ...cart(), items: Array(51).fill(candle) },
    Object.create(cart()),
  ]) assert.throws(() => service.quote(input), code('INVALID_REQUEST'));
});

test('tampered or stale expected totals fail before the mock payment boundary', async () => {
  const adapter = new MockSquareAdapter(); const service = new DemoCheckoutService(demoCatalog, adapter);
  await assert.rejects(service.checkout({ ...request(service), expectedTotalMinor: 1 }), code('PRICE_CHANGED'));
  assert.equal(adapter.simulatedPaymentCount, 0);
  assert.equal(service.getCatalog().products[0]!.variants[0]!.stockQuantity, 7);
});

test('invalid checkout quantities, identities, and combined stock never reach simulated payment', async () => {
  const adapter = new MockSquareAdapter(); const service = new DemoCheckoutService(demoCatalog, adapter);
  const base = request(service);
  for (const [items, error] of [
    [[{ ...candle, quantity: 0 }], 'INVALID_QUANTITY'],
    [[{ ...candle, quantity: 1.5 }], 'INVALID_QUANTITY'],
    [[{ ...candle, variantId: 'unknown-variant' }], 'UNKNOWN_VARIANT'],
    [[{ ...candle, productId: 'ceramic-tray' }], 'UNKNOWN_VARIANT'],
    [[{ ...candle, variantId: 'candle-sage-amber' }], 'INSUFFICIENT_STOCK'],
    [[{ ...candle, variantId: 'candle-sage-chalk' }], 'UNAVAILABLE'],
    [[{ ...candle, quantity: 4 }, { ...candle, quantity: 4 }], 'INSUFFICIENT_STOCK'],
  ] as const) await assert.rejects(service.checkout({ ...base, attemptId: randomUUID(), items }), code(error));
  assert.equal(adapter.simulatedPaymentCount, 0);
  assert.equal(service.getCatalog().products[0]!.variants[0]!.stockQuantity, 7);
});

test('duplicate parallel submissions return one identity and one simulated payment', async () => {
  const adapter = new MockSquareAdapter(); const service = new DemoCheckoutService(demoCatalog, adapter);
  const input = request(service);
  const receipts = await Promise.all(Array.from({ length: 20 }, () => service.checkout(input)));
  assert.ok(receipts.every((receipt) => receipt.checkoutId === receipts[0]!.checkoutId && receipt.mockPaymentId === receipts[0]!.mockPaymentId));
  assert.equal(adapter.simulatedPaymentCount, 1);
  assert.equal(service.getCatalog().products[0]!.variants[0]!.stockQuantity, 6);
  assert.equal(receipts[0]!.status, 'simulated'); assert.equal(receipts[0]!.fulfillmentAuthorized, false);
  assert.deepEqual(await service.checkout(input), receipts[0]);
});

test('equivalent reordered/split lines share identity but changed carts/totals conflict', async () => {
  const adapter = new MockSquareAdapter(); const service = new DemoCheckoutService(demoCatalog, adapter);
  const input = request(service, cart([{ ...candle, quantity: 2 }, granola]));
  const receipt = await service.checkout(input);
  assert.deepEqual(await service.checkout({ ...input, items: [granola, candle, candle] }), receipt);
  await assert.rejects(service.checkout({ ...input, expectedTotalMinor: input.expectedTotalMinor + 1 }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(service.checkout({ ...input, items: [candle] }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(adapter.simulatedPaymentCount, 1);
});

test('same-process competing last-item requests cannot both simulate payment', async () => {
  const adapter = new MockSquareAdapter(); const service = new DemoCheckoutService(demoCatalog, adapter);
  const body = cart([{ productId: 'wick-trimmer', variantId: 'trimmer-brass', quantity: 1 }]);
  const a = request(service, body); const b = request(service, body);
  const results = await Promise.allSettled([service.checkout(a), service.checkout(b)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(code('INSUFFICIENT_STOCK')(failed.reason));
  assert.equal(adapter.simulatedPaymentCount, 1);
  assert.equal(service.getCatalog().products[2]!.variants[0]!.stockQuantity, 0);
});

test('old server-session requests fail closed after restart instead of simulating again', async () => {
  const first = new DemoCheckoutService(demoCatalog); const input = request(first);
  await first.checkout(input);
  const adapter = new MockSquareAdapter(); const restarted = new DemoCheckoutService(demoCatalog, adapter);
  await assert.rejects(restarted.checkout(input), code('DEMO_SESSION_EXPIRED'));
  assert.equal(adapter.simulatedPaymentCount, 0);
});

test('definite mock decline restores stock and retries do not rerun the boundary', async () => {
  let calls = 0;
  const adapter: MockSquareBoundary = { mode: 'mock-only', async simulatePayment() { calls += 1; throw new MockDecline(); } };
  const service = new DemoCheckoutService(demoCatalog, adapter); const input = request(service);
  await assert.rejects(service.checkout(input), code('MOCK_DECLINED'));
  await assert.rejects(service.checkout(input), code('MOCK_DECLINED'));
  assert.equal(calls, 1); assert.equal(service.getCatalog().products[0]!.variants[0]!.stockQuantity, 7);
});

test('unknown mock outcome retains reservation and cached failure without a second simulated charge', async () => {
  const underlying = new MockSquareAdapter(); let calls = 0;
  const adapter: MockSquareBoundary = { mode: 'mock-only', async simulatePayment(input) { calls += 1; await underlying.simulatePayment(input); throw new Error('Response lost'); } };
  const service = new DemoCheckoutService(demoCatalog, adapter); const input = request(service);
  await assert.rejects(service.checkout(input), code('CHECKOUT_UNCERTAIN'));
  await assert.rejects(service.checkout(input), code('CHECKOUT_UNCERTAIN'));
  assert.equal(calls, 1); assert.equal(underlying.simulatedPaymentCount, 1);
  assert.equal(service.getCatalog().products[0]!.variants[0]!.stockQuantity, 6);
});

test('mock boundary itself deduplicates and rejects amount changes with the same key', async () => {
  const adapter = new MockSquareAdapter(); const input = { idempotencyKey: 'one-mock-payment', amountMinor: 2400, currency: 'USD' as const };
  const [a, b] = await Promise.all([adapter.simulatePayment(input), adapter.simulatePayment(input)]);
  assert.deepEqual(a, b); assert.equal(adapter.simulatedPaymentCount, 1);
  await assert.rejects(adapter.simulatePayment({ ...input, amountMinor: 1 }), /conflict/);
});

test('total overflow and malformed attempt identity fail before simulation', async () => {
  const catalog = structuredClone(demoCatalog);
  (catalog.products[0]!.variants[0]! as unknown as { priceMinor: number }).priceMinor = 2_147_483_647;
  const service = new DemoCheckoutService(catalog);
  assert.throws(() => service.quote(cart([{ ...candle, quantity: 2 }])), code('INVALID_REQUEST'));
  await assert.rejects(service.checkout({ ...request(service), attemptId: 'new-on-every-retry' }), code('INVALID_REQUEST'));
  assert.throws(() => parseCartRequest({ ...cart(), items: [{ ...candle, quantity: '1' }] }), code('INVALID_QUANTITY'));
});

test('loopback API validates checkout, returns stable mock receipt, and rejects malformed/cross-origin input', async (t) => {
  const app = await createApp(); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, extraHeaders = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  const quoteResponse = await post('/api/demo/quote', cart([candle, granola]));
  assert.equal(quoteResponse.status, 200); const quote = await quoteResponse.json();
  const input = { ...cart([candle, granola]), attemptId: randomUUID(), demoSessionId: quote.demoSessionId, expectedTotalMinor: quote.totalMinor };
  const first = await post('/api/demo/checkouts', input); const receipt = await first.json();
  assert.equal(first.status, 200); assert.equal(receipt.status, 'simulated'); assert.equal(receipt.totalMinor, 3200);
  assert.equal(receipt.fulfillmentAuthorized, false);
  assert.deepEqual(await (await post('/api/demo/checkouts', input)).json(), receipt);
  const storefront = await (await fetch(`${origin}/api/storefront`)).json();
  assert.equal(storefront.catalog.products[0].variants[0].stockQuantity, 6);
  assert.equal(storefront.capabilities.checkout, false); assert.equal(storefront.capabilities.square, false);
  const invalid = await post('/api/demo/quote', cart([{ ...candle, quantity: 0 }]));
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'INVALID_QUANTITY');
  assert.equal((await post('/api/demo/quote', cart(), { Origin: 'https://unrelated.invalid' })).status, 403);
  assert.equal((await fetch(`${origin}/api/demo/quote`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(`${origin}/api/demo/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await post('/api/demo/quote', { ...cart(), padding: 'x'.repeat(17000) })).status, 413);
  assert.equal((await post('/api/checkout', input)).status, 404);
});
