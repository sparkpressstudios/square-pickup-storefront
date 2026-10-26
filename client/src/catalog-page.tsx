import { useEffect, useRef, useState } from 'react';
import { formatPrice } from '../../shared/catalog';
import type { Storefront } from '../../shared/storefront';
import { DemoCartPanel, useDemoCart } from './demo-cart';
import { availableStep, checkoutPrerequisite, shoppingStep, type ShoppingStep } from './shopping-flow';
import { ProductCard, ProductImage } from './product-card';
import { CartDrawer } from './cart-drawer';
import { merchantTheme, ShopHero, StoreBrand } from './storefront-brand';
import { MockPickupForm } from './mock-pickup-form';
import type { MockPickupDetails } from '../../shared/mock-pickup';
import { checkoutFinished } from './sandbox-ui-state';

export function CatalogPage({ storefront }: { storefront: Storefront }) {
  const { merchant } = storefront;
  const [catalog, setCatalog] = useState(storefront.catalog);
  const cart = useDemoCart(catalog, () => {
    void fetch('/api/storefront').then(async (response) => { if (response.ok) setCatalog((await response.json() as Storefront).catalog); }).catch(() => { /* Keep the verified receipt. */ });
  });
  const [hash, setHash] = useState(() => typeof window === 'undefined' ? '#shop' : window.location.hash);
  const [drawer, setDrawer] = useState(false);
  const [pickup, setPickup] = useState(false);
  const [shopper, setShopper] = useState<MockPickupDetails>();
  const heading = useRef<HTMLHeadingElement>(null);
  const count = cart.session.items.reduce((sum, item) => sum + item.quantity, 0);
  const confirmed = checkoutFinished(cart.receipt, cart.sandboxResult);
  const shoppingState = { items: count, attempt: Boolean(cart.session.attempt), receipt: confirmed, pickup, quoted: Boolean(cart.quote) };
  const requestedStep = shoppingStep(hash);
  const step = availableStep(requestedStep, shoppingState);
  const checkoutHint = checkoutPrerequisite(shoppingState);
  const selectedProduct = step === 'product' ? catalog.products.find((product) => product.id === hash.slice('#product/'.length)) : undefined;
  function navigate(next: ShoppingStep) { setDrawer(false); setHash(`#${next}`); window.location.hash = next; }
  useEffect(() => { const onHash = () => { setHash(window.location.hash); setDrawer(false); }; window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  // Deep links/back navigation must describe the step actually rendered, without
  // adding another history entry or touching a saved checkout identity.
  useEffect(() => {
    if (requestedStep !== step) {
      window.history.replaceState(window.history.state, '', `#${step}`);
      setHash(`#${step}`);
    }
  }, [requestedStep, step]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start' }); }, [step]);
  useEffect(() => { if (confirmed) navigate('confirmation'); }, [confirmed]);
  const [category, setCategory] = useState('All');
  const categories = ['All', ...new Set(catalog.products.map((product) => product.category))];
  const products = catalog.products.filter((product) => category === 'All' || product.category === category);
  const theme = merchantTheme(merchant);
  const subtotal = cart.sandboxResult?.amountMinor ?? cart.receipt?.totalMinor ?? cart.quote?.totalMinor ?? cart.session.attempt?.expectedTotalMinor ?? cart.session.items.reduce((sum, item) => sum + (catalog.products.find((p) => p.id === item.productId)?.variants.find((v) => v.id === item.variantId)?.priceMinor ?? 0) * item.quantity, 0);
  const cartContinuation = <><button type="button" className="primary-action" disabled={!count || cart.busy} onClick={() => navigate(cart.locked ? 'checkout' : 'pickup')}>{cart.locked ? 'Resume same checkout' : 'Choose pickup & continue'}</button><button type="button" onClick={() => { setDrawer(false); if (step !== 'shop' && step !== 'product') navigate('shop'); }}>Continue shopping</button></>;
  return <div className={`storefront route-${step}`} style={theme}>
    <div className="demo-banner">SYNTHETIC STORE DEMO <span>{storefront.sandbox ? 'Square sandbox only / no live payments' : 'Mock checkout / no real payments'} · USD · Pickup only</span></div>
    <header className="site-header"><a className="brand" href="#shop"><StoreBrand merchant={merchant} /></a><nav aria-label="Store navigation"><a href="#shop">Shop</a><button type="button" onClick={() => navigate('pickup')}>Pickup</button></nav><button className="header-cart" type="button" onClick={() => setDrawer(true)} aria-label={`Your demo cart, ${count} items`}><span aria-hidden="true">▢</span> Cart <span className="cart-count">{count}</span></button></header>
    {step === 'shop' && <ShopHero merchant={merchant} headingRef={heading} />}
    <nav className="shopping-steps" aria-label="Shopping progress">{(['shop', 'pickup', 'checkout'] as const).map((item, index) => <button key={item} type="button" aria-current={(['shop', 'cart', 'product'].includes(step) ? 'shop' : step === 'confirmation' ? 'checkout' : step) === item ? 'step' : undefined} disabled={item !== 'shop' && ((!count && !cart.session.attempt && !confirmed) || cart.busy || (item === 'checkout' && Boolean(checkoutHint)))} aria-describedby={item === 'checkout' && checkoutHint ? 'checkout-prerequisite' : undefined} onClick={() => navigate(item)}><span>{index + 1}</span>{item === 'shop' ? 'Shop' : item === 'pickup' ? 'Pickup' : 'Checkout'}{index < 2 && <i aria-hidden="true">›</i>}</button>)}<button className="progress-cart" type="button" onClick={() => setDrawer(true)}>Cart ({count})</button></nav>
    {checkoutHint && <p id="checkout-prerequisite" className="checkout-prerequisite" role="status">{checkoutHint}</p>}
    <main>
      {step === 'shop' && <section className="collection" id="collection" aria-labelledby="collection-title"><h2 id="collection-title">Choose your favorites</h2><p className="section-description">Pick your options, set your quantity, and add to cart. Food and everyday goods, together.</p><div className="filters" role="group" aria-label="Filter by category">{categories.map((item) => <button type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item === 'All' ? 'All products' : item}</button>)}</div><div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} media={merchant.media} currency={catalog.currency} onAdd={cart.addItem} cartLocked={cart.locked} />)}</div></section>}
      {step === 'product' && <section className="product-page"><a className="back-to-shop" href="#shop">← Back to shop</a>{selectedProduct ? <><ProductCard key={selectedProduct.id} product={selectedProduct} media={merchant.media} currency={catalog.currency} onAdd={cart.addItem} cartLocked={cart.locked} detail /><section className="related-products"><h2>You might also like</h2><div>{catalog.products.filter((product) => product.id !== selectedProduct.id).map((product) => <a href={`#product/${product.id}`} key={product.id}><ProductImage product={product} media={merchant.media} /><h3>{product.name}</h3><span>View options →</span></a>)}</div></section></> : <div className="message"><h1>Product unavailable</h1><p>Return to the shop to choose another product.</p></div>}</section>}
      {step !== 'shop' && step !== 'product' && <div className="checkout-layout"><section className="flow-intro"><a className="back-to-shop" href="#shop">← Back to shop</a><h1 className="flow-focus" ref={heading} tabIndex={-1}>{step === 'cart' ? 'Your cart' : step === 'pickup' ? 'Choose pickup' : step === 'confirmation' ? 'Sandbox checkout confirmed!' : 'Checkout'}</h1><p>{step === 'cart' ? 'Check your options and quantities before choosing pickup.' : step === 'pickup' ? 'Choose the configured demo location for your synthetic order.' : step === 'confirmation' ? 'Your test result is saved. No real funds moved and pickup is not authorized.' : storefront.sandbox ? 'Review your test items and select Square sandbox checkout.' : 'Review your items and pickup selection. This is a mock checkout.'}</p>
        {step === 'pickup' && <div className="pickup-choice"><span className="pickup-badge">Pickup only</span><h2>{merchant.pickup.label}</h2><p>{merchant.pickup.instructions}</p><MockPickupForm busy={cart.busy} onReady={(details) => { setShopper(details); setPickup(true); void cart.review().then((valid) => { if (valid) navigate('checkout'); }); }} /></div>}
        {(step === 'checkout' || step === 'confirmation') && <div className="pickup-summary"><h2>Pickup details</h2><strong>{merchant.pickup.label}</strong>{shopper && <div className="fictional-shopper"><p className="eyebrow">Fictional contact preview / not stored</p><p>{shopper.name}<br />{shopper.email}</p></div>}<p>{merchant.pickup.instructions}</p>{!cart.locked && <button type="button" onClick={() => navigate('pickup')}>Change selection</button>}</div>}
      </section><DemoCartPanel cart={cart} catalog={catalog} media={merchant.media} sandbox={storefront.sandbox} stage={step}>{step === 'cart' && cartContinuation}{(step === 'pickup' || step === 'checkout') && !cart.locked && <button type="button" onClick={() => navigate('cart')}>Edit cart</button>}</DemoCartPanel></div>}
      {(step === 'shop' || step === 'product') && <><aside className="pickup-panel"><h2>{merchant.pickup.label}</h2><p>{merchant.pickup.instructions}</p><span className="pickup-badge">Pickup only</span></aside>{cart.error && <p className="cart-error shop-notice" role="alert">{cart.error}</p>}{cart.notice && <div className="added-notice" role="status"><span>{cart.notice}</span><button type="button" onClick={() => setDrawer(true)}>View cart</button></div>}{Boolean(count) && <button className="floating-cart" type="button" onClick={() => setDrawer(true)}><span>{cart.receipt ? 'View demo receipt' : cart.locked ? 'Resume same checkout' : `View cart (${count})`}</span><strong>{formatPrice(subtotal, 'USD')} →</strong></button>}</>}
      {cart.storageWarning && <p role="alert" className="cart-error">Browser storage is unavailable. Keep this tab open to preserve your cart and retry identity.</p>}
    </main>
    <footer><div><a className="brand" href="#shop">{merchant.name}</a><p>{merchant.descriptor}</p></div><div><strong>EXPLORE</strong><a href="#shop">Shop all products</a><button type="button" onClick={() => navigate('pickup')}>Pickup details</button></div><div><strong>DEMO STORE</strong><p>Synthetic food & non-food products.<br />Mock checkout. No real purchases or reservations.</p><span>USD / SINGLE MERCHANT</span></div></footer>
    <CartDrawer open={drawer} onClose={() => setDrawer(false)}><DemoCartPanel cart={cart} catalog={catalog} media={merchant.media} sandbox={storefront.sandbox} stage={confirmed ? 'confirmation' : 'cart'}>{cartContinuation}</DemoCartPanel></CartDrawer>
  </div>;
}

