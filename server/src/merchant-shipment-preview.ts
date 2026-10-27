/** Offline Square SHIPMENT contract preparation. No HTTP/payment or live checkout wiring. */
import {isDeepStrictEqual} from 'node:util';
import type {ShippingDraft} from '../../shared/merchant-shipping';
import {shippingDraftFingerprint} from './merchant-shipping';
export class ShipmentEvidenceError extends Error {constructor(){super('UNVERIFIED_SHIPMENT');}}
export interface ShipmentContact {readonly email:string;readonly phone:string}
function contactValue(contact:ShipmentContact) {
 if(!contact||typeof contact.email!=='string'||contact.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)||typeof contact.phone!=='string'||!/^\+[1-9]\d{7,14}$/.test(contact.phone)||Object.keys(contact).some(k=>k!=='email'&&k!=='phone'))throw new ShipmentEvidenceError();
 return {email_address:contact.email,phone_number:contact.phone};
}
/** A fragment for contract tests, not an authorized CreateOrder request. No monetary/tax claim. */
export function shipmentFulfillmentPreview(draft:ShippingDraft,contact:ShipmentContact) {
 shippingDraftFingerprint(draft);
 const a=draft.address;
 return {type:'SHIPMENT' as const,state:'PROPOSED' as const,shipment_details:{recipient:{display_name:a.name,...contactValue(contact),address:{address_line_1:a.line1,...(a.line2?{address_line_2:a.line2}:{}),locality:a.city,administrative_district_level_1:a.region,postal_code:a.postalCode,country:a.country}}}};
}
const states=['PROPOSED','RESERVED','PREPARED','COMPLETED','CANCELED','FAILED'] as const;
export type ShipmentState=typeof states[number];
export function shipmentStateLabel(state:ShipmentState):string {
 return {PROPOSED:'Awaiting shipment preparation',RESERVED:'Preparing shipment',PREPARED:'Packaged',COMPLETED:'Shipped',CANCELED:'Canceled',FAILED:'Shipment failed'}[state];
}
/** One fulfillment only. Matching does not certify payment, tax, carrier acceptance or delivery. */
export function verifyShipmentFragment(raw:unknown,draft:ShippingDraft,contact:ShipmentContact,expectedUid?:string) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ShipmentEvidenceError();
 const value=raw as Record<string,unknown>,details=value.shipment_details as Record<string,unknown>|undefined;
 if(value.type!=='SHIPMENT'||typeof value.uid!=='string'||!/^\S{1,192}$/.test(value.uid)||(expectedUid!==undefined&&value.uid!==expectedUid)||!states.includes(value.state as ShipmentState)||!details||typeof details!=='object'||Array.isArray(details)||value.pickup_details!==undefined||value.delivery_details!==undefined)throw new ShipmentEvidenceError();
 const expected=shipmentFulfillmentPreview(draft,contact).shipment_details.recipient;
 if(!isDeepStrictEqual(details.recipient,expected))throw new ShipmentEvidenceError();
 return {uid:value.uid,state:value.state as ShipmentState,label:shipmentStateLabel(value.state as ShipmentState),paymentVerified:false as const,deliveryVerified:false as const};
}
