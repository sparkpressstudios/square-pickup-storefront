import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { demoCatalog } from '../config/demo-catalog';
import { cartIdentity, emptyCart, loadCart, prepareAttempt, saveCart } from '../client/src/cart-session';
import { DemoCheckoutService } from '../server/src/demo-checkout';
import { availableStep, checkoutPrerequisite, shoppingStep } from '../client/src/shopping-flow';

const items = [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }];

test('checkout explains unmet prerequisites without blocking recovery of a saved attempt', () => {
  const draft = { items: 1, attempt: false, receipt: false, pickup: false, quoted: false };
  assert.match(checkoutPrerequisite({ ...draft, items: 0 })!, /Add an item/);
  assert.match(checkoutPrerequisite(draft)!, /Complete pickup details/);
  assert.match(checkoutPrerequisite({ ...draft, pickup: true })!, /Review your cart/);
  assert.match(checkoutPrerequisite({ ...draft, quoted: true })!, /Complete pickup details/);
  assert.equal(checkoutPrerequisite({ ...draft, pickup: true, quoted: true }), undefined);
  for (const recovered of [{ ...draft, attempt: true }, { ...draft, items: 0, attempt: true }, { ...draft, receipt: true }]) {
    assert.equal(checkoutPrerequisite(recovered), undefined);
    assert.equal(availableStep('checkout', recovered), recovered.receipt ? 'confirmation' : 'checkout');
  }
});

test('browser session preserves the exact attempt before sending and across reload/retry', () => {
  const service = new DemoCheckoutService(demoCatalog);
  const quote = service.quote({ items, currency: 'USD', fulfillment: 'pickup' });
  let ids = 0; const createId = () => { ids += 1; return randomUUID(); };
  const session = prepareAttempt({ items, attempt: null }, quote, createId);
  let data = ''; const storage = { getItem: () => data, setItem: (_key: string, value: string) => { data = value; } };
  assert.equal(saveCart(session, storage), true);
  const reloaded = loadCart(storage);
  assert.deepEqual(reloaded, session);
  assert.deepEqual(prepareAttempt(reloaded, undefined, createId), session);
  assert.equal(ids, 1);
});

test('changed cart cannot reuse an old quote, while canonical equivalent cart identity is stable', () => {
  const service = new DemoCheckoutService(demoCatalog);
  const quote = service.quote({ items, currency: 'USD', fulfillment: 'pickup' });
  assert.throws(() => prepareAttempt({ items: [{ ...items[0]!, quantity: 2 }], attempt: null }, quote, randomUUID), /Review this cart/);
  assert.equal(cartIdentity([{ ...items[0]!, quantity: 2 }]), cartIdentity([items[0]!, items[0]!]));
});

test('invalid saved carts/attempts fail closed and unavailable browser storage is explicit', () => {
  assert.deepEqual(loadCart({ getItem: () => '{bad-json', setItem() {} }), emptyCart());
  assert.deepEqual(loadCart({ getItem: () => JSON.stringify({ version: 1, items, attempt: { attemptId: 'invalid' } }), setItem() {} }), emptyCart());
  assert.equal(saveCart(emptyCart()), false);
  assert.equal(saveCart(emptyCart(), { getItem: () => null, setItem() { throw new Error('Storage blocked'); } }), false);
});

test('deep links and back navigation cannot skip pickup/review or discard a pending checkout', () => {
  const draft = { items: 1, attempt: false, receipt: false, pickup: false, quoted: false };
  assert.equal(shoppingStep('#collection'), 'shop');
  assert.equal(shoppingStep('#checkout'), 'checkout');
  assert.equal(shoppingStep('#product/studio-candle'), 'product');
  assert.equal(shoppingStep('#product/../../checkout'), 'shop');
  assert.equal(availableStep('product', { ...draft, attempt: true }), 'product');
  assert.equal(availableStep('checkout', draft), 'pickup');
  assert.equal(availableStep('confirmation', draft), 'cart');
  assert.equal(availableStep('pickup', { ...draft, items: 0 }), 'cart');
  assert.equal(availableStep('checkout', { ...draft, pickup: true, quoted: true }), 'checkout');
  for (const destination of ['cart', 'pickup', 'checkout', 'confirmation'] as const) {
    assert.equal(availableStep(destination, { ...draft, attempt: true }), 'checkout');
    assert.equal(availableStep(destination, { ...draft, attempt: true, receipt: true }), 'confirmation');
  }
  assert.equal(availableStep('shop', { ...draft, attempt: true }), 'shop');
});

test('a reopened browser cart retains only validated identifiers/quantities and the same immutable retry request', () => {
  const service = new DemoCheckoutService(demoCatalog);
  const quote = service.quote({ items, currency: 'USD', fulfillment: 'pickup' });
  const session = prepareAttempt({ items, attempt: null }, quote, randomUUID);
  const values = new Map<string, string>();
  const persistentStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  saveCart(session, persistentStorage);
  const reopened = loadCart(persistentStorage);
  assert.equal(reopened.attempt?.attemptId, session.attempt?.attemptId);
  assert.deepEqual(Object.keys(reopened.items[0]!).sort(), ['productId', 'quantity', 'variantId']);
  assert.equal(JSON.stringify(reopened).includes('unitPriceMinor'), false);
  assert.deepEqual(prepareAttempt(reopened, undefined, () => { throw new Error('No second identity allowed'); }), session);
});

