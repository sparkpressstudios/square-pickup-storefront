import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {SqlDatabase} from '../../db/sql-database';
import {validAttemptId} from '../../shared/checkout';
import type {ShippingAddress} from '../../shared/merchant-shipping';
import type {ShippingMerchandiseBasis,ShippingPayableQuote} from '../../shared/merchant-shipping-quote';
import {parseShippingAddress} from './merchant-shipping';
import {ShippingQuoteService} from './merchant-shipping-quote';
import {shipmentFulfillmentPreview,type ShipmentContact} from './merchant-shipment-preview';
import {verifyShippingMoney} from './merchant-shipping-money';
export class ShippingCheckoutError extends Error {constructor(readonly code:string){super(code);}}
export interface ShippingRehearsalConfiguration {
 merchandise:ShippingMerchandiseBasis; policy:unknown; tax?:ShippingQuoteService;
 /** Trusted server CalculateOrder adapter, never request-body evidence. Tests use synthetic data only. */
 calculate?: (quote:ShippingPayableQuote,signal:AbortSignal)=>Promise<unknown>;
}
export type ShippingRehearsalResolver=(cartId:string)=>Promise<ShippingRehearsalConfiguration>;
type Row={request_id:string;cart_id:string;input_fingerprint:string;state:'quoting'|'quoted'|'preview_prepared'|'failed';quote:ShippingPayableQuote|null;preparation:unknown};
function exact(v:unknown,keys:string[]):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
function identity(v:unknown):string {if(!validAttemptId(v))throw new ShippingCheckoutError('INVALID_SHIPPING_REQUEST');return v.toLowerCase();}
function rate(v:unknown):string {if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(v))throw new ShippingCheckoutError('INVALID_SHIPPING_REQUEST');return v;}
/** Durable, admin-only OFFLINE checkout rehearsal. No payment/stock/order provider exists here. */
export class ShippingCheckoutRehearsal {
 private readonly context:Readonly<{merchantId:string;locationId:string}>;
 private readonly pending=new Map<string,{fingerprint:string;promise:Promise<ReturnType<ShippingCheckoutRehearsal['result']>>}>();
 constructor(private readonly db:SqlDatabase,context:{merchantId:string;locationId:string},private readonly resolve:ShippingRehearsalResolver){
  if(!/^[A-Za-z0-9_-]{1,192}$/.test(context.merchantId)||!/^[A-Za-z0-9_-]{1,192}$/.test(context.locationId))throw new ShippingCheckoutError('INVALID_SHIPPING_CONTEXT');this.context=Object.freeze({...context});
 }
 private result(row:Row){if(!row.quote||row.quote.request.merchantId!==this.context.merchantId||row.quote.request.locationId!==this.context.locationId)throw new ShippingCheckoutError('SHIPPING_QUOTE_REVIEW');return {quote:row.quote,state:row.state,rehearsalOnly:true as const,paymentExecutionEnabled:false as const};}
 private async configuration(cartId:string){const c=await this.resolve(cartId);if(!c.tax||!c.calculate)throw new ShippingCheckoutError('SHIPPING_UNCONFIGURED');return {merchandise:structuredClone(c.merchandise),policy:structuredClone(c.policy),tax:c.tax,calculate:c.calculate.bind(c)};}
 quote(input:unknown){
  if(!exact(input,['requestId','cartId','address','rateId'])||typeof input.cartId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.cartId))throw new ShippingCheckoutError('INVALID_SHIPPING_REQUEST');
  const requestId=identity(input.requestId),cartId=input.cartId,address=parseShippingAddress(input.address),rateId=rate(input.rateId),fingerprint=createHash('sha256').update(JSON.stringify({cartId,address,rateId})).digest('hex');
  const existing=this.pending.get(requestId);if(existing){if(existing.fingerprint!==fingerprint)throw new ShippingCheckoutError('SHIPPING_REQUEST_CHANGED');return existing.promise;}
  if(this.pending.size>=20)throw new ShippingCheckoutError('SHIPPING_RATE_LIMITED');
  const promise=this.create(requestId,cartId,address,rateId,fingerprint).finally(()=>this.pending.delete(requestId));this.pending.set(requestId,{fingerprint,promise});return promise;
 }
 private async create(requestId:string,cartId:string,address:ShippingAddress,rateId:string,fingerprint:string){
  const config=await this.configuration(cartId);
  const claimed=await this.db.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shipping-preview:${this.context.merchantId}:${this.context.locationId}`]);
   const inserted=await tx.query('INSERT INTO merchant_shipping_checkout_previews(request_id,merchant_id,location_id,cart_id,input_fingerprint,state) VALUES($1,$2,$3,$4,$5,\'quoting\') ON CONFLICT(request_id) DO NOTHING RETURNING request_id',[requestId,this.context.merchantId,this.context.locationId,cartId,fingerprint]);
   const row=(await tx.query<Row>('SELECT * FROM merchant_shipping_checkout_previews WHERE request_id=$1 AND merchant_id=$2 AND location_id=$3',[requestId,this.context.merchantId,this.context.locationId])).rows[0];
   if(inserted.rows.length){const count=(await tx.query<{count:string}>("SELECT count(*)::text AS count FROM merchant_shipping_checkout_previews WHERE merchant_id=$1 AND location_id=$2 AND created_at>now()-interval '1 minute'",[this.context.merchantId,this.context.locationId])).rows[0];if(Number(count?.count)>10)throw new ShippingCheckoutError('SHIPPING_RATE_LIMITED');}
   if(!row||row.input_fingerprint!==fingerprint||row.cart_id!==cartId)throw new ShippingCheckoutError('SHIPPING_REQUEST_CHANGED');return {row,fresh:inserted.rows.length===1};
  });
  if(!claimed.fresh){if(!claimed.row.quote||!['quoted','preview_prepared'].includes(claimed.row.state))throw new ShippingCheckoutError('SHIPPING_QUOTE_REVIEW');config.tax.assertUnchanged(claimed.row.quote,claimed.row.quote);return this.result(claimed.row);}
  try {
   const quote=await config.tax.quote(config.merchandise,config.policy,address,rateId);
   if(quote.request.merchantId!==this.context.merchantId||quote.request.locationId!==this.context.locationId)throw new ShippingCheckoutError('SHIPPING_CONTEXT_MISMATCH');
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let raw:unknown;
   try {raw=await Promise.race([Promise.resolve().then(()=>config.calculate(quote,controller.signal)),new Promise<never>((_r,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ShippingCheckoutError('SHIPPING_PRICING_UNAVAILABLE'));},4000);})]);} finally {clearTimeout(timer);}
   verifyShippingMoney(raw,quote);config.tax.assertUnchanged(quote,quote);
   const rows=await this.db.query<Row>("UPDATE merchant_shipping_checkout_previews SET state='quoted',quote_id=$2,quote=$3::jsonb WHERE request_id=$1 AND merchant_id=$4 AND location_id=$5 AND state='quoting' RETURNING *",[requestId,quote.id,JSON.stringify(quote),this.context.merchantId,this.context.locationId]);
   if(rows.rows.length!==1)throw new ShippingCheckoutError('SHIPPING_QUOTE_REVIEW');return this.result(rows.rows[0]!);
  } catch {await this.db.query("UPDATE merchant_shipping_checkout_previews SET state='failed',failure_code='SHIPPING_QUOTE_FAILED' WHERE request_id=$1 AND merchant_id=$2 AND location_id=$3 AND state='quoting'",[requestId,this.context.merchantId,this.context.locationId]);throw new ShippingCheckoutError('SHIPPING_QUOTE_FAILED');}
 }
 async prepare(input:unknown){
  if(!exact(input,['quoteId','address','rateId','contact']))throw new ShippingCheckoutError('INVALID_SHIPPING_REQUEST');
  const quoteId=identity(input.quoteId),address=parseShippingAddress(input.address),rateId=rate(input.rateId);
  // Clone and validate before any await; the mapper below rejects extra/invalid contact fields.
  if(!exact(input.contact,['email','phone']))throw new ShippingCheckoutError('INVALID_SHIPPING_REQUEST');const contact={email:input.contact.email,phone:input.contact.phone} as ShipmentContact;
  const row=(await this.db.query<Row>('SELECT * FROM merchant_shipping_checkout_previews WHERE quote_id=$1 AND merchant_id=$2 AND location_id=$3',[quoteId,this.context.merchantId,this.context.locationId])).rows[0];
  if(!row?.quote||!['quoted','preview_prepared'].includes(row.state))throw new ShippingCheckoutError('SHIPPING_QUOTE_NOT_FOUND');
  const originalQuote=row.quote;const config=await this.configuration(row.cart_id);config.tax.assertCurrentInputs(originalQuote,config.merchandise,config.policy,address,rateId);const preparation=shipmentFulfillmentPreview(row.quote.request.shipping,contact);
  return this.db.transaction(async tx=>{
   const current=(await tx.query<Row>('SELECT * FROM merchant_shipping_checkout_previews WHERE quote_id=$1 AND merchant_id=$2 AND location_id=$3 FOR UPDATE',[quoteId,this.context.merchantId,this.context.locationId])).rows[0];
   if(!current?.quote||!['quoted','preview_prepared'].includes(current.state))throw new ShippingCheckoutError('SHIPPING_QUOTE_NOT_FOUND');config.tax.assertUnchanged(originalQuote,current.quote);
   if(current.state==='preview_prepared'&&!isDeepStrictEqual(current.preparation,preparation))throw new ShippingCheckoutError('SHIPPING_PREPARATION_CHANGED');
   if(current.state==='quoted')await tx.query("UPDATE merchant_shipping_checkout_previews SET state='preview_prepared',preparation=$2::jsonb WHERE quote_id=$1 AND merchant_id=$3 AND location_id=$4",[quoteId,JSON.stringify(preparation),this.context.merchantId,this.context.locationId]);
   return {...this.result({...current,state:'preview_prepared'}),fulfillment:preparation};
  });
 }
 execute():never {throw new ShippingCheckoutError('SHIPPING_EXECUTION_DISABLED');}
}
