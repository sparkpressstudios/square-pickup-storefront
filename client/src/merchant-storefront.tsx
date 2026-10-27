import {ShippingBuyerPanel} from './shipping-buyer';
import {MerchantCheckoutStatus} from './merchant-checkout-status';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { formatPrice, type Catalog, type Product } from '../../shared/catalog';
import type { CartItem } from '../../shared/checkout';
import type { MerchantConfig } from '../../shared/storefront';
import type { SandboxPublicConfig } from '../../shared/square-sandbox';
import { merchantTheme, StoreBrand } from './storefront-brand';
import type {MerchantReadinessConfiguration,PickupAvailability} from '../../shared/merchant-readiness';
import type {MerchantPaymentPublicConfig} from '../../shared/merchant-payment-config';
import {attachMerchantCard,loadMerchantPaymentSdk,assertMerchantPaymentPublicConfig} from './merchant-payment-browser';
import { sandboxCardTarget } from './sandbox-ui-state';

export interface MerchantStorefrontData { mode: 'merchant-sandbox'|'merchant-production'; merchant: MerchantConfig; catalog: Catalog; checkoutEnabled?:boolean;shippingDevelopment?:boolean; confirmationEmailEnabled?:boolean; sandbox?: SandboxPublicConfig; payment?:MerchantPaymentPublicConfig; configuration?:MerchantReadinessConfiguration; pickupAvailability?:PickupAvailability }
export interface MerchantQuote { quoteId: string; expiresAt: string; subtotalMinor: number; taxMinor: number; discountMinor: number; totalMinor: number; currency: 'USD'; pricing: 'square-calculated'; checkoutToken?:string; pickupAt?:string; pickupTimeZone?:string }
export interface MerchantAttempt {
  attemptId: string; state: string; amountMinor: number; currency: 'USD'; orderId: string | null; paymentId: string | null;
  refundedMinor: number; failureCode: string | null; fulfillmentState: string; requiresReconciliation: boolean;
  fulfillmentAuthorized: boolean; mode: 'merchant-sandbox'|'merchant-production'; confirmation?:{lookupToken:string};
}
export interface MerchantConfirmationData {attemptId:string;state:string;amountMinor:number;currency:'USD';refundedMinor:number;fulfillmentState:string;lines:{name:string;variation?:string;quantity:number;unitPriceMinor:number;totalMinor:number}[];pickupAt?:string;pickupTimeZone?:string;receiptUrl?:string}
export function validMerchantLookupToken(token:unknown):token is string {return typeof token==='string'&&/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token);}
export function promisedPickupLabel(value:unknown,timeZone:unknown='UTC'):string|undefined {if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||typeof timeZone!=='string')return;try{return new Intl.DateTimeFormat(undefined,{timeZone,year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value));}catch{return;}}
export function safeMerchantPublicUrl(value:unknown):string|undefined {if(typeof value!=='string')return;try{const url=new URL(value);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.search)return url.href;}catch{}}
export function checkoutAuthorizationRecord(id:string,token:unknown):string {if(!validId(id)||!validMerchantLookupToken(token))throw new Error('Checkout authorization is unavailable');return JSON.stringify({attemptId:id,token});}
export function readCheckoutAuthorization(raw:string|null,id:string):string {let saved:{attemptId?:string;token?:string}|null;try{saved=JSON.parse(raw??'null');}catch{throw new Error('Saved checkout authorization is unavailable');}if(saved?.attemptId!==id||!validMerchantLookupToken(saved.token))throw new Error('Saved checkout authorization is unavailable');return saved.token;}
export function safeSquareReceiptUrl(value:unknown):string|undefined {if(typeof value!=='string'||value.length>2048)return;try{const url=new URL(value);if(url.protocol==='https:'&&!url.username&&!url.password&&['squareup.com','squareupsandbox.com'].includes(url.hostname)&&url.pathname.startsWith('/receipt/'))return url.href;}catch{/* Not a provider receipt URL. */}}
export function verifyMerchantConfirmation(raw:unknown):MerchantConfirmationData {
 const value=raw as MerchantConfirmationData;
 if(!value||!validId(value.attemptId)||!states.includes(value.state)||value.currency!=='USD'||!money(value.amountMinor)||!money(value.refundedMinor)||value.refundedMinor>value.amountMinor||typeof value.fulfillmentState!=='string'||!Array.isArray(value.lines)||value.lines.length>100||value.lines.some(line=>!line||typeof line.name!=='string'||line.name.length>300||(line.variation!==undefined&&typeof line.variation!=='string')||!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>99||!money(line.unitPriceMinor)||!money(line.totalMinor))||(value.pickupAt!==undefined&&!Number.isFinite(Date.parse(value.pickupAt))))throw new Error('Order confirmation could not be verified');
 return {attemptId:value.attemptId,state:value.state,amountMinor:value.amountMinor,currency:'USD',refundedMinor:value.refundedMinor,fulfillmentState:value.fulfillmentState,lines:value.lines.map(({name,variation,quantity,unitPriceMinor,totalMinor})=>({name,variation,quantity,unitPriceMinor,totalMinor})),...(value.pickupAt?{pickupAt:value.pickupAt,pickupTimeZone:value.pickupTimeZone}:{}),...(safeSquareReceiptUrl(value.receiptUrl)?{receiptUrl:safeSquareReceiptUrl(value.receiptUrl)}:{})};
}
export function MerchantConfirmation({value,link,emailEnabled=false}:{value:MerchantConfirmationData;link?:string;emailEnabled?:boolean}){return <section className="merchant-confirmation" aria-label="Order confirmation"><h2>{value.state==='completed'?'Payment confirmed':'Order status'}</h2><p role="status">{value.state} · Pickup: {value.fulfillmentState}</p><p><strong>{formatPrice(value.amountMinor,'USD')}</strong>{value.refundedMinor>0&&<> · Refunded {formatPrice(value.refundedMinor,'USD')}</>}</p>{value.pickupAt&&<p>Pickup: <time dateTime={value.pickupAt}>{promisedPickupLabel(value.pickupAt,value.pickupTimeZone??'UTC')??'Contact the store to confirm the pickup time'}</time></p>}<ul className="merchant-order-lines">{value.lines.map((line,index)=><li key={index}><span>{line.name}{line.variation&&<small>{line.variation}</small>}<small>Quantity {line.quantity}</small></span><strong>{formatPrice(line.totalMinor,'USD')}</strong></li>)}</ul><p>Order reference: <code>{value.attemptId}</code></p>{value.receiptUrl&&<p><a href={value.receiptUrl} rel="noreferrer noopener" target="_blank">View Square receipt</a></p>}{link&&<><p><a href={link}>Save this private order-status link</a></p><p>{emailEnabled?'Save this private link. Confirmation email may be delayed or fail; provider acceptance does not confirm delivery.':'Save this private link; no confirmation email is sent by this template.'}</p><p>Anyone with this link can view this order’s status. Keep it private. No customer account is required.</p></>}</section>;}
const states = ['reserved', 'order_sending', 'order_ready', 'payment_sending', 'pending', 'completed', 'failed', 'review'];
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(id);
const money = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
export function verifyMerchantQuote(raw: unknown): MerchantQuote {
  const value = raw as MerchantQuote;
  if (!value || !validId(value.quoteId) || value.currency !== 'USD' || value.pricing !== 'square-calculated' ||
      ![value.subtotalMinor, value.taxMinor, value.discountMinor, value.totalMinor].every(money) ||
      !Number.isFinite(Date.parse(value.expiresAt))||(value.checkoutToken!==undefined&&!validMerchantLookupToken(value.checkoutToken))) throw new Error('Invalid Square quote');
  return value;
}
export function verifyMerchantAttempt(raw: unknown, id: string,expectedMode:'merchant-sandbox'|'merchant-production'='merchant-sandbox'): MerchantAttempt {
  const value = raw as MerchantAttempt;
  if (!value || !validId(id) || value.attemptId !== id || value.mode !== expectedMode || value.currency !== 'USD' ||
      !states.includes(value.state) || !money(value.amountMinor) || !money(value.refundedMinor) || value.refundedMinor > value.amountMinor ||
      (expectedMode==='merchant-sandbox'?value.fulfillmentAuthorized!==false:typeof value.fulfillmentAuthorized!=='boolean') || typeof value.requiresReconciliation !== 'boolean' ||
      typeof value.fulfillmentState !== 'string' || (value.failureCode != null && typeof value.failureCode !== 'string') ||
      (value.orderId != null && typeof value.orderId !== 'string') || (value.paymentId != null && typeof value.paymentId !== 'string')) throw new Error('Status does not match the saved checkout');
  return value;
}
export function merchantMayPay(view: MerchantAttempt | undefined): boolean {
  return Boolean(view && !view.requiresReconciliation && ['reserved', 'order_ready'].includes(view.state));
}
export function merchantMayReset(view: MerchantAttempt | undefined): boolean {
  return Boolean(view && !view.requiresReconciliation && ['completed', 'failed'].includes(view.state));
}
export function merchantCartQuantity(items:CartItem[],variantId:string,quantity:number,catalog:Catalog):CartItem[] {
 const current=items.find(item=>item.variantId===variantId);if(!current)throw new Error('Cart item is unavailable');
 if(quantity===0)return items.filter(item=>item.variantId!==variantId);
 const variant=catalog.products.find(product=>product.id===current.productId)?.variants.find(item=>item.id===variantId);
 if(!variant?.enabled||!Number.isSafeInteger(quantity)||quantity<0||quantity>Math.min(99,variant.stockQuantity))throw new Error('Choose an available whole-number quantity');
 return quantity===0?items.filter(item=>item.variantId!==variantId):items.map(item=>item.variantId===variantId?{...item,quantity}:item);
}
class CommerceRequestError extends Error { constructor(readonly status: number) { super('Commerce request could not be confirmed'); } }
async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`/api/commerce/${path}`, { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new CommerceRequestError(response.status);
  return response.json();
}
function MerchantProduct({ product, media, locked, add }: { product: Product; media?: MerchantConfig['media']; locked: boolean; add(item: CartItem): void }) {
  const [variantId, setVariantId] = useState(product.variants.find(v => v.enabled && v.stockQuantity > 0)?.id ?? product.variants[0]?.id ?? '');
  const variant = product.variants.find(v => v.id === variantId);
  const available = Boolean(variant?.enabled && variant.stockQuantity > 0);
  const image = media?.products[product.id];
  return <article className="product-card"><div className="product-image" aria-hidden="true" style={image ? { backgroundImage: `url("${image.src}")`, backgroundPosition: image.position, backgroundSize: image.layout === 'atlas' ? '200% 200%' : 'cover' } : undefined}>{!image && <span className="image-placeholder">{product.name}</span>}<span className="category-badge">{product.category}</span></div><div className="product-copy"><h3>{product.name}</h3><p className="description">{product.description}</p><label className="merchant-field">Choose your option<select value={variantId} onChange={event => setVariantId(event.target.value)} disabled={locked}>{product.variants.map(v => <option key={v.id} value={v.id}>{Object.values(v.selections).join(' / ') || 'Standard'} — {formatPrice(v.priceMinor, 'USD')}</option>)}</select></label><div className="variant-detail"><strong>{variant ? formatPrice(variant.priceMinor, 'USD') : 'Unavailable'}</strong><span>{available ? 'Pickup available' : 'Unavailable'}</span></div><button className="add-to-cart" type="button" disabled={locked || !available} onClick={() => { if (variant) add({ productId: product.id, variantId: variant.id, quantity: 1 }); }}>{available ? 'Add to cart' : 'Unavailable'}</button></div></article>;
}
function QuoteTotals({ quote }: { quote: MerchantQuote }) {
  return <dl className="merchant-totals"><div><dt>Items before adjustments</dt><dd>{formatPrice(quote.subtotalMinor, 'USD')}</dd></div><div><dt>Square discounts</dt><dd>−{formatPrice(quote.discountMinor, 'USD')}</dd></div><div><dt>Tax (included where applicable)</dt><dd>{formatPrice(quote.taxMinor, 'USD')}</dd></div><div className="merchant-grand-total"><dt>Square total</dt><dd>{formatPrice(quote.totalMinor, 'USD')}</dd></div>{quote.pickupAt&&<div><dt>Promised pickup</dt><dd>{promisedPickupLabel(quote.pickupAt,quote.pickupTimeZone??'UTC')??'Confirm with the store'}</dd></div>}</dl>;
}

