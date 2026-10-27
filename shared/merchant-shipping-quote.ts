import type {ShippingDraft} from './merchant-shipping';
/** Server-owned prices. basisMinor includes any inclusive tax already embedded in configured prices. */
export interface ShippingMerchandiseBasis {
 readonly cartFingerprint:string;
 readonly lines:readonly {readonly id:string;readonly quantity:number;readonly subtotalMinor:number;readonly discountMinor:number;readonly basisMinor:number;readonly taxCategory:string}[];
 readonly subtotalMinor:number;
 readonly discountMinor:number;
 readonly basisMinor:number;
 readonly currency:'USD';
}
export interface ShippingTaxRequest {
 readonly requestFingerprint:string;
 readonly merchantId:string;
 readonly locationId:string;
 readonly merchandise:ShippingMerchandiseBasis;
 readonly shipping:ShippingDraft;
 readonly taxConfigurationRevision:string;
 readonly expiresAt:string;
}
/** Evidence from the selected trusted server adapter, never buyer-submitted amounts. */
export interface ShippingTaxEvidence {
 readonly requestFingerprint:string;
 readonly configurationRevision:string;
 readonly reference:string;
 readonly currency:'USD';
 readonly merchandiseIncludedTaxMinor:number;
 readonly merchandiseAdditionalTaxMinor:number;
 readonly shippingIncludedTaxMinor:number;
 readonly shippingAdditionalTaxMinor:number;
 readonly totalMinor:number;
 readonly expiresAt:string;
}
export interface ShippingPayableQuote {
 readonly id:string;
 readonly request:ShippingTaxRequest;
 readonly tax:ShippingTaxEvidence;
 readonly totalMinor:number;
 readonly currency:'USD';
 readonly expiresAt:string;
 readonly fingerprint:string;
 /** Validated amount is not permission to execute a charge; live integration is absent. */
 readonly paymentExecutionEnabled:false;
}
