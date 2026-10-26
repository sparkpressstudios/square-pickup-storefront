import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MerchantSquareProvider, MerchantProviderError, type MerchantPayment } from '../server/src/merchant-square-provider';
import { sandboxConfiguration } from '../server/src/square-sandbox';
const config = sandboxConfiguration({ SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-provider-test', SQUARE_LOCATION_ID: 'TESTLOCATION', SQUARE_SANDBOX_ACCESS_TOKEN: 'unit-test-private-token' });
const lines = [{ variantId: 'item-one', squareVariationId: 'SQUAREVAR1', quantity: 2 }];
const pickup = { name: 'Test Shopper', email: 'shopper@example.invalid', phone: '+12025550100' };
const money = (amount: number) => ({ amount, currency: 'USD' });
const code = (wanted: MerchantProviderError['code']) => (error: unknown) => error instanceof MerchantProviderError && error.code === wanted;
function mock(options: { inclusive?: boolean; mutate?: (path: string, result: any) => void } = {}) {
  const requests: {path: string; body: any}[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://connect.squareupsandbox.com/v2/'));
    assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)); const path = new URL(String(url)).pathname; requests.push({ path, body });
    let result: any;
    const total = options.inclusive ? 1800 : 1980;
    if (path.startsWith('/v2/orders')) {
      result = { order: { ...body.order, id: path.endsWith('calculate') ? undefined : 'ORDER1',
        line_items: body.order.line_items.map((line: any) => ({ ...line, base_price_money: money(1000), gross_sales_money: money(options.inclusive ? 1820 : 2000), total_discount_money: money(200), total_tax_money: money(180), total_money: money(total) })),
        total_discount_money: money(200), total_tax_money: money(180), total_money: money(total) } };
    } else if (path === '/v2/payments') result = { payment: { ...body, id: 'PAYMENT1', status: 'COMPLETED' } };
    else result = { refund: { id: 'REFUND1', payment_id: body.payment_id, location_id: config.locationId, amount_money: body.amount_money, status: 'PENDING' } };
    options.mutate?.(path, result); return new Response(JSON.stringify(result), { status: 200 });
  };
  return { requests, provider: new MerchantSquareProvider(config, fetcher) };
}
test('authoritative additive and inclusive taxes flow through order, card payment and refund with stable keys', async () => {
  for (const inclusive of [false, true]) {
    const { provider, requests } = mock({ inclusive }); const checkoutId = randomUUID(); const refundId = randomUUID();
    const pricing = await provider.calculate(lines, checkoutId); assert.equal(pricing.totalMinor, inclusive ? 1800 : 1980);
    assert.equal(pricing.taxMinor, 180); assert.equal(pricing.discountMinor, 200);
    const order = await provider.createOrder(pricing, pickup); const payment = await provider.pay(order, 'unit-card-token');
    const refund = await provider.refund(payment, refundId, 500);
    assert.equal(payment.amountMinor, pricing.totalMinor); assert.equal(payment.fulfillmentAuthorized, false); assert.equal(refund.status, 'PENDING');
    assert.equal(requests[1]!.body.idempotency_key, 'ord_' + checkoutId); assert.equal(requests[2]!.body.idempotency_key, 'pay_' + checkoutId); assert.equal(requests[3]!.body.idempotency_key, 'ref_' + refundId);
    assert.deepEqual(requests[0]!.body.order.line_items, [{ catalog_object_id: 'SQUAREVAR1', quantity: '2' }]);
    assert.deepEqual(requests[0]!.body.order.pricing_options, { auto_apply_taxes: true, auto_apply_discounts: true });
    assert.equal(JSON.stringify({ pricing, order, payment, refund, provider }).includes('unit-card-token'), false);
    assert.equal(JSON.stringify(provider).includes('private-token'), false);
  }
});
test('persisted normalized evidence survives restart and JSON object key ordering', async () => {
  const first = mock(); const pricing = await first.provider.calculate(lines, randomUUID());
  const reordered = JSON.parse(JSON.stringify(pricing, (_key, value) => value && !Array.isArray(value) && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse()) : value));
  const next = mock(); const order = await next.provider.createOrder(reordered, pickup); const third = mock();
  assert.equal((await third.provider.pay(JSON.parse(JSON.stringify(order)), 'card-token')).status, 'COMPLETED');
  assert.equal(third.requests.length, 1);
});
test('changed catalog totals after calculation stop before payment', async () => {
  const { provider, requests } = mock({ mutate(path, result) { if (path === '/v2/orders') { result.order.total_money = money(1990); result.order.line_items[0].total_money = money(1990); } } });
  const pricing = await provider.calculate(lines, randomUUID());
  await assert.rejects(provider.createOrder(pricing, pickup), code('PRICE_CHANGED')); assert.equal(requests.length, 2);
});
test('foreign locations, quantities, duplicate mappings, currency and unbalanced provider evidence fail closed', async () => {
  for (const mutate of [
    (o: any) => { o.location_id = 'OTHER'; }, (o: any) => { o.line_items[0].quantity = '3'; },
    (o: any) => { o.line_items[0].catalog_object_id = 'OTHER'; }, (o: any) => { o.total_money.currency = 'EUR'; },
    (o: any) => { o.total_money.amount++; }, (o: any) => { o.total_service_charge_money = money(20); },
  ]) { const { provider } = mock({ mutate(_path, result) { mutate(result.order); } }); await assert.rejects(provider.calculate(lines, randomUUID()), code('UNVERIFIED_RESPONSE')); }
  const { provider, requests } = mock();
  await assert.rejects(provider.calculate([...lines, ...lines], randomUUID()), code('INVALID_INPUT'));
  await assert.rejects(provider.calculate(lines, 'not-uuid'), code('INVALID_INPUT')); assert.equal(requests.length, 0);
});
test('invalid tokens, pickup, context and uncompleted or excessive refunds never dispatch', async () => {
  const { provider, requests } = mock(); const quote = await provider.calculate(lines, randomUUID());
  await assert.rejects(provider.createOrder(quote, { ...pickup, phone: 'invalid' }), code('INVALID_INPUT'));
  const order = await provider.createOrder(quote, pickup); const count = requests.length;
  for (const token of ['', 'CASH','EXTERNAL','bad token']) await assert.rejects(provider.pay(order, token), code('INVALID_INPUT'));
  assert.equal(requests.length, count);
  const payment = await provider.pay(order, 'token');
  for (const change of [{ status: 'PENDING' }, { locationId: 'OTHER' }, { currency: 'EUR' }]) await assert.rejects(provider.refund({ ...payment, ...change } as MerchantPayment, randomUUID(), 100), code('INVALID_INPUT'));
  await assert.rejects(provider.refund(payment, randomUUID(), payment.amountMinor + 1), code('INVALID_INPUT'));
});
test('network, malformed/oversized successful replies and transient statuses preserve unknown outcome', async () => {
  const base = mock(); const order = await base.provider.createOrder(await base.provider.calculate(lines, randomUUID()), pickup);
  const cases: typeof fetch[] = [async () => { throw new Error('secret provider failure'); }, async () => new Response('not-json'), async () => new Response('{}', { headers: { 'content-length': String(300 * 1024) } }), async () => new Response('{}', { status: 500 }), async () => new Response('{}', { status: 429 })];
  for (const fetcher of cases) await assert.rejects(new MerchantSquareProvider(config, fetcher).pay(order, 'token'), code('UNKNOWN_OUTCOME'));
  await assert.rejects(new MerchantSquareProvider(config, async () => new Response(JSON.stringify({ errors: [{ code: 'CARD_DECLINED' }] }), { status: 400 })).pay(order, 'token'), code('DECLINED'));
});
test('payment and refund identity must match trusted order and payment', async () => {
  for (const target of ['payment','refund']) {
    const { provider } = mock({ mutate(path, result) { if (target === 'payment' && path === '/v2/payments') result.payment.order_id = 'OTHER'; if (target === 'refund' && path === '/v2/refunds') result.refund.payment_id = 'OTHER'; } });
    const order = await provider.createOrder(await provider.calculate(lines, randomUUID()), pickup);
    if (target === 'payment') await assert.rejects(provider.pay(order, 'token'), code('UNVERIFIED_RESPONSE'));
    else await assert.rejects(provider.refund(await provider.pay(order, 'token'), randomUUID(), 500), code('UNVERIFIED_RESPONSE'));
  }
});
test('production configuration is refused before any network call', () => {
  assert.throws(() => new MerchantSquareProvider({ ...config, environment: 'production' } as unknown as typeof config, async () => { throw new Error('never'); }));
});
test('zero-total promotions, oversized totals and malformed mapped lines fail without charging', async () => {
  for (const total of [0, 2_147_483_648]) {
    const { provider, requests } = mock({ mutate(_path, result) { result.order.total_money = money(total); result.order.line_items[0].total_money = money(total); } });
    await assert.rejects(provider.calculate(lines, randomUUID()), code('UNVERIFIED_RESPONSE')); assert.equal(requests.length, 1);
  }
  const { provider, requests } = mock();
  for (const quantity of [0, 100, 1.5, Number.NaN]) await assert.rejects(provider.calculate([{ ...lines[0]!, quantity }], randomUUID()), code('INVALID_INPUT'));
  assert.equal(requests.length, 0);
});
test('tampered persisted pricing or request payload is rejected before provider dispatch', async () => {
  const { provider, requests } = mock(); const quote = await provider.calculate(lines, randomUUID());
  for (const mutate of [
    (p: any) => { p.totalMinor = 1; }, (p: any) => { p.locationId = 'OTHER'; },
    (p: any) => { p.requestOrder.line_items[0].base_price_money = money(1); },
    (p: any) => { p.requestOrder.pricing_options.auto_apply_taxes = false; },
    (p: any) => { p.lineEvidence[0].unitPriceMinor = 1; },
  ]) { const p = structuredClone(quote); mutate(p); await assert.rejects(provider.createOrder(p, pickup), code('INVALID_INPUT')); }
  assert.equal(requests.length, 1);
});
test('refund timeout is unknown, while provider rejection stays distinct; replay retains refund key', async () => {
  const { provider, requests } = mock(); const order = await provider.createOrder(await provider.calculate(lines, randomUUID()), pickup); const payment = await provider.pay(order, 'token'); const refundId = randomUUID();
  await provider.refund(payment, refundId, 100); await provider.refund(payment, refundId, 100);
  assert.equal(requests[3]!.body.idempotency_key, requests[4]!.body.idempotency_key);
  await assert.rejects(new MerchantSquareProvider(config, async () => { throw new Error(); }).refund(payment, refundId, 100), code('UNKNOWN_OUTCOME'));
  await assert.rejects(new MerchantSquareProvider(config, async () => new Response('{}', { status: 403 })).refund(payment, refundId, 100), code('PROVIDER_REJECTED'));
});
test('read-only payment recovery finds exact match across pages and null never dispatches a payment', async () => {
  const base = mock(); const order = await base.provider.createOrder(await base.provider.calculate(lines, randomUUID()), pickup);
  const since = '2026-10-25T12:00:00Z'; let count = 0;
  const provider = new MerchantSquareProvider(config, async (url, init) => {
    const parsed = new URL(String(url)); assert.equal(parsed.origin, 'https://connect.squareupsandbox.com'); assert.equal(parsed.pathname, '/v2/payments');
    assert.equal(parsed.searchParams.get('location_id'), config.locationId); assert.equal(parsed.searchParams.get('begin_time'), since); assert.equal(parsed.searchParams.get('limit'), '100');
    assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); assert.equal(init?.redirect, 'error');
    count++;
    return new Response(JSON.stringify(count === 1 ? { payments: [{ id: 'UNRELATED', order_id: 'OTHER' }], cursor: 'page-two' } : { payments: [{ id: 'FOUND', order_id: order.id, reference_id: order.checkoutId, location_id: order.locationId, amount_money: money(order.totalMinor), status: 'COMPLETED', receipt_url: 'https://squareupsandbox.com/receipt/preview/recovered' }] }));
  });
  const recovered = await provider.findPayment(order, since); assert.equal(recovered?.id, 'FOUND'); assert.equal(recovered?.receiptUrl, 'https://squareupsandbox.com/receipt/preview/recovered'); assert.equal(count, 2);
  assert.equal(await new MerchantSquareProvider(config, async () => new Response('{}')).findPayment(order, since), null);
  await assert.rejects(provider.findPayment({ ...order, locationId: 'FORGED' }, since), code('INVALID_INPUT'));
  await assert.rejects(provider.findPayment(order, 'invalid-date'), code('INVALID_INPUT'));
});
test('payment recovery refuses conflicting identity, amount, currency, application and multiple matches', async () => {
  const base = mock(); const order = await base.provider.createOrder(await base.provider.calculate(lines, randomUUID()), pickup);
  const candidate = { id: 'FOUND', order_id: order.id, reference_id: order.checkoutId, location_id: order.locationId, amount_money: money(order.totalMinor), status: 'COMPLETED' };
  for (const change of [{ order_id: 'OTHER' }, { reference_id: randomUUID() }, { location_id: 'OTHER' }, { amount_money: money(1) }, { amount_money: { amount: order.totalMinor, currency: 'EUR' } }, { status: 'FAILED' }, { application_details: { application_id: 'OTHER' } }, { source_type: 'CASH' }]) {
    const provider = new MerchantSquareProvider(config, async () => new Response(JSON.stringify({ payments: [{ ...candidate, ...change }] })));
    await assert.rejects(provider.findPayment(order, '2026-10-25T12:00:00Z'), code('UNKNOWN_OUTCOME'));
  }
  const multiple = new MerchantSquareProvider(config, async () => new Response(JSON.stringify({ payments: [candidate, { ...candidate, id: 'DUPLICATE_EFFECT' }] })));
  await assert.rejects(multiple.findPayment(order, '2026-10-25T12:00:00Z'), code('UNKNOWN_OUTCOME'));
});
test('payment recovery bounds pages, repeated cursors, response bytes and transport failure', async () => {
  const base = mock(); const order = await base.provider.createOrder(await base.provider.calculate(lines, randomUUID()), pickup); const since = '2026-10-25T12:00:00Z'; let count = 0;
  const endless = new MerchantSquareProvider(config, async () => new Response(JSON.stringify({ payments: [], cursor: 'page-' + ++count })));
  await assert.rejects(endless.findPayment(order, since), code('UNKNOWN_OUTCOME')); assert.equal(count, 5);
  count = 0; const repeated = new MerchantSquareProvider(config, async () => { count++; return new Response(JSON.stringify({ cursor: 'same' })); });
  await assert.rejects(repeated.findPayment(order, since), code('UNKNOWN_OUTCOME')); assert.equal(count, 2);
  for (const fetcher of [async () => new Response('{}', { headers: { 'content-length': String(300 * 1024) } }), async () => new Response('x'.repeat(300 * 1024)), async () => new Response('{}', { status: 429 }), async () => { throw new Error(); }]) await assert.rejects(new MerchantSquareProvider(config, fetcher).findPayment(order, since), code('UNKNOWN_OUTCOME'));
});
test('Square pickup fulfillment uses read-before-write versioned sparse update and preserves checkout identity', async () => {
  const referenceId = randomUUID(); const calls: { method: string; body: any }[] = []; let state = 'PROPOSED'; let version = 1;
  const provider = new MerchantSquareProvider(config, async (input, init) => {
    assert.equal(String(input), 'https://connect.squareupsandbox.com/v2/orders/ORDER_FULFILL'); const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ method: init!.method!, body });
    if (init?.method === 'PUT') { assert.equal(body.order.version, version); state = body.order.fulfillments[0].state; version++; }
    return Response.json({ order: { id: 'ORDER_FULFILL', location_id: config.locationId, reference_id: referenceId, version, state: state === 'COMPLETED' ? 'COMPLETED' : 'OPEN', total_money: money(200), fulfillments: [{ uid: 'PICKUP_FULFILL', type: 'PICKUP', state }] } });
  });
  const read = await provider.readOrder('ORDER_FULFILL'); assert.equal(read.referenceId, referenceId);
  const ready = await provider.updatePickupFulfillment('ORDER_FULFILL', 'PICKUP_FULFILL', 1, 'PREPARED', 'fulfillment_key_ready_123'); assert.equal(ready.fulfillments[0]!.state, 'PREPARED');
  assert.deepEqual(calls.find(call => call.method === 'PUT')!.body, { idempotency_key: 'fulfillment_key_ready_123', order: { location_id: config.locationId, version: 1, fulfillments: [{ uid: 'PICKUP_FULFILL', type: 'PICKUP', state: 'PREPARED' }] } });
  await provider.updatePickupFulfillment('ORDER_FULFILL', 'PICKUP_FULFILL', 1, 'PREPARED', 'fulfillment_key_ready_123'); assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  await assert.rejects(provider.updatePickupFulfillment('ORDER_FULFILL', 'PICKUP_FULFILL', 1, 'COMPLETED', 'fulfillment_key_done_123'), code('ORDER_CHANGED'));
  const done = await provider.updatePickupFulfillment('ORDER_FULFILL', 'PICKUP_FULFILL', 2, 'COMPLETED', 'fulfillment_key_done_123'); assert.equal(done.state, 'COMPLETED');
  await assert.rejects(provider.updatePickupFulfillment('ORDER_FULFILL', 'PICKUP_FULFILL', 3, 'PREPARED', 'fulfillment_key_again_123'), code('FULFILLMENT_STATE_CONFLICT'));
});
test('fulfillment rejects wrong context and ambiguous update outcomes without retries', async () => {
  const reference = randomUUID(); let writes = 0;
  for (const wrong of [true, false]) {
    const provider = new MerchantSquareProvider(config, async (_input, init) => {
      if (init?.method === 'PUT') { writes++; throw new Error('response lost'); }
      return Response.json({ order: { id: 'ORDER_FULFILL', location_id: wrong ? 'OTHER' : config.locationId, reference_id: reference, version: 1, state: 'OPEN', total_money: money(200), fulfillments: [{ uid: 'PICKUP_FULFILL', type: 'PICKUP', state: 'PROPOSED' }] } });
    });
    await assert.rejects(provider.updatePickupFulfillment('ORDER_FULFILL', 'PICKUP_FULFILL', 1, 'PREPARED', 'fulfillment_key_ready_123'), code(wrong ? 'UNVERIFIED_RESPONSE' : 'UNKNOWN_OUTCOME'));
  }
  assert.equal(writes, 1);
});

