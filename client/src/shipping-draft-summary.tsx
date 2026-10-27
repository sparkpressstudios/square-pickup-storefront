import type {ShippingDraft} from '../../shared/merchant-shipping';
/** Offline/developer preview only; not mounted in buyer checkout or admin routes. */
export function ShippingDraftSummary({draft}:{draft:ShippingDraft}) {
 return <section aria-label="Shipping preview" className="admin-card"><h2>Shipping preview — not enabled</h2>
 <p>Method: {draft.rateLabel}. Shipping fee before tax: {(draft.shippingFeeMinor/100).toLocaleString('en-US',{style:'currency',currency:'USD'})}.</p>
 <p>Destination: {draft.address.city}, {draft.address.region} {draft.address.postalCode}, {draft.address.country}.</p>
 <p role="status">Destination and shipping-fee tax is unresolved. This is not a payable quote; shipping checkout is disabled.</p>
 <p>Pickup remains available under the existing merchant settings. Shipping requires reviewed rates/taxes, an immutable order snapshot, fulfillment tracking, and end-to-end acceptance before activation.</p></section>;
}
