import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { demoCatalog } from '../config/demo-catalog';
import { createApp, capabilities } from '../server/src/app';

test('local API exposes synthetic catalog, authoritative variants, and disabled real services', async (t) => {
  const app = await createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${origin}/api/storefront`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-powered-by'), null);
  const payload = await response.json();
  assert.equal(payload.mode, 'synthetic-demo');
  assert.equal(payload.merchant.currency, 'USD');
  assert.equal(payload.merchant.fulfillment, 'pickup');
  assert.deepEqual(payload.capabilities, capabilities);
  assert.equal(payload.capabilities.mockCheckout, true);
  assert.ok(Object.entries(payload.capabilities).filter(([name]) => name !== 'mockCheckout').every(([, flag]) => flag === false));
  assert.deepEqual(payload.catalog, demoCatalog);

  const detail = await fetch(`${origin}/api/catalog/studio-candle`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).product.variants[0].priceMinor, 2400);
  assert.equal((await fetch(`${origin}/api/catalog/not-a-product`)).status, 404);
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  for (const route of ['/api/checkout', '/api/payments', '/api/orders', '/api/email', '/api/jobs', '/api/storefront']) {
    const result = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priceMinor: 1 }) });
    assert.equal(result.status, 404, `${route} must not accept writes`);
  }
});

test('startup fails closed for an invalid repository snapshot', async () => {
  await assert.rejects(createApp({ async load() { return { ...demoCatalog, products: [{ ...demoCatalog.products[0]!, variants: [] }] }; } }), /no variants/);
});

test('serving is isolated from later mutations of injected repository data', async (t) => {
  const catalog = structuredClone(demoCatalog);
  const app = await createApp({ async load() { return catalog; } });
  const variant = catalog.products[0]!.variants[0]! as unknown as { priceMinor: number };
  variant.priceMinor = 1;
  (catalog as unknown as { currency: string }).currency = 'EUR';
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const detail = await (await fetch(`${origin}/api/catalog/studio-candle`)).json();
  assert.equal(detail.product.variants[0].priceMinor, 2400);
  assert.equal(detail.currency, 'USD');
  assert.equal((await (await fetch(`${origin}/api/storefront`)).json()).catalog.products[0].variants[0].priceMinor, 2400);
});

test('demo startup never calls fetch or enables provider capabilities', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('External request forbidden'); };
  try {
    await createApp();
    assert.equal(calls, 0);
    assert.deepEqual(capabilities, { checkout: false, mockCheckout: true, square: false, outboundMail: false, schedulers: false, databaseConnected: false });
  } finally { globalThis.fetch = original; }
});