/** Merchant catalog + authoritative Square totals. Synthetic-store checkout remains a separate runtime. */
export function MerchantStorefront({ storefront }: { storefront: MerchantStorefrontData }) {
  const { merchant, catalog } = storefront;
  const payment=useMemo(()=>{const value=storefront.payment??(storefront.sandbox?{...storefront.sandbox,sdkUrl:'https://sandbox.web.squarecdn.com/v1/square.js' as const}:undefined);if(!value)throw new Error('Merchant payment configuration unavailable');assertMerchantPaymentPublicConfig(value);return value;},[storefront.payment,storefront.sandbox]);
  const test=payment.environment==='sandbox',expectedMode=test?'merchant-sandbox':'merchant-production';
  const storageKey = `merchant-${payment.environment}-attempt:${payment.applicationId}:${payment.locationId}`;
  const tokenStorageKey=storageKey+':confirmation';
  const [lookupToken,setLookupToken]=useState<string>();
  const [confirmation,setConfirmation]=useState<MerchantConfirmationData>();
  const [lookupOnly,setLookupOnly]=useState(false);
  const [lookupError,setLookupError]=useState('');
  const [items, setItems] = useState<CartItem[]>([]);
  const [shippingLocked,setShippingLocked]=useState(false);
  const [quote, setQuote] = useState<MerchantQuote>();
  const [attemptId, setAttemptId] = useState<string>();
  const [view, setView] = useState<MerchantAttempt>();
  const [pickup, setPickup] = useState({ name: '', email: '', phone: '' });
  const [step, setStep] = useState<'shop' | 'pickup' | 'checkout'>('shop');
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [missing, setMissing] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const card = useRef<Awaited<ReturnType<typeof attachMerchantCard>> | null>(null);
  const [cardReady, setCardReady] = useState(false);
  const cardTarget = sandboxCardTarget(useId());
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const locked = shippingLocked || busy || initializing || storageBlocked || Boolean(attemptId) || storefront.checkoutEnabled===false;
  function writeToken(id:string){return readCheckoutAuthorization(window.sessionStorage.getItem(storageKey+':write'),id);}
  function saveWriteToken(id:string,token:unknown){const record=checkoutAuthorizationRecord(id,token);window.sessionStorage.setItem(storageKey+':write',record);if(window.sessionStorage.getItem(storageKey+':write')!==record)throw new Error('Checkout authorization could not be saved');}
  const canPay = merchantMayPay(view) && !uncertain && Boolean(lookupToken) && confirmation?.attemptId===view?.attemptId;
  async function lookup(token:string){try{const checked=verifyMerchantConfirmation(await post('lookup',{token}));setConfirmation(checked);setLookupError('');}catch{setLookupError('This private order link could not be verified. Check the link or contact the store with your order reference.');}}
  function saveConfirmation(token:string){if(!validMerchantLookupToken(token))throw new Error('Invalid private order link');window.sessionStorage.setItem(tokenStorageKey,token);if(window.sessionStorage.getItem(tokenStorageKey)!==token)throw new Error('Order-link storage unavailable');setLookupToken(token);}

  function remember(id: string) {
    // Persist before prepare/dispatch. If browser storage fails, do not create an unrecoverable payment.
    window.sessionStorage.setItem(storageKey, id);
    if (window.sessionStorage.getItem(storageKey) !== id) throw new Error('Attempt could not be saved');
    setAttemptId(id);
  }
  async function status(id: string) {
    try {
      const checked = verifyMerchantAttempt(await post('status', { attemptId: id,checkoutToken:writeToken(id) }), id,expectedMode);
      setView(checked); setMissing(false);
      const savedToken=window.sessionStorage.getItem(tokenStorageKey);if(validMerchantLookupToken(savedToken))await lookup(savedToken);
      if (merchantMayReset(checked)) setUncertain(false);
    } catch (failure) {
      if (failure instanceof CommerceRequestError && failure.status === 404) {
        setMissing(true); setError('This saved checkout was not prepared. Enter pickup details to prepare the same saved identity.');
      } else setError('Status is unavailable. Keep this saved checkout identity and check again; do not start another payment.');
    }
  }
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const fragment=window.location.hash.startsWith('#order=')?window.location.hash.slice(7):undefined;
        if(fragment!==undefined){window.history.replaceState(null,'',window.location.pathname+window.location.search);window.sessionStorage.removeItem(storageKey+':lookup');setLookupOnly(true);if(!validMerchantLookupToken(fragment)){setLookupError('This private order link is invalid.');return;}window.sessionStorage.setItem(storageKey+':lookup',fragment);setLookupToken(fragment);await lookup(fragment);return;}
        const privateLookup=window.sessionStorage.getItem(storageKey+':lookup');if(validMerchantLookupToken(privateLookup)){setLookupOnly(true);setLookupToken(privateLookup);await lookup(privateLookup);return;}
        const token=window.sessionStorage.getItem(tokenStorageKey);if(validMerchantLookupToken(token))setLookupToken(token);
        const saved = window.sessionStorage.getItem(storageKey);
        if (saved) {
          if (!validId(saved)) throw new Error('Saved checkout identity is invalid');
          try{writeToken(saved);}catch{if(validMerchantLookupToken(token)){setLookupOnly(true);setLookupToken(token);await lookup(token);setLookupError('Only read-only order access remains. Contact the store for help; do not create a replacement payment.');return;}throw new Error('Checkout authorization is unavailable');}
          setAttemptId(saved); setStep('checkout');
          await status(saved);
        }
      } catch { if (!disposed) { setStorageBlocked(true); setError('Browser storage or the saved checkout is unavailable. Checkout is blocked until recovery is possible.'); } }
      finally { if (!disposed) setInitializing(false); }
    })();
    return () => { disposed = true; };
  }, [storageKey]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step]);
  useEffect(() => {
    if (!canPay || step !== 'checkout') return;
    let disposed = false;
    setCardReady(false);
    void attachMerchantCard(payment, `#${cardTarget}`, { isSecureContext: window.isSecureContext, loadSdk: loadMerchantPaymentSdk })
      .then(controller => { if (disposed) { void controller.destroy(); return; } card.current = controller; setCardReady(true); })
      .catch(() => { if (!disposed) setError(`Secure Square ${test?'test-card':'card'} fields could not load. Check this attempt status before trying again.`); });
    return () => { disposed = true; setCardReady(false); const previous = card.current; card.current = null; if (previous) void previous.destroy().catch(() => {}); };
  }, [canPay, step, payment, cardTarget]);
  async function run(work: () => Promise<void>) {
    if (pending.current || initializing || storageBlocked) return;
    pending.current = true; setBusy(true); setError('');
    try { await work(); }
    finally { pending.current = false; setBusy(false); }
  }
  function add(item: CartItem) {
    if (locked) return;
    const existing = items.find(line => line.variantId === item.variantId);
    const stock = catalog.products.find(p => p.id === item.productId)?.variants.find(v => v.id === item.variantId)?.stockQuantity ?? 0;
    if ((existing?.quantity ?? 0) >= Math.min(stock, 99)) { setError('The available quantity is already in your cart.'); return; }
    setItems(existing ? items.map(line => line === existing ? { ...line, quantity: line.quantity + 1 } : line) : [...items, item]);
    setQuote(undefined); setNotice('Added to your cart. Choose pickup when you are ready.');
  }
  function quantity(variantId:string,value:number) {
    if(locked)return;
    try{setItems(merchantCartQuantity(items,variantId,value,catalog));setQuote(undefined);setError('');setStep('pickup');}
    catch{setError('That quantity is not currently available. Choose a whole number within the available stock.');}
  }
  function review(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      if (attemptId && missing) { await prepare(attemptId); return; }
      try { const checked=verifyMerchantQuote(await post('quote', { items, currency: 'USD', fulfillment: 'pickup' }));saveWriteToken(checked.quoteId,checked.checkoutToken);setQuote(checked);setStep('checkout'); }
      catch { setError('Square could not confirm this cart total. Review availability and try again. No payment was submitted.'); }
    });
  }
  async function prepare(id: string) {
    try {
      remember(id);
      const checked = verifyMerchantAttempt(await post('prepare', { quoteId: id, pickup,checkoutToken:writeToken(id) }), id,expectedMode);
      if(checked.confirmation?.lookupToken){saveConfirmation(checked.confirmation.lookupToken);await lookup(checked.confirmation.lookupToken);}
      else if(!validMerchantLookupToken(window.sessionStorage.getItem(tokenStorageKey)))setError('Your private confirmation link was not saved. Cancel this uncharged checkout and start again before entering a card.');
      setView(checked); setMissing(false); setStep('checkout'); setPickup({ name: '', email: '', phone: '' });
    } catch { setError('Preparation could not be confirmed. Check the saved attempt status before continuing.'); }
  }
  function pay() {
    void run(async () => {
      if (!card.current || !attemptId || !view || !canPay) return;
      let token: string;
      try { token = await card.current.tokenize(view.amountMinor, { countryCode: 'US' }); }
      catch { setError('Card verification did not finish. No payment request was sent.'); return; }
      // The token stays in this call only; never put card tokens or contact data in browser storage.
      setUncertain(true);
      try {
        const checked = verifyMerchantAttempt(await post('submit', { attemptId, cardToken: token,checkoutToken:writeToken(attemptId) }), attemptId,expectedMode);
        setView(checked);if(lookupToken)await lookup(lookupToken);
        if (merchantMayReset(checked)) setUncertain(false);
      } catch { setError('Payment outcome is unknown. Check this same attempt status; do not submit another payment.'); }
    });
  }
  function reset() {
    if (busy || !merchantMayReset(view)) return;
    try { window.sessionStorage.removeItem(storageKey); window.sessionStorage.removeItem(tokenStorageKey); window.sessionStorage.removeItem(storageKey+':write'); } catch { setError('The saved identity could not be cleared. Keep this receipt.'); return; }
    setLookupToken(undefined);setConfirmation(undefined);
    setAttemptId(undefined); setView(undefined); setQuote(undefined); setItems([]); setUncertain(false); setMissing(false); setStep('shop'); setError('');
  }
  const pickupForm = <form className="merchant-pickup-form" onSubmit={review}><h2>{merchant.pickup.label}</h2><p>{merchant.pickup.instructions}</p>{storefront.pickupAvailability?.promisedAt&&<p>Earliest pickup: {promisedPickupLabel(storefront.pickupAvailability.promisedAt,storefront.pickupAvailability.timeZone??'UTC')}. Your quote confirms the final pickup promise.</p>}{storefront.pickupAvailability?.available===false&&<p role="status">Pickup is not currently available. Please check the store’s pickup hours or contact support.</p>}<p>{test?'Sandbox only: enter test pickup contact details.':'Enter the contact details for your pickup.'} These are sent to this merchant server, never saved in browser storage.</p>{(['name', 'email', 'phone'] as const).map(field => <label className="merchant-field" key={field}>{field === 'name' ? 'Pickup name' : field === 'email' ? 'Email' : 'Phone (with country code, e.g. +12025550100)'}<input required name={field} type={field === 'name' ? 'text' : field === 'email' ? 'email' : 'tel'} minLength={field === 'name' ? 2 : undefined} pattern={field === 'phone' ? '\\+[1-9][0-9]{7,14}' : undefined} maxLength={field === 'name' ? 100 : field === 'email' ? 254 : 30} autoComplete="off" value={pickup[field]} onChange={event => setPickup({ ...pickup, [field]: event.target.value })} disabled={busy} /></label>)}<button className="primary-action" disabled={busy || initializing || (!count && !missing)}>{busy ? 'Checking…' : missing ? 'Prepare saved checkout' : 'Review Square total'}</button></form>;
  if(lookupOnly)return <div className="storefront merchant-storefront" style={merchantTheme(merchant)}><header className="site-header"><StoreBrand merchant={merchant}/><button onClick={()=>{window.sessionStorage.removeItem(storageKey+':lookup');window.location.assign('/');}}>Back to shop</button></header><main><h1>Your order</h1>{initializing&&<p role="status">Checking your private order link…</p>}{lookupError&&<p role="alert">{lookupError}</p>}{confirmation&&<MerchantConfirmation emailEnabled={!test&&storefront.confirmationEmailEnabled===true} value={confirmation} link={lookupToken?'#order='+lookupToken:undefined}/>}<button disabled={busy||!lookupToken} onClick={()=>void run(async()=>{if(lookupToken)await lookup(lookupToken);})}>Refresh order status</button><p>{merchant.pickup.instructions}</p>{storefront.configuration&&<footer><nav aria-label="Order support and policies"><a href={safeMerchantPublicUrl(storefront.configuration.support.url)}>Contact the store</a> · <a href={safeMerchantPublicUrl(storefront.configuration.policies.privacyUrl)}>Privacy</a> · <a href={safeMerchantPublicUrl(storefront.configuration.policies.refundUrl)}>Refund policy</a></nav></footer>}</main></div>;
  return <div className="storefront merchant-storefront" style={merchantTheme(merchant)}>
    {test&&<div className="demo-banner">SQUARE SANDBOX <span>Test cards only · No live payments · No authorized pickup fulfillment</span></div>}
    <header className="site-header"><button className="brand merchant-brand-button" onClick={() => setStep('shop')}><StoreBrand merchant={merchant} /></button><nav aria-label="Store navigation"><button onClick={() => setStep('shop')}>Shop</button><button onClick={() => setStep(attemptId ? 'checkout' : 'pickup')} disabled={shippingLocked||(!count && !attemptId)}>Cart ({count})</button></nav></header>
    <MerchantCheckoutStatus enabled={storefront.checkoutEnabled} sandbox={test}/><nav className="shopping-steps" aria-label="Shopping progress">{(['shop', 'pickup', 'checkout'] as const).map((item, index) => <button key={item} aria-current={step === item ? 'step' : undefined} disabled={shippingLocked || busy || initializing || (item === 'pickup' && (!count || Boolean(attemptId))) || (item === 'checkout' && !quote && !attemptId)} onClick={() => setStep(item)}><span>{index + 1}</span>{item === 'shop' ? 'Shop' : item === 'pickup' ? 'Pickup' : 'Checkout'}</button>)}</nav>
    <main>
      {error && <p className="cart-error" role="alert">{error}</p>}{initializing && <p role="status">Checking for a saved checkout…</p>}
      {test&&storefront.shippingDevelopment&&!attemptId&&!quote&&<ShippingBuyerPanel items={items} storageKey={storageKey+':shipping'} onLock={setShippingLocked}/>}
      {step === 'shop' && <><section className="shop-hero" style={merchant.media ? { backgroundImage: `linear-gradient(90deg, #111118df, #111118b8), url("${merchant.media.hero}")` } : undefined}><div><h1 ref={heading} tabIndex={-1}>{merchant.tagline}</h1><p>{merchant.introduction}</p><p>Choose your favorites. Pickup at {merchant.pickup.label}.</p></div></section><section className="collection"><h2>Choose your favorites</h2><p className="section-description">USD · Pickup only. Square confirms taxes and applicable discounts before payment.</p>{!catalog.products.length && <p>No products are available yet. Please check back soon.</p>}<div className="product-grid">{catalog.products.map(product => <MerchantProduct key={product.id} product={product} media={merchant.media} locked={locked} add={add} />)}</div></section>{notice && <p role="status">{notice}</p>}{(count > 0 || attemptId) && <button className="floating-cart" disabled={shippingLocked} onClick={() => setStep(attemptId ? 'checkout' : 'pickup')}>{attemptId ? 'Resume saved checkout' : `Choose pickup · ${count} items`}</button>}</>}
      {step !== 'shop' && <div className="checkout-layout"><section className="flow-intro"><h1 ref={heading} tabIndex={-1}>{step === 'pickup' ? 'Choose pickup' : view?.state === 'completed' ? (test?'Sandbox payment confirmed':'Payment confirmed') : 'Review & checkout'}</h1>{(step === 'pickup' || missing) && pickupForm}{step === 'checkout' && !missing && <><h2>{merchant.pickup.label}</h2><p>{merchant.pickup.instructions}</p>{test&&<p>Use a Square sandbox test card only. This is not a real purchase or pickup authorization.</p>}</>}</section><section className="cart-panel"><h2>Your selections</h2><ul className="cart-lines">{items.map(item => { const product = catalog.products.find(p => p.id === item.productId); const variant = product?.variants.find(v => v.id === item.variantId); return <li key={item.variantId}><div><strong>{product?.name ?? 'Saved item'}</strong><p>{Object.values(variant?.selections ?? {}).join(' / ')} · Quantity {item.quantity}</p></div>{!locked && <div className="merchant-cart-quantity"><label>Quantity for {product?.name??'item'}<input type="number" min="1" max={Math.min(99,variant?.stockQuantity??0)} step="1" value={item.quantity} onChange={event=>quantity(item.variantId,Number(event.target.value))}/></label><button onClick={()=>quantity(item.variantId,0)}>Remove</button></div>}</li>; })}</ul>{quote && <QuoteTotals quote={quote} />}
        {quote && !attemptId && step === 'checkout' && <><p>Square-calculated total. Quote expires {new Date(quote.expiresAt).toLocaleTimeString()}.</p><button className="primary-action" disabled={busy} onClick={() => void run(async () => { if (Date.parse(quote.expiresAt) <= Date.now()) { setQuote(undefined); setStep('pickup'); setError('Your quote expired. Review the current Square total again.'); return; } await prepare(quote.quoteId); })}>{test?'Accept total & continue to test card':'Accept total & continue to card'}</button></>}
        {attemptId && <>{confirmation&&<MerchantConfirmation emailEnabled={!test&&storefront.confirmationEmailEnabled===true} value={confirmation} link={lookupToken?'#order='+lookupToken:undefined}/>} {lookupError&&<p role="alert">{lookupError}</p>}{view&&merchantMayPay(view)&&(!lookupToken||confirmation?.attemptId!==view.attemptId)&&<p role="alert">A private order-status link was not saved. No payment can be submitted. Cancel this uncharged checkout, then start again.</p>}<p>Saved checkout: <code>{attemptId}</code></p>{view && <><p role="status">Status: {view.state}. {view.requiresReconciliation || uncertain ? 'Keep this identity for reconciliation. No new payment will be submitted.' : ''}</p><p><strong>Accepted total: {formatPrice(view.amountMinor, 'USD')}</strong></p>{view.paymentId && <p>Payment: <code>{view.paymentId}</code></p>}{view.orderId && <p>Order: <code>{view.orderId}</code></p>}{view.refundedMinor > 0 && <p>Refunded: {formatPrice(view.refundedMinor, 'USD')}</p>}<p>Pickup state: {view.fulfillmentState}. {test?'Sandbox fulfillment is not authorized.':'Wait for the store’s pickup-ready confirmation.'}</p>{view.failureCode && <p>Result: {view.failureCode}</p>}</>}{canPay && <><div id={cardTarget} className="sandbox-card-host" aria-label={test?'Secure Square test card fields':'Secure Square card fields'} /><button className="primary-action" disabled={!cardReady || busy} onClick={pay}>{busy ? 'Processing…' : `Pay ${formatPrice(view!.amountMinor, 'USD')}${test?' in sandbox':''}`}</button></>}<div className="cart-actions"><button disabled={busy} onClick={() => void run(() => status(attemptId))}>Check this attempt status</button>{view?.state === 'reserved' && !uncertain && <button disabled={busy} onClick={() => void run(async () => { try { setView(verifyMerchantAttempt(await post('cancel', { attemptId,checkoutToken:writeToken(attemptId) }), attemptId,expectedMode)); } catch { setUncertain(true); setError('Cancellation could not be confirmed. Check this attempt status.'); } })}>Cancel before payment</button>}{merchantMayReset(view) && <button disabled={busy} onClick={reset}>Start a new cart</button>}</div></>}
      </section></div>}
    </main><footer><div><strong>{merchant.name}</strong><p>{merchant.descriptor}</p></div><div><strong>PICKUP</strong><p>{merchant.pickup.label}</p><p>{merchant.pickup.instructions}</p></div><div><strong>{test?'SANDBOX ONLY':'ORDER SUPPORT'}</strong>{storefront.configuration&&<><p><a href={safeMerchantPublicUrl(storefront.configuration.support.url)}>Contact the store</a></p><nav aria-label="Store policies"><a href={safeMerchantPublicUrl(storefront.configuration.policies.termsUrl)}>Terms</a> · <a href={safeMerchantPublicUrl(storefront.configuration.policies.privacyUrl)}>Privacy</a> · <a href={safeMerchantPublicUrl(storefront.configuration.policies.refundUrl)}>Refund policy</a></nav></>}<p>{test?'No live payments or customer emails.':'Save your private order-status link for updates.'}</p></div></footer>
  </div>;
}
