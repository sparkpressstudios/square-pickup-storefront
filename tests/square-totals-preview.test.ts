import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { demoCatalog } from '../config/demo-catalog';
import { sandboxIntent } from '../server/src/square-sandbox';
import { SquareTotalsPreviewError, previewSquareSandboxTotals } from '../server/src/square-totals-preview';

const config = { environment: 'sandbox' as const, token: 'synthetic-sandbox-token-only', locationId: 'LOCATION123' };
const intent = sandboxIntent(demoCatalog, { items: [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }], currency: 'USD', fulfillment: 'pickup' }, randomUUID());
const body = (tax: number) => ({ order: { location_id: config.locationId, total_money: { amount: 2400 + tax, currency: 'USD' }, gross_sales_money: { amount: 2400, currency: 'USD' }, total_tax_money: { amount: tax, currency: 'USD' }, total_discount_money: { amount: 0, currency: 'USD' }, total_service_charge_money: { amount: 0, currency: 'USD' } } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('Square calculates taxes only as a separate read-only, production-disabled preview', async () => {
  let called = 0;
  const result = await previewSquareSandboxTotals(intent, config, async (url, init) => {
    called++;
    assert.equal(url, 'https://connect.squareupsandbox.com/v2/orders/calculate');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.order.location_id, config.locationId);
    assert.deepEqual(request.order.pricing_options, { auto_apply_taxes: true, auto_apply_discounts: false });
    assert.equal(request.order.taxes, undefined);
    assert.equal(request.order.customer_id, undefined);
    assert.equal(request.order.fulfillments, undefined);
    assert.equal(request.order.line_items[0].base_price_money.amount, 2400);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ' + config.token);
    return response(body(144));
  });
  assert.deepEqual(result, { currency: 'USD', subtotalMinor: 2400, taxMinor: 144, totalMinor: 2544,
    requiresCheckoutIntegration: true, productionChargeAuthorized: false, provider: 'square-sandbox-calculate-order' });
  assert.equal(called, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-sandbox-token/);
});

test('zero tax does not falsely claim tax collection or charge authorization', async () => {
  const result = await previewSquareSandboxTotals(intent, config, async () => response(body(0)));
  assert.equal(result.totalMinor, 2400);
  assert.equal(result.taxMinor, 0);
  assert.equal(result.productionChargeAuthorized, false);
});

test('Square totals rejects amount mismatch, discounts, service charges, wrong location, currency and provider errors', async () => {
  const bad = [
    { ...body(120), order: { ...body(120).order, total_money: { amount: 2400, currency: 'USD' } } },
    { ...body(120), order: { ...body(120).order, location_id: 'OTHER' } },
    { ...body(120), order: { ...body(120).order, total_tax_money: { amount: 120, currency: 'EUR' } } },
    { ...body(120), order: { ...body(120).order, total_discount_money: { amount: 5, currency: 'USD' } } },
    { ...body(120), order: { ...body(120).order, total_service_charge_money: { amount: 2, currency: 'USD' } } },
    { errors: [{ detail: 'secret-error' }] },
  ];
  for (const value of bad) await assert.rejects(previewSquareSandboxTotals(intent, config, async () => response(value)), (e: unknown) => e instanceof SquareTotalsPreviewError && e.code === 'UNVERIFIED_TOTAL');
  await assert.rejects(previewSquareSandboxTotals(intent, config, async () => response({}, 500)), (e: unknown) => e instanceof SquareTotalsPreviewError && e.code === 'REMOTE_ERROR');
  await assert.rejects(previewSquareSandboxTotals(intent, { ...config, environment: 'production' } as unknown as typeof config, async () => response(body(0))), (e: unknown) => e instanceof SquareTotalsPreviewError && e.code === 'CONFIGURATION');
  await assert.rejects(previewSquareSandboxTotals(intent, config, async () => { throw new Error(config.token); }), (e: unknown) => e instanceof SquareTotalsPreviewError && e.code === 'REMOTE_ERROR' && !e.message.includes(config.token));
});

test('locally forged totals are rejected before contacting Square', async () => {
  let calls = 0;
  const forged = { ...intent, quote: { ...intent.quote, totalMinor: 1 } };
  await assert.rejects(previewSquareSandboxTotals(forged, config, async () => { calls++; return response(body(0)); }), (e: unknown) => e instanceof SquareTotalsPreviewError && e.code === 'QUOTE_MISMATCH');
  assert.equal(calls, 0);
});
