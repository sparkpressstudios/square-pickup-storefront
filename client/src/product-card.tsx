import { useEffect, useRef, useState } from 'react';
import { formatPrice, resolveVariant, variantAvailability, type Product } from '../../shared/catalog';
import type { CartItem } from '../../shared/checkout';
import type { MerchantConfig } from '../../shared/storefront';

export function ProductImage({ product, media, status }: { product: Product; media?: MerchantConfig['media']; status?: string }) {
  const image = media?.products[product.id];
  return <div className="product-image" role="img" aria-label={`Synthetic ${product.name} product illustration`} style={image ? { backgroundImage: `url("${image.src}")`, backgroundPosition: image.position, backgroundSize: image.layout === 'atlas' ? '200% 200%' : 'cover' } : undefined}>
    {!image && <span className="image-placeholder">{product.name}</span>}
    <span className="category-badge">{product.category}</span>{status && <span className="image-availability">{status}</span>}
  </div>;
}

export function ProductCard({ product, currency, media, onAdd, cartLocked, detail = false }: { product: Product; currency: 'USD'; media?: MerchantConfig['media']; onAdd: (item: CartItem) => boolean; cartLocked: boolean; detail?: boolean }) {
  const initialVariant = product.variants.find((variant) => variantAvailability(variant) === 'available') ?? product.variants[0]!;
  const [selections, setSelections] = useState<Record<string, string>>({ ...initialVariant.selections });
  const [quantity, setQuantity] = useState(1);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (detail) { title.current?.focus({ preventScroll: true }); window.scrollTo(0, 0); } }, [detail]);
  const variant = resolveVariant(product, selections);
  const availability = variantAvailability(variant);
  const status = availability === 'available' ? 'Available in demo' : availability === 'sold_out' ? 'Sold out' : 'Unavailable';
  const image = <ProductImage product={product} media={media} status={status} />;
  return <article className={detail ? 'product-detail' : 'product-card'} aria-label={product.name}>
    {detail ? image : <a href={`#product/${product.id}`} aria-label={`View ${product.name}`}>{image}</a>}
    <div className="product-copy">
      {detail ? <h1 ref={title} tabIndex={-1} className="flow-focus">{product.name}</h1> : <h3><a href={`#product/${product.id}`}>{product.name}</a></h3>}
      <p className="description">{product.description}</p>
      <div className="options">{product.options.map((option) => <fieldset key={option.id}><legend>{option.label}</legend><div className="choice-row">{option.values.map((value) => <label className={selections[option.id] === value ? 'choice selected' : 'choice'} key={value}>
        <input type="radio" name={`${product.id}-${option.id}`} value={value} checked={selections[option.id] === value} onChange={() => { setSelections({ ...selections, [option.id]: value }); setQuantity(1); }} />{value}
      </label>)}</div></fieldset>)}{!product.options.length && <p className="single-option">One standard option</p>}</div>
      <div className="variant-detail" aria-live="polite" aria-atomic="true"><strong>{variant ? formatPrice(variant.priceMinor, currency) : '—'}</strong><span className={`availability ${availability}`}>{availability === 'available' ? `${variant!.stockQuantity} in demo stock` : status}</span></div>
      <div className="product-purchase"><div className="quantity-controls" role="group" aria-label={`${product.name} quantity`}>
        <button type="button" disabled={cartLocked || quantity <= 1} aria-label={`Select fewer ${product.name}`} onClick={() => setQuantity((value) => value - 1)}>−</button><output aria-label={`${product.name} selected quantity`}>{quantity}</output><button type="button" disabled={cartLocked || availability !== 'available' || quantity >= Math.min(99, variant?.stockQuantity ?? 0)} aria-label={`Select more ${product.name}`} onClick={() => setQuantity((value) => value + 1)}>+</button>
      </div><button className="add-to-cart" type="button" disabled={cartLocked || availability !== 'available'} onClick={() => { if (variant && onAdd({ productId: product.id, variantId: variant.id, quantity })) setQuantity(1); }}>{availability === 'available' ? 'Add to demo cart' : status}</button></div>
      {detail && <div className="product-fulfillment"><strong>Pickup / Synthetic demo</strong><p>Review your pickup selection in checkout. This demo does not create a real purchase or pickup reservation.</p><p className="variant-note">{variant ? `SKU ${variant.sku}` : 'Choose another combination'}</p></div>}
    </div>
  </article>;
}
