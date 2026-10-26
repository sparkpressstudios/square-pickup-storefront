import type { Catalog } from './catalog';

export interface CartItem {
  readonly productId: string;
  readonly variantId: string;
  readonly quantity: number;
}
export interface CartRequest {
  readonly items: readonly CartItem[];
  readonly currency: 'USD';
  readonly fulfillment: 'pickup';
}
export interface CheckoutRequest extends CartRequest {
  readonly attemptId: string;
  readonly demoSessionId: string;
  readonly expectedTotalMinor: number;
}
export interface QuotedLine extends CartItem {
  readonly name: string;
  readonly sku: string;
  readonly selections: Readonly<Record<string, string>>;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
}
export interface CartQuote {
  readonly lines: readonly QuotedLine[];
  readonly currency: 'USD';
  readonly fulfillment: 'pickup';
  readonly totalMinor: number;
  readonly pricing: 'demo-subtotal-only';
}
export interface DemoQuote extends CartQuote { readonly demoSessionId: string }
export interface DemoReceipt extends DemoQuote {
  readonly checkoutId: string;
  readonly attemptId: string;
  readonly mockPaymentId: string;
  readonly status: 'simulated';
  readonly fulfillmentAuthorized: false;
}

export type CheckoutErrorCode = 'INVALID_REQUEST' | 'INVALID_QUANTITY' | 'UNKNOWN_VARIANT' | 'UNAVAILABLE' | 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED' | 'IDEMPOTENCY_CONFLICT' | 'DEMO_SESSION_EXPIRED' | 'DEMO_LIMIT_REACHED' | 'MOCK_DECLINED' | 'CHECKOUT_UNCERTAIN';
export class CheckoutError extends Error {
  constructor(readonly code: CheckoutErrorCode, message: string, readonly status = 400) { super(message); }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validAttemptId(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxMoney = 2_147_483_647;

function record(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new CheckoutError('INVALID_REQUEST', 'Unexpected request fields. Send identifiers and quantities only.');
  }
  return input as Record<string, unknown>;
}

function cartFields(input: Record<string, unknown>): CartRequest {
  if (!Object.hasOwn(input, 'items') || !Object.hasOwn(input, 'currency') || !Object.hasOwn(input, 'fulfillment') || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50 || input.currency !== 'USD' || input.fulfillment !== 'pickup') {
    throw new CheckoutError('INVALID_REQUEST', 'Use 1–50 cart lines, USD, and pickup fulfillment.');
  }
  const combined = new Map<string, CartItem>();
  for (const raw of input.items) {
    const line = record(raw, ['productId', 'variantId', 'quantity']);
    if (typeof line.productId !== 'string' || typeof line.variantId !== 'string' || line.productId.length > 100 || line.variantId.length > 100 || !identifier.test(line.productId) || !identifier.test(line.variantId)) {
      throw new CheckoutError('INVALID_REQUEST', 'Invalid product or variant identifier.');
    }
    if (!Object.hasOwn(line, 'quantity') || typeof line.quantity !== 'number' || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) {
      throw new CheckoutError('INVALID_QUANTITY', 'Each quantity must be a whole number from 1 to 99.');
    }
    const key = `${line.productId}/${line.variantId}`;
    const quantity = (combined.get(key)?.quantity ?? 0) + line.quantity;
    if (quantity > 99) throw new CheckoutError('INVALID_QUANTITY', 'Combined variant quantity cannot exceed 99.');
    combined.set(key, { productId: line.productId, variantId: line.variantId, quantity });
  }
  const items = [...combined.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
  return { items, currency: 'USD', fulfillment: 'pickup' };
}

export function parseCartRequest(input: unknown): CartRequest {
  return cartFields(record(input, ['items', 'currency', 'fulfillment']));
}

export function parseCheckoutRequest(input: unknown): CheckoutRequest {
  const raw = record(input, ['items', 'currency', 'fulfillment', 'attemptId', 'demoSessionId', 'expectedTotalMinor']);
  const cart = cartFields(raw);
  if (!validAttemptId(raw.attemptId) || !validAttemptId(raw.demoSessionId) || typeof raw.expectedTotalMinor !== 'number' || !Number.isSafeInteger(raw.expectedTotalMinor) || raw.expectedTotalMinor < 0 || raw.expectedTotalMinor > maxMoney) {
    throw new CheckoutError('INVALID_REQUEST', 'A valid demo attempt, session, and quoted total are required.');
  }
  return { ...cart, attemptId: raw.attemptId.toLowerCase(), demoSessionId: raw.demoSessionId.toLowerCase(), expectedTotalMinor: raw.expectedTotalMinor };
}

/** The server invokes this against its own current catalog, never client prices. */
export function quoteCart(catalog: Catalog, cart: CartRequest): CartQuote {
  let totalMinor = 0;
  const lines = cart.items.map((item): QuotedLine => {
    const product = catalog.products.find((entry) => entry.id === item.productId);
    const variant = product?.variants.find((entry) => entry.id === item.variantId);
    if (!product || !variant) throw new CheckoutError('UNKNOWN_VARIANT', 'A product or variant is no longer available.', 404);
    if (!variant.enabled) throw new CheckoutError('UNAVAILABLE', 'This variant is unavailable.', 409);
    if (variant.stockQuantity < item.quantity) throw new CheckoutError('INSUFFICIENT_STOCK', 'There is not enough demo stock for this quantity.', 409);
    const lineTotalMinor = variant.priceMinor * item.quantity;
    totalMinor += lineTotalMinor;
    if (!Number.isSafeInteger(totalMinor) || totalMinor > maxMoney) throw new CheckoutError('INVALID_REQUEST', 'Demo cart total exceeds the supported limit.');
    return { ...item, name: product.name, sku: variant.sku, selections: { ...variant.selections }, unitPriceMinor: variant.priceMinor, lineTotalMinor };
  });
  return { lines, currency: 'USD', fulfillment: 'pickup', totalMinor, pricing: 'demo-subtotal-only' };
}
