import {createHash} from 'node:crypto';
import type {FixedShippingPolicy,ShippingAddress,ShippingDraft} from '../../shared/merchant-shipping';
const regions=new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
/** Safe error codes only: never echo a customer's shipping address. */
export class ShippingError extends Error {
 constructor(readonly code:'INVALID_ADDRESS'|'INVALID_SHIPPING_POLICY'|'SHIPPING_DISABLED'|'SHIPPING_UNAVAILABLE'|'SHIPPING_CHANGED'){super(code);}
}
function object(input:unknown,required:string[],optional:string[],code:'INVALID_ADDRESS'|'INVALID_SHIPPING_POLICY') {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new ShippingError(code);
 const v=input as Record<string,unknown>;
 if(required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))throw new ShippingError(code);
 return v;
}
function text(value:unknown,max:number,code:'INVALID_ADDRESS'|'INVALID_SHIPPING_POLICY') {
 if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value)||!value.trim())throw new ShippingError(code);
 return value.trim();
}
export function parseShippingAddress(input:unknown):ShippingAddress {
 const code='INVALID_ADDRESS',v=object(input,['name','line1','city','region','postalCode','country'],['line2'],code);
 const name=text(v.name,100,code),line1=text(v.line1,120,code),city=text(v.city,80,code);
 const region=text(v.region,2,code).toUpperCase(),postalCode=text(v.postalCode,10,code);
 if(v.country!=='US'||!regions.has(region)||!/^\d{5}(?:-\d{4})?$/.test(postalCode))throw new ShippingError(code);
 const line2=v.line2===undefined?undefined:text(v.line2,120,code);
 return Object.freeze({name,line1,...(line2?{line2}:{}),city,region,postalCode,country:'US'});
}
/** Server configuration only. Never pass request.body as the policy argument to a quote builder. */
export function parseFixedShippingPolicy(input:unknown):FixedShippingPolicy {
 const code='INVALID_SHIPPING_POLICY',v=object(input,['enabled','revision','rates'],[],code);
 if(typeof v.enabled!=='boolean'||typeof v.revision!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(v.revision)||!Array.isArray(v.rates)||v.rates.length>20||(v.enabled&&v.rates.length===0))throw new ShippingError(code);
 const ids=new Set<string>();
 const rates=v.rates.map(input=>{
  const r=object(input,['id','label','regions','amountMinor'],[],code);
  if(typeof r.id!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(r.id)||ids.has(r.id)||!Number.isSafeInteger(r.amountMinor)||(r.amountMinor as number)<0||(r.amountMinor as number)>100000||!Array.isArray(r.regions)||!r.regions.length||r.regions.length>51||r.regions.some(x=>typeof x!=='string'||!regions.has(x))||new Set(r.regions).size!==r.regions.length)throw new ShippingError(code);
  ids.add(r.id);return Object.freeze({id:r.id,label:text(r.label,80,code),regions:Object.freeze([...r.regions] as string[]),amountMinor:r.amountMinor as number});
 });
 return Object.freeze({enabled:v.enabled,revision:v.revision,rates:Object.freeze(rates)});
}
/** Fee-only preview; deliberately cannot produce a payable amount or enable checkout. */
export function buildShippingDraft(policyInput:unknown,addressInput:unknown,rateId:unknown):ShippingDraft {
 const policy=parseFixedShippingPolicy(policyInput);if(!policy.enabled)throw new ShippingError('SHIPPING_DISABLED');
 const address=parseShippingAddress(addressInput);
 if(typeof rateId!=='string')throw new ShippingError('SHIPPING_UNAVAILABLE');
 const rate=policy.rates.find(r=>r.id===rateId&&r.regions.includes(address.region));
 if(!rate)throw new ShippingError('SHIPPING_UNAVAILABLE');
 return Object.freeze({kind:'shipment',address,rateId:rate.id,rateLabel:rate.label,policyRevision:policy.revision,shippingFeeMinor:rate.amountMinor,currency:'USD',taxStatus:'unresolved',checkoutEnabled:false});
}
/** Integrity binding for future persisted quotes, NOT authorization, PII encryption or a bearer token. */
export function shippingDraftFingerprint(draft:ShippingDraft):string {
 object(draft,['kind','address','rateId','rateLabel','policyRevision','shippingFeeMinor','currency','taxStatus','checkoutEnabled'],[],'INVALID_SHIPPING_POLICY');
 const normalized=buildShippingDraft({enabled:true,revision:draft.policyRevision,rates:[{id:draft.rateId,label:draft.rateLabel,regions:[draft.address.region],amountMinor:draft.shippingFeeMinor}]},draft.address,draft.rateId);
 if(draft.kind!=='shipment'||draft.currency!=='USD'||draft.taxStatus!=='unresolved'||draft.checkoutEnabled!==false)throw new ShippingError('SHIPPING_CHANGED');
 return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export function assertShippingDraftUnchanged(original:ShippingDraft,current:ShippingDraft):void {
 if(shippingDraftFingerprint(original)!==shippingDraftFingerprint(current))throw new ShippingError('SHIPPING_CHANGED');
}
