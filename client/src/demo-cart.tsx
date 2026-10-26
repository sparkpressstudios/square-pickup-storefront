import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatPrice, type Catalog } from '../../shared/catalog';
import { CheckoutError, parseCartRequest, quoteCart, type CartItem, type DemoQuote, type DemoReceipt } from '../../shared/checkout';
import { cartStorageKey, emptyCart, loadCart, prepareAttempt, saveCart, type DemoCartSession } from './cart-session';
import type { SandboxPublicConfig } from '../../shared/square-sandbox';
import type { SandboxCheckoutView } from '../../shared/sandbox-checkout';
import { SandboxPanel } from './sandbox-panel';
import { ProductImage } from './product-card';
import type { MerchantConfig } from '../../shared/storefront';

function storage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

function initialCart(): DemoCartSession {
  const target = storage();
  try {
    if (target?.getItem(cartStorageKey) !== null || typeof window === 'undefined') return loadCart(target);
    // Migrate the prior tab-only cart, including its exact pending attempt.
    const previous = loadCart(window.sessionStorage);
    saveCart(previous, target);
    return previous;
  } catch { return emptyCart(); }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new CheckoutError(value.error?.code ?? 'CHECKOUT_UNCERTAIN', value.error?.message ?? 'Demo request failed.', response.status);
  return value as T;
}

const safeRejections = new Set(['INVALID_REQUEST', 'INVALID_QUANTITY', 'UNKNOWN_VARIANT', 'UNAVAILABLE', 'INSUFFICIENT_STOCK', 'PRICE_CHANGED', 'DEMO_SESSION_EXPIRED', 'MOCK_DECLINED', 'DEMO_LIMIT_REACHED']);

