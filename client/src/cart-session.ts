import { parseCartRequest, parseCheckoutRequest, type CartItem, type CheckoutRequest, type DemoQuote } from '../../shared/checkout';

export const cartStorageKey = 'square-starter-demo-cart-v1';
type SessionStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface DemoCartSession { readonly items: readonly CartItem[]; readonly attempt: CheckoutRequest | null }
export const emptyCart = (): DemoCartSession => ({ items: [], attempt: null });

export function cartIdentity(items: readonly CartItem[]): string {
  return JSON.stringify(items.length ? parseCartRequest({ items, currency: 'USD', fulfillment: 'pickup' }).items : []);
}

export function loadCart(storage?: SessionStorage): DemoCartSession {
  try {
    const saved = storage?.getItem(cartStorageKey);
    if (!saved) return emptyCart();
    const value = JSON.parse(saved);
    if (value.version !== 1 || !Array.isArray(value.items)) return emptyCart();
    const items = value.items.length ? parseCartRequest({ items: value.items, currency: 'USD', fulfillment: 'pickup' }).items : [];
    const attempt = value.attempt ? parseCheckoutRequest(value.attempt) : null;
    if (attempt && cartIdentity(attempt.items) !== cartIdentity(items)) return emptyCart();
    return { items, attempt };
  } catch { return emptyCart(); }
}

export function saveCart(session: DemoCartSession, storage?: SessionStorage): boolean {
  try {
    if (!storage) return false;
    storage.setItem(cartStorageKey, JSON.stringify({ version: 1, ...session }));
    return true;
  } catch { return false; }
}

/** Persist this exact request before sending. A retry never generates another ID. */
export function prepareAttempt(session: DemoCartSession, quote: DemoQuote | undefined, createId: () => string): DemoCartSession {
  if (session.attempt) return session;
  if (!quote || cartIdentity(session.items) !== cartIdentity(quote.lines.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })))) throw new Error('Review this cart before simulating checkout.');
  const attempt = parseCheckoutRequest({ items: session.items, currency: 'USD', fulfillment: 'pickup', attemptId: createId(), demoSessionId: quote.demoSessionId, expectedTotalMinor: quote.totalMinor });
  return { items: attempt.items, attempt };
}
