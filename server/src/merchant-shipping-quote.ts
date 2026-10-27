import {createHash,randomUUID} from 'node:crypto';
import type {ShippingMerchandiseBasis,ShippingTaxRequest,ShippingTaxEvidence,ShippingPayableQuote} from '../../shared/merchant-shipping-quote';
import {buildShippingDraft,shippingDraftFingerprint} from './merchant-shipping';
const MAX=2_147_483_647;
export class ShippingQuoteError extends Error {
 constructor(readonly code:'SHIPPING_TAX_UNCONFIGURED'|'INVALID_SHIPPING_QUOTE'|'SHIPPING_TAX_UNAVAILABLE'|'UNVERIFIED_SHIPPING_TAX'|'SHIPPING_QUOTE_CHANGED'|'SHIPPING_QUOTE_EXPIRED'){super(code);}
}
export interface ShippingTaxAdapter {
 /** Must implement the merchant's reviewed destination/product/shipping-fee tax policy. No default. */
 quote(request:ShippingTaxRequest,signal:AbortSignal):Promise<ShippingTaxEvidence>;
}
export interface ShippingTaxConfiguration {readonly adapterId:string;readonly revision:string;readonly merchantId:string;readonly locationId:string}
function denseArray(value:unknown):value is unknown[] {
 return Array.isArray(value)&&value.length<=100&&Object.keys(value).length===value.length&&Array.from({length:value.length},(_,i)=>Object.hasOwn(value,i)).every(Boolean);
}
function canonical(value:unknown,depth=0):string {
 if(depth>16)throw new ShippingQuoteError('SHIPPING_QUOTE_CHANGED');
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value)){if(!denseArray(value))throw new ShippingQuoteError('SHIPPING_QUOTE_CHANGED');return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';}
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k],depth+1)).join(',')+'}';
 throw new ShippingQuoteError('SHIPPING_QUOTE_CHANGED');
}
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const money=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<=MAX;
function exact(value:unknown,keys:string[]):value is Record<string,unknown> {
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
}
function basis(input:ShippingMerchandiseBasis):ShippingMerchandiseBasis {
 if(!exact(input,['cartFingerprint','lines','subtotalMinor','discountMinor','basisMinor','currency'])||typeof input.cartFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(input.cartFingerprint)||input.currency!=='USD'||!money(input.subtotalMinor)||!money(input.discountMinor)||!money(input.basisMinor)||input.discountMinor>input.subtotalMinor||input.basisMinor!==input.subtotalMinor-input.discountMinor)throw new ShippingQuoteError('INVALID_SHIPPING_QUOTE');
 if(!denseArray(input.lines)||input.lines.length<1)throw new ShippingQuoteError('INVALID_SHIPPING_QUOTE');
 const ids=new Set<string>();
 const lines=input.lines.map(line=>{
  if(!exact(line,['id','quantity','subtotalMinor','discountMinor','basisMinor','taxCategory'])||typeof line.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(line.id)||ids.has(line.id)||typeof line.quantity!=='number'||!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>999||!money(line.subtotalMinor)||!money(line.discountMinor)||!money(line.basisMinor)||line.discountMinor>line.subtotalMinor||line.basisMinor!==line.subtotalMinor-line.discountMinor||typeof line.taxCategory!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(line.taxCategory))throw new ShippingQuoteError('INVALID_SHIPPING_QUOTE');
  ids.add(line.id);return Object.freeze({id:line.id,quantity:line.quantity,subtotalMinor:line.subtotalMinor,discountMinor:line.discountMinor,basisMinor:line.basisMinor,taxCategory:line.taxCategory});
 });
 for(const key of ['subtotalMinor','discountMinor','basisMinor'] as const)if(lines.reduce((sum,line)=>sum+line[key],0)!==input[key])throw new ShippingQuoteError('INVALID_SHIPPING_QUOTE');
 return Object.freeze({cartFingerprint:input.cartFingerprint,lines:Object.freeze(lines),subtotalMinor:input.subtotalMinor,discountMinor:input.discountMinor,basisMinor:input.basisMinor,currency:'USD'});
}
function configuration(input:ShippingTaxConfiguration|undefined):ShippingTaxConfiguration {
 if(!input||!exact(input,['adapterId','revision','merchantId','locationId'])||typeof input.merchantId!=='string'||!/^[A-Za-z0-9_-]{1,192}$/.test(input.merchantId)||typeof input.locationId!=='string'||!/^[A-Za-z0-9_-]{1,192}$/.test(input.locationId)||typeof input.adapterId!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(input.adapterId)||typeof input.revision!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(input.revision))throw new ShippingQuoteError('SHIPPING_TAX_UNCONFIGURED');
 return Object.freeze({...input});
}
function requestFingerprint(request:Omit<ShippingTaxRequest,'requestFingerprint'>,adapterId:string):string {
 shippingDraftFingerprint(request.shipping);
 return hash({adapterId,merchantId:request.merchantId,locationId:request.locationId,merchandise:request.merchandise,shipping:request.shipping,taxConfigurationRevision:request.taxConfigurationRevision,expiresAt:request.expiresAt});
}
function evidence(value:unknown,request:ShippingTaxRequest,now:number):ShippingTaxEvidence {
 const fields=['requestFingerprint','configurationRevision','reference','currency','merchandiseIncludedTaxMinor','merchandiseAdditionalTaxMinor','shippingIncludedTaxMinor','shippingAdditionalTaxMinor','totalMinor','expiresAt'];
 if(!exact(value,fields)||value.requestFingerprint!==request.requestFingerprint||value.configurationRevision!==request.taxConfigurationRevision||value.currency!=='USD'||typeof value.reference!=='string'||!/^[a-zA-Z0-9._:-]{1,192}$/.test(value.reference)||typeof value.expiresAt!=='string')throw new ShippingQuoteError('UNVERIFIED_SHIPPING_TAX');
 for(const field of ['merchandiseIncludedTaxMinor','merchandiseAdditionalTaxMinor','shippingIncludedTaxMinor','shippingAdditionalTaxMinor','totalMinor'])if(!money(value[field]))throw new ShippingQuoteError('UNVERIFIED_SHIPPING_TAX');
 const v=value as unknown as ShippingTaxEvidence,expiry=Date.parse(v.expiresAt);
 if(!Number.isFinite(expiry)||expiry<=now||expiry>Date.parse(request.expiresAt)||new Date(expiry).toISOString()!==v.expiresAt||v.merchandiseIncludedTaxMinor>request.merchandise.basisMinor||v.shippingIncludedTaxMinor>request.shipping.shippingFeeMinor||v.totalMinor!==request.merchandise.basisMinor+request.shipping.shippingFeeMinor+v.merchandiseAdditionalTaxMinor+v.shippingAdditionalTaxMinor||v.totalMinor<1)throw new ShippingQuoteError('UNVERIFIED_SHIPPING_TAX');
 return Object.freeze({...v});
}
/** Registered server adapter only. No route, default tax, retries, carrier requests or payment dispatch. */
export class ShippingQuoteService {
 private readonly config:ShippingTaxConfiguration;
 private readonly adapter:ShippingTaxAdapter;
 constructor(config:ShippingTaxConfiguration|undefined,registry:ReadonlyMap<string,ShippingTaxAdapter>,private readonly now=Date.now,private readonly timeoutMs=4000) {
  this.config=configuration(config);const adapter=registry.get(this.config.adapterId);
  if(!adapter||typeof adapter.quote!=='function')throw new ShippingQuoteError('SHIPPING_TAX_UNCONFIGURED');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>4000)throw new ShippingQuoteError('INVALID_SHIPPING_QUOTE');
  this.adapter=Object.freeze({quote:adapter.quote.bind(adapter)});
 }
 async quote(merchandise:ShippingMerchandiseBasis,policy:unknown,address:unknown,rateId:unknown):Promise<ShippingPayableQuote> {
  const core={merchantId:this.config.merchantId,locationId:this.config.locationId,merchandise:basis(merchandise),shipping:buildShippingDraft(policy,address,rateId),taxConfigurationRevision:this.config.revision,expiresAt:new Date(this.now()+10*60*1000).toISOString()};
  const request=Object.freeze({requestFingerprint:requestFingerprint(core,this.config.adapterId),...core});
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let raw:unknown;
  try {
   const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ShippingQuoteError('SHIPPING_TAX_UNAVAILABLE'));},this.timeoutMs);});
   raw=await Promise.race([Promise.resolve().then(()=>this.adapter.quote(request,controller.signal)),timeout]);
  } catch {throw new ShippingQuoteError('SHIPPING_TAX_UNAVAILABLE');}
  finally {clearTimeout(timer);}
  const tax=evidence(raw,request,this.now());
  const quote={id:randomUUID(),request,tax,totalMinor:tax.totalMinor,currency:'USD' as const,expiresAt:tax.expiresAt,paymentExecutionEnabled:false as const};
  return Object.freeze({...quote,fingerprint:hash(quote)});
 }
 /** For server-owned retained quotes only. Fingerprint is integrity evidence, not authorization. */
 assertUnchanged(original:ShippingPayableQuote,candidate:ShippingPayableQuote):void {
  const {fingerprint,...body}=candidate;
  if(candidate.paymentExecutionEnabled!==false||hash(body)!==fingerprint||fingerprint!==original.fingerprint)throw new ShippingQuoteError('SHIPPING_QUOTE_CHANGED');
  if(Date.parse(candidate.expiresAt)<=this.now())throw new ShippingQuoteError('SHIPPING_QUOTE_EXPIRED');
 }
}
