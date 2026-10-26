import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MerchantStorefront, merchantMayPay, merchantMayReset, verifyMerchantAttempt, verifyMerchantQuote, type MerchantAttempt } from '../client/src/merchant-storefront';
import { demoCatalog } from '../config/demo-catalog';
import { merchant } from '../config/merchant';
const id = '11111111-1111-4111-8111-111111111111';
const quote = { quoteId: id, expiresAt: '2026-10-25T15:00:00Z', subtotalMinor: 1000, taxMinor: 60, discountMinor: 100, totalMinor: 960, currency: 'USD', pricing: 'square-calculated' };
const view: MerchantAttempt = { attemptId: id, state: 'reserved', amountMinor: 960, currency: 'USD', orderId: null, paymentId: null, refundedMinor: 0, failureCode: null, fulfillmentState: 'not_started', requiresReconciliation: false, fulfillmentAuthorized: false, mode: 'merchant-sandbox' };

test('merchant UI accepts only exact authoritative USD totals with a stable recovery identity', () => {
  assert.deepEqual(verifyMerchantQuote(quote), quote);
  for (const change of [{ totalMinor: -1 }, { taxMinor: -1 }, { subtotalMinor: 1.2 }, { currency: 'CAD' }, { pricing: 'local-estimate' }, { quoteId: '' }, { expiresAt: 'invalid' }]) {
    assert.throws(() => verifyMerchantQuote({ ...quote, ...change }), /Invalid Square quote/);
  }
});

test('inclusive taxes retain Square total without adding embedded tax a second time', () => {
  const inclusive = { ...quote, subtotalMinor: 1000, taxMinor: 57, discountMinor: 0, totalMinor: 1000 };
  assert.equal(verifyMerchantQuote(inclusive).totalMinor, 1000);
});

test('merchant attempt response must match saved identity and remain sandbox-only', () => {
  assert.deepEqual(verifyMerchantAttempt(view, id), view);
  for (const change of [{ attemptId: 'another-checkout-identity' }, { mode: 'production' }, { currency: 'EUR' }, { fulfillmentAuthorized: true }, { amountMinor: -10 }, { refundedMinor: 961 }, { requiresReconciliation: undefined }, { state: 'new_unrecognized_state' }, { fulfillmentState: null }]) {
    assert.throws(() => verifyMerchantAttempt({ ...view, ...change }, id), /saved checkout/);
  }
});

test('unknown, sending and pending outcomes cannot tokenize, cancel identity or start another cart', () => {
  for (const state of ['order_sending', 'payment_sending', 'pending', 'review']) {
    assert.equal(merchantMayPay({ ...view, state }), false);
    assert.equal(merchantMayReset({ ...view, state }), false);
  }
  for (const state of ['reserved', 'order_ready']) {
    assert.equal(merchantMayPay({ ...view, state }), true);
    assert.equal(merchantMayReset({ ...view, state }), false);
    assert.equal(merchantMayPay({ ...view, state, requiresReconciliation: true }), false);
  }
  for (const state of ['completed', 'failed']) {
    assert.equal(merchantMayPay({ ...view, state }), false);
    assert.equal(merchantMayReset({ ...view, state }), true);
    assert.equal(merchantMayReset({ ...view, state, requiresReconciliation: true }), false);
  }
  assert.equal(merchantMayPay(undefined), false);
  assert.equal(merchantMayReset(undefined), false);
});

test('merchant storefront renders actual merchant/catalog, explicit sandbox scope, and gated checkout', () => {
  const html = renderToStaticMarkup(createElement(MerchantStorefront, { storefront: { mode: 'merchant-sandbox', merchant, catalog: demoCatalog, sandbox: { environment: 'sandbox', applicationId: 'sandbox-sq0idb-test', locationId: 'LOCATION1' } } }));
  assert.match(html, /SQUARE SANDBOX/);
  assert.match(html, /No live payments/);
  assert.match(html, /Square confirms taxes and applicable discounts/);
  assert.match(html, /Studio candle/);
  assert.match(html, /disabled=""><span>3<\/span>Checkout/);
  assert.doesNotMatch(html, /Simulate checkout|Add to demo cart|sq0atp-/);
});