export function useDemoCart(catalog: Catalog, onComplete: () => void) {
  const [session, setSession] = useState<DemoCartSession>(initialCart);
  const currentSession = useRef(session);
  const [quote, setQuote] = useState<DemoQuote>();
  const [receipt, setReceipt] = useState<DemoReceipt>();
  const [sandboxResult, setSandboxResult] = useState<SandboxCheckoutView>();
  const [sandboxSelected, setSandboxSelected] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const locked = busy || Boolean(session.attempt);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  function persist(next: DemoCartSession) {
    setStorageWarning(!saveCart(next, storage()));
    currentSession.current = next;
    setSession(next);
  }
  function latest(): DemoCartSession {
    // A pending identity wins over draft changes, including another tab's stale UI.
    if (currentSession.current.attempt) return currentSession.current;
    try {
      const target = storage();
      if (target?.getItem(cartStorageKey)) {
        const saved = loadCart(target);
        if (JSON.stringify(saved) !== JSON.stringify(currentSession.current)) {
          currentSession.current = saved; setSession(saved); setQuote(undefined); setNotice('Cart updated in another tab.');
        }
      }
    } catch { /* Keep the current identity if storage becomes unavailable. */ }
    return currentSession.current;
  }
  useEffect(() => {
    function synchronize(event: StorageEvent) { if (event.key === cartStorageKey && !pending.current) latest(); }
    window.addEventListener('storage', synchronize);
    return () => window.removeEventListener('storage', synchronize);
  }, []);
  function change(items: readonly CartItem[]) {
    if (pending.current || latest().attempt) return false;
    try {
      const cart = items.length ? parseCartRequest({ items, currency: 'USD', fulfillment: 'pickup' }) : { items: [] };
      if (cart.items.length) quoteCart(catalog, { items: cart.items, currency: 'USD', fulfillment: 'pickup' });
      persist({ items: cart.items, attempt: null }); setQuote(undefined); setReceipt(undefined); setError(''); setNotice('');
      return true;
    } catch (failure) { setNotice(''); setError(failure instanceof Error ? failure.message : 'Unable to change cart.'); return false; }
  }
  function addItem(item: CartItem) {
    const active = latest();
    const current = active.items.find((line) => line.variantId === item.variantId && line.productId === item.productId);
    const added = change([...active.items.filter((line) => line !== current), { ...item, quantity: item.quantity + (current?.quantity ?? 0) }]);
    if (added) setNotice(`${item.quantity} ${catalog.products.find((product) => product.id === item.productId)?.name ?? 'item'} added to your cart.`);
    return added;
  }
  function changeQuantity(item: CartItem, quantity: number) {
    const matches = (line: CartItem) => line.productId === item.productId && line.variantId === item.variantId;
    const active = latest();
    change(quantity === 0 ? active.items.filter((line) => !matches(line)) : active.items.map((line) => matches(line) ? { ...line, quantity } : line));
  }
  async function review() {
    const active = latest();
    if (pending.current || !active.items.length || active.attempt) return false;
    pending.current = true; setBusy(true); setError('');
    try { setQuote(await post<DemoQuote>('/api/demo/quote', { items: active.items, currency: 'USD', fulfillment: 'pickup' })); return true; }
    catch (failure) { setQuote(undefined); setError(failure instanceof Error ? failure.message : 'Unable to review cart.'); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  async function simulate() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    let next: DemoCartSession = latest();
    try {
      next = prepareAttempt(next, quote, () => crypto.randomUUID());
      persist(next);
      const result = await post<DemoReceipt>('/api/demo/checkouts', next.attempt);
      setReceipt(result); onComplete();
    } catch (failure) {
      setError(failure instanceof CheckoutError ? failure.message : 'Response not received. Your cart is saved; retry this same simulation.');
      if (failure instanceof CheckoutError && safeRejections.has(failure.code)) { persist({ items: next.items, attempt: null }); setQuote(undefined); }
    } finally { pending.current = false; setBusy(false); }
  }
  function newCart() {
    if (pending.current || (session.attempt && !receipt && !['completed','failed'].includes(sandboxResult?.state ?? ''))) return;
    const shared = loadCart(storage());
    if (shared.attempt && shared.attempt.attemptId !== session.attempt?.attemptId) { setError('Another tab has a different pending checkout. Keep both identities intact and resolve that attempt first.'); return; }
    persist(emptyCart()); setQuote(undefined); setReceipt(undefined); setSandboxResult(undefined); setSandboxSelected(false); setError(''); setNotice('');
  }
  function selectSandbox() { try { const next = prepareAttempt(latest(), quote, () => crypto.randomUUID()); persist(next); setSandboxSelected(true); } catch { setError('Review this cart before selecting a sandbox attempt.'); } }
  return { session, quote, receipt, sandboxResult, sandboxSelected, selectSandbox, setSandboxResult, error, notice, storageWarning, busy, locked, addItem, changeQuantity, review, simulate, newCart };
}

export function DemoCartPanel({ cart, catalog, media, sandbox, stage = 'checkout', children }: { cart: ReturnType<typeof useDemoCart>; catalog: Catalog; media?: MerchantConfig['media']; sandbox?: SandboxPublicConfig; stage?: 'cart' | 'pickup' | 'checkout' | 'confirmation'; children?: ReactNode }) {
  const titleId = useId();
  const estimate = cart.session.items.reduce((sum, item) => sum + (catalog.products.find((p) => p.id === item.productId)?.variants.find((v) => v.id === item.variantId)?.priceMinor ?? 0) * item.quantity, 0);
  return <section className="cart-panel" aria-labelledby={titleId}>
    <div className="section-heading"><div><p className="eyebrow">{stage === 'confirmation' ? 'Thank you for trying the demo' : 'Your selections'}</p><h2 id={titleId}>{stage === 'confirmation' ? (cart.sandboxResult?.state === 'completed' ? 'Sandbox payment confirmed' : 'Simulation complete') : stage === 'checkout' ? (sandbox ? 'Review & test checkout' : 'Review & simulate') : 'Your demo cart'}</h2></div><span className="pickup-badge">USD / Pickup only</span></div>
    <p className="cart-disclaimer">{sandbox ? 'Square sandbox test mode: synthetic cards/data only, no live charge or authorized pickup fulfillment. Taxes and fees are not calculated.' : 'No card entry, real charge, order, or pickup reservation. Taxes and fees are not calculated.'}</p>
    {!cart.session.items.length && <p className="empty-cart">Choose a variant and add it to explore the server-validated demo.</p>}
    <ul className="cart-lines">{cart.session.items.map((item) => {
      const product = catalog.products.find((entry) => entry.id === item.productId);
      const variant = product?.variants.find((entry) => entry.id === item.variantId);
      const frozen = (cart.receipt ?? cart.quote)?.lines.find((line) => line.variantId === item.variantId && line.productId === item.productId);
      const unitPrice = frozen?.unitPriceMinor ?? variant?.priceMinor;
      return <li key={`${item.productId}/${item.variantId}`}><div className="cart-line-main">{product && <ProductImage product={product} media={media} />}<div className="cart-line-copy"><strong>{frozen?.name ?? product?.name ?? item.productId}</strong><span>{Object.entries(frozen?.selections ?? variant?.selections ?? {}).map(([key, value]) => `${product?.options.find((option) => option.id === key)?.label ?? key}: ${value}`).join(' / ') || 'Standard'}</span><span>{unitPrice === undefined ? 'Price requires review' : `${formatPrice(unitPrice, 'USD')} each`}</span></div></div><div className="line-end"><strong>{unitPrice === undefined ? '—' : formatPrice(unitPrice * item.quantity, 'USD')}</strong>{stage === 'cart' ? <div className="quantity-controls"><button type="button" disabled={cart.locked || item.quantity <= 1} aria-label={`Decrease ${product?.name ?? 'item'} quantity`} onClick={() => cart.changeQuantity(item, item.quantity - 1)}>−</button><span aria-label="Quantity">{item.quantity}</span><button type="button" disabled={cart.locked || item.quantity >= Math.min(99, variant?.stockQuantity ?? 0)} aria-label={`Increase ${product?.name ?? 'item'} quantity`} onClick={() => cart.changeQuantity(item, item.quantity + 1)}>+</button><button type="button" disabled={cart.locked} className="remove-line" aria-label={`Remove ${product?.name ?? 'item'}`} onClick={() => cart.changeQuantity(item, 0)}>Remove</button></div> : <span>Quantity {item.quantity}</span>}</div></li>;
    })}</ul>
    {Boolean(cart.session.items.length) && <p className="quote-total">{cart.receipt || cart.quote ? 'Server-validated demo subtotal' : cart.session.attempt ? 'Saved attempt subtotal' : 'Estimated subtotal'}<strong>{formatPrice(cart.sandboxResult?.amountMinor ?? cart.receipt?.totalMinor ?? cart.quote?.totalMinor ?? cart.session.attempt?.expectedTotalMinor ?? estimate, 'USD')}</strong></p>}
    {cart.error && <p className="cart-error" role="alert">{cart.error}</p>}
    {cart.storageWarning && <p className="cart-error">Browser storage is unavailable. Keep this tab open to preserve the same retry identity.</p>}
    {cart.session.attempt && !cart.receipt && <p className="cart-disclaimer">{sandbox ? 'This cart is locked to one sandbox attempt. Check its status after a lost response; do not create another identity for an unknown outcome.' : 'This cart is locked to one attempt. If the response was lost, retry the same simulation. Unknown outcomes must not start a new attempt.'}</p>}
    {cart.receipt && <div className="demo-receipt" role="status"><h3>Your demo receipt</h3><p>{formatPrice(cart.receipt.totalMinor, 'USD')} demo subtotal. No funds moved and fulfillment is not authorized.</p><p>Mock reference: <code>{cart.receipt.mockPaymentId}</code></p><p>Refreshing or retrying this attempt retrieves this same receipt.</p></div>}
    {sandbox && stage === 'checkout' && cart.sandboxSelected && cart.session.attempt && <SandboxPanel config={sandbox} request={cart.session.attempt} onResult={cart.setSandboxResult} />}
    {cart.sandboxResult && <p role="status">Sandbox state: {cart.sandboxResult.state}. Fulfillment is not authorized. {cart.sandboxResult.requiresReconciliation ? 'Retain this attempt for verified reconciliation.' : ''}</p>}
    {cart.sandboxResult?.state === 'completed' && <div className="demo-receipt" role="status"><h3>Square sandbox test complete</h3><p>{formatPrice(cart.sandboxResult.amountMinor, 'USD')} was processed only in Square's sandbox. No real funds moved and no pickup order is authorized.</p><p>Order: <code>{cart.sandboxResult.orderId}</code></p><p>Payment: <code>{cart.sandboxResult.paymentId}</code></p><p>This exact attempt can be checked again without another charge.</p></div>}
    <div className="cart-actions">{children}{stage === 'checkout' && !cart.receipt && <>{!sandbox && <button type="button" className="primary-action" disabled={cart.busy || (!cart.quote && !cart.session.attempt)} onClick={() => void cart.simulate()}>{cart.busy ? 'Checking your attempt…' : cart.session.attempt ? 'Retry same simulation' : 'Simulate checkout'}</button>}{sandbox && !cart.sandboxSelected && <button type="button" className="primary-action" disabled={cart.busy || (!cart.quote && !cart.session.attempt)} onClick={cart.selectSandbox}>{cart.session.attempt ? 'Resume saved Square sandbox test' : 'Continue to Square sandbox test card'}</button>}</>}{(cart.receipt || ['completed','failed'].includes(cart.sandboxResult?.state ?? '')) && <button type="button" disabled={cart.busy} onClick={cart.newCart}>Start a new demo cart</button>}</div>
  </section>;
}