test('receipt links are optional, normalized and restricted to exact HTTPS Square receipt hosts', async () => {
  for (const [value, expected] of [
    [undefined, undefined],
    ['https://SQUAREUP.com/receipt/preview/receipt-unit', 'https://squareup.com/receipt/preview/receipt-unit'],
    ['https://squareupsandbox.com/receipt/preview/test', 'https://squareupsandbox.com/receipt/preview/test'],
    ['http://squareup.com/receipt/id', undefined],
    ['https://squareup.com.attacker.invalid/receipt/id', undefined],
    ['https://user:password@squareup.com/receipt/id', undefined],
    ['https://squareup.com/other/id', undefined],
    ['https://squareup.com/receipt/', undefined],
    ['https://squareup.com:444/receipt/id', undefined],
    ['javascript:alert(1)', undefined],
  ]) {
    const { provider, requests } = mock({ mutate(path, response) { if (path === '/v2/payments') response.payment.receipt_url = value; } });
    const order = await provider.createOrder(await provider.calculate(lines, randomUUID()), pickup);
    const payment = await provider.pay(order, 'injected-card-token');
    assert.equal(payment.receiptUrl, expected);
    if (!expected) assert.equal(Object.hasOwn(payment, 'receiptUrl'), false);
    assert.equal(Object.hasOwn(requests.at(-1)!.body, 'buyer_email_address'), false);
  }
});
