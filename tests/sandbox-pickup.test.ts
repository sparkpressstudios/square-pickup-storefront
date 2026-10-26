import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { demoCatalog } from '../config/demo-catalog';
import { SquareSandboxAdapter, SandboxError, sandboxConfiguration, sandboxIntent } from '../server/src/square-sandbox';
import { SANDBOX_PICKUP_CONTACT, sandboxPickupFulfillments, matchesSandboxPickupOrder } from '../server/src/sandbox-pickup';

const config = sandboxConfiguration({
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_APPLICATION_ID: 'sandbox-sq0idb-unit-test',
  SQUARE_LOCATION_ID: 'TESTLOCATION',
  SQUARE_SANDBOX_ACCESS_TOKEN: 'synthetic-token-for-tests-only',
});
const cart = { items: [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }], currency: 'USD', fulfillment: 'pickup' };

test('sandbox pickup recipient is always fictional, never a customer record or real notification target', () => {
  assert.deepEqual(SANDBOX_PICKUP_CONTACT, {
    display_name: 'Sandbox Test Shopper',
    email_address: 'shopper@example.invalid',
    phone_number: '+12025550100',
  });
  const a = sandboxPickupFulfillments();
  const b = sandboxPickupFulfillments();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  assert.equal(a[0]?.state, 'PROPOSED');
  assert.equal(a[0]?.type, 'PICKUP');
  assert.equal(a[0]?.pickup_details.schedule_type, 'ASAP');
  assert.equal(a[0]?.pickup_details.prep_time_duration, 'PT15M');
  assert.match(a[0]?.pickup_details.note ?? '', /SANDBOX TEST ONLY/);
  assert.ok(matchesSandboxPickupOrder({ fulfillments: a }));
});

test('real Square sandbox order request includes pickup details, but never taxes or actual customer data', async () => {
  const intent = sandboxIntent(demoCatalog, cart, randomUUID());
  const sent: Record<string, unknown>[] = [];
  const adapter = new SquareSandboxAdapter(config, async (request) => {
    assert.equal(request.url, 'https://connect.squareupsandbox.com/v2/orders');
    const body = JSON.parse(request.body);
    sent.push(body);
    return { status: 200, body: { order: { ...body.order, id: 'ORDER_UNIT', total_money: { amount: 2400, currency: 'USD' }, total_tax_money: { amount: 0, currency: 'USD' } } } };
  });
  const result = await adapter.createOrder(intent);
  assert.equal(result.amountMinor, 2400);
  const body = sent[0] as { idempotency_key: string; order: Record<string, unknown> };
  assert.equal(body.idempotency_key, 'ord_' + intent.checkoutId);
  assert.deepEqual(body.order.fulfillments, sandboxPickupFulfillments());
  assert.equal(body.order.reference_id, intent.checkoutId);
  assert.equal(body.order.taxes, undefined);
  assert.equal(body.order.customer_id, undefined);
  assert.doesNotMatch(JSON.stringify(body), /real.person|customer_id|email_address.*@gmail/);
});

test('missing, changed or multiple fulfillments and nonzero taxes fail before payment', async () => {
  const intent = sandboxIntent(demoCatalog, cart, randomUUID());
  const good = sandboxPickupFulfillments();
  const invalid: Record<string, unknown>[] = [
    { fulfillments: [] },
    { fulfillments: undefined },
    { fulfillments: [{ ...good[0], type: 'SHIPMENT' }] },
    { fulfillments: [{ ...good[0], pickup_details: { ...good[0]!.pickup_details, recipient: { display_name: 'Wrong shopper' } } }] },
    { fulfillments: [...good, ...good] },
    { fulfillments: good, total_tax_money: { amount: 1, currency: 'USD' } },
    { fulfillments: good, total_tax_money: { amount: 0, currency: 'EUR' } },
  ];
  for (const mismatch of invalid) {
    let requests = 0;
    const adapter = new SquareSandboxAdapter(config, async (request) => {
      requests++;
      const body = JSON.parse(request.body);
      return { status: 200, body: { order: { id: 'ORDER_UNIT', ...body.order, total_money: { amount: 2400, currency: 'USD' }, ...mismatch } } };
    });
    await assert.rejects(adapter.createOrder(intent), (err: unknown) => err instanceof SandboxError && err.code === 'INVALID_RESPONSE');
    assert.equal(requests, 1);
  }
});
