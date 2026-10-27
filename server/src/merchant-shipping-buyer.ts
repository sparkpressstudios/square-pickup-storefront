import {createHash,randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {SqlDatabase,SqlExecutor} from '../../db/sql-database';
import {parseCartRequest,quoteCart,validAttemptId,type CartRequest} from '../../shared/checkout';
import type {ShippingMerchandiseBasis,ShippingPayableQuote} from '../../shared/merchant-shipping-quote';
import {readMerchantCatalog} from './merchant-commerce';
import {parseFixedShippingPolicy,parseShippingAddress} from './merchant-shipping';
import {ShippingQuoteService} from './merchant-shipping-quote';
import {verifyShippingMoney} from './merchant-shipping-money';
import {shipmentFulfillmentPreview,type ShipmentContact} from './merchant-shipment-preview';
export class ShippingBuyerError extends Error {constructor(readonly code:string){super(code);}}
interface Configuration {revision:number;policy:unknown;tax_categories:Record<string,string>;tax_configuration_id:string}
interface QuoteRow {canceled:boolean;id:string;configuration_revision:number;cart:CartRequest;quote:ShippingPayableQuote;expires_at:Date|string;fulfillment_kind:string}
interface Attempt {id:string;state:'reserved'|'canceled'|'expired';fulfillment_kind:string;fulfillment_snapshot:unknown}
export interface ShippingBuyerAdapter {tax:ShippingQuoteService;calculate:(quote:ShippingPayableQuote,signal:AbortSignal)=>Promise<unknown>}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function fail(code:string):never {throw new ShippingBuyerError(code);}
/** Buyer capability + actual shared inventory reservation. No order/payment dispatch method exists. */
export class MerchantShippingBuyer {
 private readonly context:Readonly<{merchantId:string;locationId:string}>;
 private readonly adapters:ReadonlyMap<string,ShippingBuyerAdapter>;
 constructor(private readonly db:SqlDatabase,context:{merchantId:string;locationId:string},adapters:ReadonlyMap<string,ShippingBuyerAdapter>){
  if(!/^[A-Za-z0-9_-]{1,192}$/.test(context.merchantId)||!/^[A-Za-z0-9_-]{1,192}$/.test(context.locationId))fail('INVALID_SHIPPING_CONTEXT');this.context=Object.freeze({...context});this.adapters=new Map([...adapters].map(([id,a])=>[id,{tax:a.tax,calculate:a.calculate.bind(a)}]));
 }
 assertContext(expected:{merchantId:string;locationId:string}){if(expected.merchantId!==this.context.merchantId||expected.locationId!==this.context.locationId)fail('SHIPPING_CONTEXT_MISMATCH');}
 private async identity(tx:SqlExecutor,lock=false){const row=(await tx.query<{square_merchant_id:string;square_location_id:string;inventory_owner:string}>("SELECT square_merchant_id,square_location_id,inventory_owner FROM merchant_catalog_identity WHERE singleton=true"+(lock?' FOR SHARE':''))).rows[0];if(!row||row.square_merchant_id!==this.context.merchantId||row.square_location_id!==this.context.locationId||row.inventory_owner!=='website')fail('SHIPPING_CONTEXT_MISMATCH');}
 /** Trusted administrative configuration seam, not bound to buyer request data. */
 async configure(policy:unknown,categories:unknown,taxConfigurationId:string){
  const normalized=parseFixedShippingPolicy(policy);
  if(!categories||typeof categories!=='object'||Array.isArray(categories)||Object.keys(categories).length>1000||Object.entries(categories).some(([id,value])=>id.length>80||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)||typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value))||!this.adapters.has(taxConfigurationId))fail('SHIPPING_UNCONFIGURED');
  const snapshot=JSON.stringify(categories);await this.db.transaction(async tx=>{await this.identity(tx,true);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shipping-settings:${this.context.merchantId}:${this.context.locationId}`]);
  await tx.query('INSERT INTO public.merchant_shipping_buyer_config(merchant_id,location_id,policy,tax_categories,tax_configuration_id) VALUES($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT(merchant_id,location_id) DO UPDATE SET revision=public.merchant_shipping_buyer_config.revision+1,policy=EXCLUDED.policy,tax_categories=EXCLUDED.tax_categories,tax_configuration_id=EXCLUDED.tax_configuration_id',[this.context.merchantId,this.context.locationId,JSON.stringify(normalized),snapshot,taxConfigurationId]);});
 }
 /** Administrator draft settings. A saved draft is never permission to execute payments. */
 async settings(){
  await this.identity(this.db);
  const row=(await this.db.query<Configuration>('SELECT * FROM public.merchant_shipping_buyer_config WHERE merchant_id=$1 AND location_id=$2',[this.context.merchantId,this.context.locationId])).rows[0];
  const variants=(await this.db.query<{id:string;name:string}>('SELECT v.id,p.name FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id ORDER BY v.id')).rows;
  const missing=variants.filter(v=>!row?.tax_categories[v.id]).map(v=>v.id);
  return {revision:row?.revision??0,policy:row?parseFixedShippingPolicy(row.policy):{enabled:false,revision:'0',rates:[]},taxCategories:row?.tax_categories??{},taxConfigurationId:row?.tax_configuration_id??'',availableTaxConfigurations:[...this.adapters.keys()].sort(),variants,readiness:{ratesConfigured:Boolean(row&&parseFixedShippingPolicy(row.policy).rates.length),taxAdapterConfigured:Boolean(row&&this.adapters.has(row.tax_configuration_id)),missingTaxCategories:missing},paymentExecutionEnabled:false,shippingCheckoutEnabled:false};
 }
 async saveSettings(input:unknown){
  if(!exact(input,['revision','enabled','rates','taxCategories','taxConfigurationId'])||!Number.isSafeInteger(input.revision)||(input.revision as number)<0||(input.revision as number)>=2147483647||typeof input.taxConfigurationId!=='string'||(input.taxConfigurationId!==''&&!this.adapters.has(input.taxConfigurationId)))fail('INVALID_SHIPPING_SETTINGS');
  const revision=input.revision as number,policy=parseFixedShippingPolicy({enabled:input.enabled,revision:String(revision+1),rates:input.rates});
  const categories=input.taxCategories;
  if(!categories||typeof categories!=='object'||Array.isArray(categories)||Object.keys(categories).length>1000||Object.entries(categories).some(([id,value])=>id.length>80||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)||typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value)))fail('INVALID_SHIPPING_SETTINGS');
  const policyJson=JSON.stringify(policy),categoriesJson=JSON.stringify(categories),taxId=input.taxConfigurationId;
  await this.db.transaction(async tx=>{
   await this.identity(tx,true);
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shipping-settings:${this.context.merchantId}:${this.context.locationId}`]);
   const prior=(await tx.query<{revision:number}>('SELECT revision FROM public.merchant_shipping_buyer_config WHERE merchant_id=$1 AND location_id=$2 FOR UPDATE',[this.context.merchantId,this.context.locationId])).rows[0];
   if((prior?.revision??0)!==revision)fail('SHIPPING_SETTINGS_CHANGED');
   const known=(await tx.query<{id:string}>('SELECT id FROM catalog_variants')).rows.map(v=>v.id);
   if(Object.keys(JSON.parse(categoriesJson)).some(id=>!known.includes(id)))fail('INVALID_SHIPPING_SETTINGS');
   await tx.query('INSERT INTO public.merchant_shipping_buyer_config(merchant_id,location_id,policy,tax_categories,tax_configuration_id) VALUES($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT(merchant_id,location_id) DO UPDATE SET revision=public.merchant_shipping_buyer_config.revision+1,policy=EXCLUDED.policy,tax_categories=EXCLUDED.tax_categories,tax_configuration_id=EXCLUDED.tax_configuration_id',[this.context.merchantId,this.context.locationId,policyJson,categoriesJson,taxId]);
  });return this.settings();
 }
 private async configuration(tx:SqlExecutor,lock=false){
  await this.identity(tx,lock);
  const row=(await tx.query<Configuration>('SELECT * FROM public.merchant_shipping_buyer_config WHERE merchant_id=$1 AND location_id=$2'+(lock?' FOR UPDATE':''),[this.context.merchantId,this.context.locationId])).rows[0];
  if(!row||!parseFixedShippingPolicy(row.policy).enabled)fail('SHIPPING_UNCONFIGURED');const adapter=this.adapters.get(row.tax_configuration_id);if(!adapter)fail('SHIPPING_UNCONFIGURED');return {row,adapter};
 }
 async options(){const {row}=await this.configuration(this.db);return {configured:true,paymentExecutionEnabled:false,rates:parseFixedShippingPolicy(row.policy).rates};}
 private async basis(tx:SqlExecutor,cart:CartRequest,categories:Record<string,string>):Promise<ShippingMerchandiseBasis>{
  // Reuse only item/catalog/stock arithmetic. Fulfillment evidence is always explicitly SHIPMENT.
  const items=quoteCart(await readMerchantCatalog(tx),cart);
  const lines=items.lines.map(line=>{const category=categories[line.variantId];if(!category)fail('SHIPPING_TAX_CATEGORY_REQUIRED');return {id:line.variantId,quantity:line.quantity,subtotalMinor:line.lineTotalMinor,discountMinor:0,basisMinor:line.lineTotalMinor,taxCategory:category};});
  return {cartFingerprint:hash(JSON.stringify(cart.items.map(({productId,variantId,quantity})=>[productId,variantId,quantity]))),lines,subtotalMinor:items.totalMinor,discountMinor:0,basisMinor:items.totalMinor,currency:'USD'};
 }
 async quote(input:unknown){
  if(!exact(input,['cart','address','rateId'])||!exact(input.cart,['items','currency','fulfillment'])||input.cart.fulfillment!=='shipping')fail('INVALID_SHIPPING_REQUEST');
  if(typeof input.rateId!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(input.rateId))fail('INVALID_SHIPPING_REQUEST');
  const cart=parseCartRequest({...input.cart,fulfillment:'pickup'}),address=parseShippingAddress(input.address),rateId=input.rateId;
  await this.expire();const snapshot=await this.db.transaction(async tx=>{const c=await this.configuration(tx,true);const allowed=await tx.query("UPDATE public.merchant_shipping_buyer_config SET quote_count=CASE WHEN quote_window<now()-interval '1 minute' THEN 1 ELSE quote_count+1 END,quote_window=CASE WHEN quote_window<now()-interval '1 minute' THEN now() ELSE quote_window END WHERE merchant_id=$1 AND location_id=$2 AND (quote_count<10 OR quote_window<now()-interval '1 minute') RETURNING revision",[this.context.merchantId,this.context.locationId]);if(!allowed.rows.length)fail('SHIPPING_RATE_LIMITED');return {...c,basis:await this.basis(tx,cart,c.row.tax_categories)};});
  const quote=await snapshot.adapter.tax.quote(snapshot.basis,snapshot.row.policy,address,rateId);
  if(quote.request.merchantId!==this.context.merchantId||quote.request.locationId!==this.context.locationId)fail('SHIPPING_CONTEXT_MISMATCH');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try {const raw=await Promise.race([snapshot.adapter.calculate(quote,controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ShippingBuyerError('SHIPPING_PRICING_UNAVAILABLE'));},4000);})]);verifyShippingMoney(raw,quote);}finally{clearTimeout(timer);}
  snapshot.adapter.tax.assertUnchanged(quote,quote);const token=randomBytes(32).toString('base64url');
  await this.db.query('INSERT INTO public.merchant_shipping_buyer_quotes(id,merchant_id,location_id,configuration_revision,cart,quote,checkout_token_hash,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)',[quote.id,this.context.merchantId,this.context.locationId,snapshot.row.revision,JSON.stringify(cart),JSON.stringify(quote),hash(token),quote.expiresAt]);
  return {quoteId:quote.id,checkoutToken:token,quote,fulfillment:'shipping' as const,paymentExecutionEnabled:false as const};
 }
 private async authorized(tx:SqlExecutor,id:unknown,token:unknown):Promise<QuoteRow>{
  if(!validAttemptId(id)||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||Buffer.from(token,'base64url').toString('base64url')!==token)fail('SHIPPING_CHECKOUT_NOT_FOUND');
  const row=(await tx.query<QuoteRow>("SELECT * FROM public.merchant_shipping_buyer_quotes WHERE id=$1 AND checkout_token_hash=$2 AND merchant_id=$3 AND location_id=$4",[id.toLowerCase(),hash(token),this.context.merchantId,this.context.locationId])).rows[0];
  if(!row||row.fulfillment_kind!=='shipment'||row.quote.id!==row.id||row.quote.paymentExecutionEnabled!==false||row.quote.request.merchantId!==this.context.merchantId||row.quote.request.locationId!==this.context.locationId)fail('SHIPPING_CHECKOUT_NOT_FOUND');return row;
 }
 private async release(tx:SqlExecutor,id:string,state:'canceled'|'expired'){
  const rows=(await tx.query<{variant_id:string;quantity:number}>("UPDATE public.merchant_shipping_buyer_reservations SET state='released' WHERE attempt_id=$1 AND state='held' RETURNING variant_id,quantity",[id])).rows;
  for(const row of rows.sort((a,b)=>a.variant_id.localeCompare(b.variant_id)))await tx.query('UPDATE merchant_commerce_inventory SET stock_quantity=stock_quantity+$2,revision=revision+1 WHERE variant_id=$1',[row.variant_id,row.quantity]);
  await tx.query("UPDATE public.merchant_shipping_buyer_attempts SET state=$2 WHERE id=$1 AND state='reserved'",[id,state]);
 }
 async expire(){await this.db.transaction(async tx=>{await this.identity(tx,true);const rows=(await tx.query<{id:string}>("SELECT a.id FROM public.merchant_shipping_buyer_attempts a JOIN public.merchant_shipping_buyer_quotes q ON q.id=a.id WHERE q.merchant_id=$1 AND q.location_id=$2 AND a.state='reserved' AND q.expires_at<=now() ORDER BY a.id LIMIT 100 FOR UPDATE OF a SKIP LOCKED",[this.context.merchantId,this.context.locationId])).rows;for(const row of rows)await this.release(tx,row.id,'expired');});}
 async prepare(id:unknown,token:unknown,input:unknown){
  if(!exact(input,['email','phone']))fail('INVALID_SHIPPING_CONTACT');const contact=structuredClone(input) as unknown as ShipmentContact;
  await this.authorized(this.db,id,token);await this.expire();return this.db.transaction(async tx=>{let q=await this.authorized(tx,id,token);const fulfillment=shipmentFulfillmentPreview(q.quote.request.shipping,contact);
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shipping-buyer:${q.id}`]);
   q=await this.authorized(tx,id,token);if(q.canceled)return this.publicState(q);
   const prior=(await tx.query<Attempt>('SELECT * FROM public.merchant_shipping_buyer_attempts WHERE id=$1 FOR UPDATE',[q.id])).rows[0];
   if(prior){if(prior.fulfillment_kind!=='shipment'||!isDeepStrictEqual(prior.fulfillment_snapshot,fulfillment))fail('SHIPPING_ATTEMPT_CHANGED');return this.publicState(q,prior);}
   if(new Date(q.expires_at).getTime()<=Date.now())fail('SHIPPING_QUOTE_EXPIRED');const config=await this.configuration(tx,true);if(config.row.revision!==q.configuration_revision)fail('SHIPPING_CONFIGURATION_CHANGED');
   await tx.query('SELECT variant_id FROM merchant_commerce_inventory WHERE variant_id=ANY($1::text[]) ORDER BY variant_id FOR UPDATE',[q.cart.items.map(i=>i.variantId).sort()]);
   config.adapter.tax.assertCurrentInputs(q.quote,await this.basis(tx,q.cart,config.row.tax_categories),config.row.policy,q.quote.request.shipping.address,q.quote.request.shipping.rateId);
   await tx.query("INSERT INTO public.merchant_shipping_buyer_attempts(id,fulfillment_kind,fulfillment_snapshot,state) VALUES($1,'shipment',$2::jsonb,'reserved')",[q.id,JSON.stringify(fulfillment)]);
   for(const item of q.cart.items){const changed=await tx.query('UPDATE merchant_commerce_inventory SET stock_quantity=stock_quantity-$2,revision=revision+1 WHERE variant_id=$1 AND enabled=true AND stock_quantity>=$2 RETURNING variant_id',[item.variantId,item.quantity]);if(changed.rows.length!==1)fail('SHIPPING_STOCK_CHANGED');await tx.query("INSERT INTO public.merchant_shipping_buyer_reservations(attempt_id,variant_id,quantity,state) VALUES($1,$2,$3,'held')",[q.id,item.variantId,item.quantity]);}
   return this.publicState(q,{id:q.id,state:'reserved',fulfillment_kind:'shipment',fulfillment_snapshot:fulfillment});
  });
 }
 private publicState(q:QuoteRow,a?:Attempt){if(a&&a.fulfillment_kind!=='shipment')fail('SHIPPING_ATTEMPT_CHANGED');return {quoteId:q.id,fulfillment:'shipping' as const,state:a?.state??(q.canceled?'canceled':'quoted'),totalMinor:q.quote.totalMinor,currency:'USD',expiresAt:q.quote.expiresAt,paymentExecutionEnabled:false as const};}
 async status(id:unknown,token:unknown){await this.authorized(this.db,id,token);await this.expire();return this.db.transaction(async tx=>{const q=await this.authorized(tx,id,token),a=(await tx.query<Attempt>('SELECT * FROM public.merchant_shipping_buyer_attempts WHERE id=$1',[q.id])).rows[0];return this.publicState(q,a);});}
 async cancel(id:unknown,token:unknown){return this.db.transaction(async tx=>{await this.identity(tx,true);const q=await this.authorized(tx,id,token);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shipping-buyer:${q.id}`]);const a=(await tx.query<Attempt>('SELECT * FROM public.merchant_shipping_buyer_attempts WHERE id=$1 FOR UPDATE',[q.id])).rows[0];await tx.query('UPDATE public.merchant_shipping_buyer_quotes SET canceled=true WHERE id=$1',[q.id]);if(!a)return this.publicState({...q,canceled:true});if(a.fulfillment_kind!=='shipment')fail('SHIPPING_ATTEMPT_CHANGED');if(a.state==='reserved')await this.release(tx,q.id,'canceled');return this.publicState(q,{...a,state:a.state==='reserved'?'canceled':a.state});});}
 async submit(id:unknown,token:unknown):Promise<never>{await this.authorized(this.db,id,token);return fail('SHIPPING_EXECUTION_DISABLED');}
}
