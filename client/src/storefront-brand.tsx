import type { CSSProperties, Ref } from 'react';
import type { MerchantConfig } from '../../shared/storefront';
import { accentInk } from '../../shared/merchant-draft';

export function merchantTheme(merchant: MerchantConfig): CSSProperties {
  return { '--accent': merchant.theme.accent, '--accent-ink': accentInk(merchant.theme.accent), '--paper': merchant.theme.background } as CSSProperties;
}
export function StoreBrand({ merchant }: { merchant: MerchantConfig }) {
  return <>{merchant.name}<span>{merchant.descriptor}</span></>;
}
export function ShopHero({ merchant, headingRef, preview = false }: { merchant: MerchantConfig; headingRef?: Ref<HTMLHeadingElement>; preview?: boolean }) {
  const Heading = preview ? 'h2' : 'h1';
  return <section className="shop-hero" aria-label={preview ? 'Draft storefront header' : undefined} style={merchant.media ? { backgroundImage: `linear-gradient(90deg, #111118df, #111118b8), url("${merchant.media.hero}")` } : undefined}>
    <div><Heading className="flow-focus" ref={headingRef} tabIndex={preview ? undefined : -1}>{merchant.tagline}</Heading><p>{merchant.introduction}</p>
      {!preview && <details className="how-it-works"><summary>See how shopping works <span aria-hidden="true">⌄</span></summary><ol><li>Choose your products, options and quantities.</li><li>Select the configured demo pickup location.</li><li>Review a server-validated subtotal and simulate checkout.</li></ol><p>No money moves and no real pickup is reserved.</p></details>}
    </div>
  </section>;
}
