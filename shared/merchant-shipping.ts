/** Inert shipping foundation: not a live checkout option or tax/label service. */
export interface ShippingAddress {
 readonly name:string; readonly line1:string; readonly line2?:string;
 readonly city:string; readonly region:string; readonly postalCode:string; readonly country:'US';
}
export interface FixedShippingPolicy {
 readonly enabled:boolean; readonly revision:string;
 readonly rates:readonly {readonly id:string;readonly label:string;readonly regions:readonly string[];readonly amountMinor:number}[];
}
export interface ShippingDraft {
 readonly kind:'shipment'; readonly address:ShippingAddress;
 readonly rateId:string; readonly rateLabel:string; readonly policyRevision:string;
 readonly shippingFeeMinor:number; readonly currency:'USD';
 /** Not an order total; destination and shipping-fee taxes still require authoritative evidence. */
 readonly taxStatus:'unresolved'; readonly checkoutEnabled:false;
}
