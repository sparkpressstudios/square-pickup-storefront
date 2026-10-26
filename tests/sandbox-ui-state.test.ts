import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { CheckoutRequest, DemoReceipt } from '../shared/checkout';
import type { SandboxCheckoutView } from '../shared/sandbox-checkout';
import { checkoutFinished, sandboxCardTarget, sandboxMayTokenize, verifySandboxStatus } from '../client/src/sandbox-ui-state';

const request: CheckoutRequest = { items: [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }], currency: 'USD', fulfillment: 'pickup', demoSessionId: randomUUID(), attemptId: randomUUID(), expectedTotalMinor: 2400 };
const valid: SandboxCheckoutView = { mode: 'square-sandbox', attemptId: request.attemptId, checkoutId: randomUUID(), state: 'reserved', amountMinor: 2400, currency: 'USD', fulfillment: 'pickup', orderId: null, paymentId: null, failureCode: null, refundedMinor: 0, requiresReconciliation: false, fulfillmentAuthorized: false };

test('saved sandbox status accepts only the exact attempt, currency and amount before showing card', () => {
  assert.deepEqual(verifySandboxStatus(valid, request), valid);
  for (const wrong of [
    null, {}, { ...valid, attemptId: randomUUID() }, { ...valid, checkoutId: 'invalid' },
    { ...valid, mode: 'mocked-sandbox-protocol' }, { ...valid, amountMinor: 1 },
    { ...valid, fulfillment: 'shipping' }, { ...valid, currency: 'EUR' },
    { ...valid, fulfillmentAuthorized: true }, { ...valid, requiresReconciliation: 'false' },
    { ...valid, state: 'unknown' }, { ...valid, paymentId: {} },
    { ...valid, refundedMinor: -1 },
  ]) assert.throws(() => verifySandboxStatus(wrong, request), /does not match/);
});

test('card tokenization is allowed only before dispatch; review, unknown, declined and completed outcomes cannot tokenize', () => {
  for (const value of ['reserved','order_ready'] as const) assert.equal(sandboxMayTokenize(value), true);
  for (const value of ['order_sending','payment_sending','pending','completed','failed','review'] as const) assert.equal(sandboxMayTokenize(value), false);
  assert.equal(sandboxMayTokenize(undefined), false);
});

test('only a completed sandbox payment or mock receipt can display confirmation', () => {
  for (const state of ['pending','review','failed','reserved'] as const) assert.equal(checkoutFinished(undefined, { ...valid, state }), false);
  assert.equal(checkoutFinished(undefined, { ...valid, state: 'completed' }), true);
  assert.equal(checkoutFinished({} as DemoReceipt, undefined), true);
  assert.equal(checkoutFinished(undefined, undefined), false);
});

test('card targets are unique valid CSS ID selectors for separate React instances', () => {
  const one=sandboxCardTarget(':r0:');
  const two=sandboxCardTarget(':r1:');
  assert.notEqual(one,two);
  for (const target of [one,two]) assert.match('#'+target, /^#[A-Za-z][A-Za-z0-9_-]*$/);
});
