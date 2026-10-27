import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { SqlDatabase, SqlExecutor } from '../../db/sql-database';
import { parseCartRequest, quoteCart, validAttemptId, CheckoutError, type CartRequest } from '../../shared/checkout';
import type { Catalog } from '../../shared/catalog';
import { readCatalog } from './durable-checkout';
import { MerchantProviderError, type MerchantSquareProvider, type MerchantPricing, type MerchantPickup, type MerchantOrder, type MerchantPayment, type MerchantRefund } from './merchant-square-provider';
import type { SandboxEventBridge, NormalizedEvent } from './square-webhooks';
import {validateMerchantReadiness,evaluatePickupAvailability} from './merchant-readiness';

export class CommerceError extends Error {
 constructor(readonly code:string,readonly status=409){super(code);}
}
export interface MerchantReceiptLine {name:string;variation?:string;quantity:number;unitPriceMinor:number;totalMinor:number}
interface QuoteRow {id:string;pricing:MerchantPricing;cart:CartRequest;expires_at:Date|string;line_snapshot:MerchantReceiptLine[];pickup_at:Date|string|null;pickup_time_zone:string|null}
interface AttemptRow {id:string;pickup:MerchantPickup;state:string;order_id:string|null;order_evidence:MerchantOrder|null;payment_id:string|null;payment_evidence:MerchantPayment|null;failure_code:string|null;refunded_minor:number;fulfillment_state:string}
interface RefundRow {id:string;attempt_id:string;amount_minor:number;state:string;refund_id:string|null;evidence:MerchantRefund|null}
const uuid=(value:unknown):string=>{if(!validAttemptId(value))throw new CommerceError('INVALID_IDENTITY',400);return value.toLowerCase();};
function pickupValue(input:unknown):MerchantPickup {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='email,name,phone')throw new CommerceError('INVALID_PICKUP',400);
 const p=input as MerchantPickup;
 if(typeof p.name!=='string'||p.name.trim().length<2||p.name.length>100||/[\x00-\x1f\x7f]/.test(p.name)||typeof p.email!=='string'||p.email.length>254||!/^\S+@\S+\.\S+$/.test(p.email)||typeof p.phone!=='string'||!/^\+[1-9]\d{7,14}$/.test(p.phone))throw new CommerceError('INVALID_PICKUP',400);
 return {name:p.name.trim(),email:p.email.trim(),phone:p.phone};
}
async function locked(tx:SqlExecutor,id:string):Promise<AttemptRow> {
 const row=(await tx.query<AttemptRow>('SELECT * FROM merchant_commerce_attempts WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!row)throw new CommerceError('ATTEMPT_NOT_FOUND',404);return row;
}
async function quoteRow(tx:SqlExecutor,id:string):Promise<QuoteRow> {
 const row=(await tx.query<QuoteRow>('SELECT * FROM merchant_commerce_quotes WHERE id=$1',[id])).rows[0];
 if(!row)throw new CommerceError('QUOTE_NOT_FOUND',404);return row;
}
async function release(tx:SqlExecutor,id:string) {
 const rows=(await tx.query<{variant_id:string;quantity:number}>("UPDATE merchant_commerce_reservations SET state='released' WHERE attempt_id=$1 AND state='held' RETURNING variant_id,quantity",[id])).rows;
 for(const row of rows.sort((a,b)=>a.variant_id.localeCompare(b.variant_id)))await tx.query('UPDATE merchant_commerce_inventory SET stock_quantity=stock_quantity+$2,revision=revision+1 WHERE variant_id=$1',[row.variant_id,row.quantity]);
}
/** Merchant-owned stock overlays disabled imported records; no synthetic table is adopted. */
export async function readMerchantCatalog(tx:SqlExecutor):Promise<Catalog> {
 const catalog=await readCatalog(tx);
 const inventory=(await tx.query<{variant_id:string;stock_quantity:number;enabled:boolean}>('SELECT variant_id,stock_quantity,enabled FROM merchant_commerce_inventory')).rows;
 const enabled=(await tx.query<{enabled:boolean}>('SELECT enabled FROM merchant_commerce_config WHERE singleton=true')).rows[0]?.enabled===true;
 return {...catalog,products:catalog.products.map(p=>({...p,variants:p.variants.map(v=>{
  const stock=inventory.find(i=>i.variant_id===v.id);return {...v,stockQuantity:stock?.stock_quantity??0,enabled:enabled&&stock?.enabled===true};
 })}))};
}
export class MerchantCommerce {
 constructor(private readonly db:SqlDatabase,private readonly provider:MerchantSquareProvider,private readonly context:{merchantId:string;locationId:string;environment?:'sandbox'|'production';applicationId?:string}){}
 async readiness(){const row=(await this.db.query<{operating_settings:unknown}>('SELECT operating_settings FROM merchant_commerce_config WHERE singleton=true')).rows[0];return validateMerchantReadiness(row?.operating_settings);}
 async configure(input:unknown){const report=validateMerchantReadiness(input);if(!report.configuration)throw new CommerceError('INVALID_MERCHANT_SETTINGS',400);await this.db.query('UPDATE merchant_commerce_config SET operating_settings=$1::jsonb,enabled=CASE WHEN $2 THEN enabled ELSE false END WHERE singleton=true',[JSON.stringify(report.configuration),report.ready]);return report;}
 async expireReserved(){await this.db.transaction(async tx=>{const rows=(await tx.query<{id:string}>("SELECT a.id FROM merchant_commerce_attempts a JOIN merchant_commerce_quotes q ON q.id=a.id WHERE a.state='reserved' AND q.expires_at<=now() ORDER BY a.id LIMIT 100 FOR UPDATE OF a SKIP LOCKED")).rows;for(const row of rows){await release(tx,row.id);await tx.query("UPDATE merchant_commerce_attempts SET state='failed',failure_code='QUOTE_EXPIRED',updated_at=now() WHERE id=$1",[row.id]);}});}
 async catalog(){await this.expireReserved();return this.db.transaction(async tx=>{await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return readMerchantCatalog(tx);});}
 async quote(input:unknown) {
  const readiness=await this.readiness();if(this.context.environment==='production'&&!readiness.ready)throw new CommerceError('MERCHANT_NOT_READY');
  const cart=parseCartRequest(input); const catalog=await this.catalog();quoteCart(catalog,cart);
  const links=(await this.db.query<{variant_id:string;square_variation_id:string}>('SELECT variant_id,square_variation_id FROM merchant_square_variation_links WHERE variant_id=ANY($1::text[])',[cart.items.map(i=>i.variantId)])).rows;
  const lines=cart.items.map(item=>{const link=links.find(l=>l.variant_id===item.variantId);if(!link)throw new CommerceError('CATALOG_MAPPING_REQUIRED');return {variantId:item.variantId,squareVariationId:link.square_variation_id,quantity:item.quantity};});
  const permitted=await this.db.query("UPDATE merchant_commerce_config SET quote_count=CASE WHEN quote_window<now()-interval '1 minute' THEN 1 ELSE quote_count+1 END,quote_window=CASE WHEN quote_window<now()-interval '1 minute' THEN now() ELSE quote_window END WHERE singleton=true AND (quote_count<60 OR quote_window<now()-interval '1 minute') RETURNING singleton");
  if(!permitted.rows.length)throw new CommerceError('QUOTE_RATE_LIMITED',429);
  const id=randomUUID(); const pricing=await this.provider.calculate(lines,id);
  if(pricing.locationId!==this.context.locationId)throw new CommerceError('PROVIDER_CONTEXT_MISMATCH');
  const expiresAt=new Date(Date.now()+10*60*1000).toISOString();
  const checkoutToken=randomBytes(32).toString('base64url');
  const availability=readiness.configuration?evaluatePickupAvailability(readiness.configuration.pickup,{now:new Date(new Date(expiresAt).getTime()+60_000)}):undefined;
  if(availability&&!availability.available)throw new CommerceError('PICKUP_UNAVAILABLE');
  const snapshot=cart.items.map((item,index)=>{const product=catalog.products.find(p=>p.id===item.productId)!,variant=product.variants.find(v=>v.id===item.variantId)!,line=pricing.lineEvidence[index]!;return {name:product.name,variation:Object.values(variant.selections).join(' / ')||'Standard',quantity:item.quantity,unitPriceMinor:line.unitPriceMinor,totalMinor:line.totalMinor};});
  await this.db.query('INSERT INTO merchant_commerce_quotes(id,pricing,cart,expires_at,line_snapshot,pickup_at,checkout_token_hash,pickup_time_zone) VALUES($1,$2::jsonb,$3::jsonb,$4,$5::jsonb,$6,$7,$8)',[id,JSON.stringify(pricing),JSON.stringify(cart),expiresAt,JSON.stringify(snapshot),availability?.promisedAt??null,createHash('sha256').update(checkoutToken).digest('hex'),availability?.timeZone??null]);
  return {quoteId:id,checkoutToken,expiresAt,currency:'USD' as const,subtotalMinor:pricing.subtotalMinor,taxMinor:pricing.taxMinor,discountMinor:pricing.discountMinor,totalMinor:pricing.totalMinor,pricing:'square-calculated' as const,...(availability?.promisedAt?{pickupAt:availability.promisedAt,pickupTimeZone:availability.timeZone}:{}),lines:snapshot};
 }
 async authorizeCheckout(value:unknown,token:unknown){
  if(!validAttemptId(value)||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||Buffer.from(token,'base64url').toString('base64url')!==token)throw new CommerceError('CHECKOUT_NOT_FOUND',404);
  const found=await this.db.query('SELECT id FROM merchant_commerce_quotes WHERE id=$1 AND checkout_token_hash=$2',[value.toLowerCase(),createHash('sha256').update(token).digest('hex')]);
  if(found.rows.length!==1)throw new CommerceError('CHECKOUT_NOT_FOUND',404);
 }
 async prepare(quoteId:unknown,pickup:unknown) {
  const id=uuid(quoteId),contact=pickupValue(pickup);await this.expireReserved();
  const lookupToken=randomBytes(32).toString('base64url');
  const created=await this.db.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`merchant-attempt:${id}`]);
   const previous=(await tx.query<AttemptRow>('SELECT * FROM merchant_commerce_attempts WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(previous){if(previous.pickup.name!==contact.name||previous.pickup.email!==contact.email||previous.pickup.phone!==contact.phone)throw new CommerceError('ATTEMPT_CHANGED');return false;}
   const quote=await quoteRow(tx,id);
   if(new Date(quote.expires_at).getTime()<=Date.now())throw new CommerceError('QUOTE_EXPIRED');
   // Quote is one-use: its UUID is both durable order identity and attempt key.
   await tx.query('SELECT variant_id FROM merchant_commerce_inventory WHERE variant_id=ANY($1::text[]) ORDER BY variant_id FOR UPDATE',[quote.cart.items.map(i=>i.variantId).sort()]);
   quoteCart(await readMerchantCatalog(tx),quote.cart);
   if(quote.pickup_at)contact.promisedAt=new Date(quote.pickup_at).toISOString();
   await tx.query("INSERT INTO merchant_commerce_attempts(id,pickup,state,customer_lookup_hash,customer_lookup_expires_at,pickup_at,pickup_time_zone) VALUES($1,$2::jsonb,'reserved',$3,now()+interval '90 days',$4,$5)",[id,JSON.stringify(contact),createHash('sha256').update(lookupToken).digest('hex'),quote.pickup_at,quote.pickup_time_zone]);
   for(const item of quote.cart.items){
    const changed=await tx.query('UPDATE merchant_commerce_inventory SET stock_quantity=stock_quantity-$2,revision=revision+1 WHERE variant_id=$1 AND enabled=true AND stock_quantity>=$2 RETURNING variant_id',[item.variantId,item.quantity]);
    if(changed.rows.length!==1)throw new CommerceError('STOCK_CHANGED');
    await tx.query("INSERT INTO merchant_commerce_reservations(attempt_id,variant_id,quantity,state) VALUES($1,$2,$3,'held')",[id,item.variantId,item.quantity]);
   }
   return true;
  });return {...await this.status(id),...(created?{confirmation:{lookupToken}}:{})};
 }
 async status(value:unknown) {
  const id=uuid(value);await this.expireReserved();return this.db.transaction(async tx=>{
   const a=await locked(tx,id),q=await quoteRow(tx,id);
   const blocked=(await tx.query("SELECT id::text FROM merchant_commerce_refund_requests WHERE attempt_id=$1 AND state<>'failed' UNION ALL SELECT refund_id AS id FROM sandbox_refund_projections WHERE payment_id=$2 AND status IN('PENDING','COMPLETED') UNION ALL SELECT id::text FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1 AND state IN('reserved','sending','review')",[id,a.payment_id])).rows.length>0;
   const pending=(await tx.query("SELECT id::text FROM merchant_commerce_refund_requests r WHERE attempt_id=$1 AND (state IN('reserved','sending','pending','review') OR (state='completed' AND NOT EXISTS(SELECT 1 FROM sandbox_refund_projections p WHERE p.refund_id=r.refund_id AND p.status='COMPLETED'))) UNION ALL SELECT refund_id AS id FROM sandbox_refund_projections WHERE payment_id=$2 AND status='PENDING' UNION ALL SELECT id::text FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1 AND state IN('reserved','sending','review')",[id,a.payment_id])).rows.length>0;
   return {attemptId:id,state:a.state,amountMinor:q.pricing.totalMinor,currency:'USD' as const,orderId:a.order_id,paymentId:a.payment_id,refundedMinor:a.refunded_minor,failureCode:a.failure_code,fulfillmentState:a.fulfillment_state,requiresReconciliation:['order_sending','payment_sending','pending','review'].includes(a.state)||pending,fulfillmentAuthorized:this.context.environment==='production'&&a.state==='completed'&&a.refunded_minor===0&&!blocked,mode:this.context.environment==='production'?'merchant-production' as const:'merchant-sandbox' as const};
  });
 }
 async lookup(token:unknown){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||Buffer.from(token,'base64url').toString('base64url')!==token)throw new CommerceError('ORDER_NOT_FOUND',404);
  const row=(await this.db.query<{id:string;line_snapshot:MerchantReceiptLine[];pickup_at:Date|string|null;pickup_time_zone:string|null;payment_evidence:MerchantPayment|null}>('SELECT a.id,q.line_snapshot,a.pickup_at,a.pickup_time_zone,a.payment_evidence FROM merchant_commerce_attempts a JOIN merchant_commerce_quotes q ON q.id=a.id WHERE a.customer_lookup_hash=$1 AND a.customer_lookup_expires_at>now()',[createHash('sha256').update(token).digest('hex')])).rows[0];
  if(!row)throw new CommerceError('ORDER_NOT_FOUND',404);
  return {...await this.status(row.id),lines:row.line_snapshot,...(row.payment_evidence?.receiptUrl?{receiptUrl:row.payment_evidence.receiptUrl}:{}),...(row.pickup_at?{pickupAt:new Date(row.pickup_at).toISOString(),pickupTimeZone:row.pickup_time_zone??undefined}:{}),merchant:(await this.readiness()).configuration};
 }
 private async claim(id:string,from:string,to:string){return this.db.transaction(async tx=>{const a=await locked(tx,id);if(a.state!==from)return null;await tx.query('UPDATE merchant_commerce_attempts SET state=$2,updated_at=now() WHERE id=$1',[id,to]);return a;});}
 async submit(value:unknown,cardToken:unknown) {
  const id=uuid(value);
  if(typeof cardToken!=='string'||!/^\S{1,512}$/.test(cardToken)||['CASH','EXTERNAL'].includes(cardToken))throw new CommerceError('INVALID_CARD_TOKEN',400);
  let a=await this.db.transaction(tx=>locked(tx,id));
  if(a.state==='reserved'&&await this.claim(id,'reserved','order_sending')){
   const quote=await quoteRow(this.db,id);
   // Do not dispatch expired reservations; cancel before any provider effect.
   if(new Date(quote.expires_at).getTime()<=Date.now()){await this.fail(id,'order_sending',true,'QUOTE_EXPIRED');return this.status(id);}
   try {
    const order=await this.provider.createOrder(quote.pricing,a.pickup);
    await this.db.transaction(async tx=>{const current=await locked(tx,id);if(current.state!=='order_sending')throw new CommerceError('ORDER_STATE_CONFLICT');await tx.query("UPDATE merchant_commerce_attempts SET state='order_ready',order_id=$2,order_evidence=$3::jsonb,updated_at=now() WHERE id=$1",[id,order.id,JSON.stringify(order)]);});
   }catch(e){if(e instanceof MerchantProviderError&&e.code==='PRICE_CHANGED'&&e.changedOrder)await this.db.query("UPDATE merchant_commerce_attempts SET order_id=$2,order_evidence=$3::jsonb WHERE id=$1 AND state='order_sending'",[id,e.changedOrder.id,JSON.stringify(e.changedOrder)]);await this.fail(id,'order_sending',e instanceof MerchantProviderError&&['PROVIDER_REJECTED','PRICE_CHANGED'].includes(e.code),e instanceof MerchantProviderError?e.code:'ORDER_OUTCOME_UNKNOWN');return this.status(id);}
  }
  a=await this.db.transaction(tx=>locked(tx,id));
  if(a.state==='order_ready'){
   const quote=await quoteRow(this.db,id),promise=quote.pickup_at?new Date(quote.pickup_at).getTime():undefined;
   if(new Date(quote.expires_at).getTime()<=Date.now()||(promise!==undefined&&promise<=Date.now())){await this.fail(id,'order_ready',true,'CHECKOUT_EXPIRED_BEFORE_PAYMENT');return this.status(id);}
  }
  if(a.state==='order_ready'&&a.order_evidence&&await this.claim(id,'order_ready','payment_sending')){
   try{
    const payment=await this.provider.pay(a.order_evidence,cardToken);
    await this.db.transaction(async tx=>{
     await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sandbox-payment:${payment.id}`]);
     const current=await locked(tx,id);if(current.state!=='payment_sending')throw new CommerceError('PAYMENT_STATE_CONFLICT');
     await tx.query('UPDATE merchant_commerce_attempts SET state=$2,payment_id=$3,payment_evidence=$4::jsonb,updated_at=now() WHERE id=$1',[id,payment.status==='COMPLETED'?'completed':'pending',payment.id,JSON.stringify(payment)]);
     await tx.query('INSERT INTO sandbox_payment_projections(payment_id,checkout_id,merchant_id,location_id,order_id,amount_minor,currency,payment_status) VALUES($1,$2,$3,$4,$5,$6,\'USD\',$7) ON CONFLICT(payment_id) DO NOTHING',[payment.id,id,this.context.merchantId,this.context.locationId,payment.orderId,payment.amountMinor,payment.status]);
     const projection=(await tx.query<{checkout_id:string}>('SELECT checkout_id FROM sandbox_payment_projections WHERE payment_id=$1',[payment.id])).rows[0];if(projection?.checkout_id!==id)throw new CommerceError('PAYMENT_IDENTITY_CONFLICT');
     if(payment.status==='COMPLETED')await tx.query("UPDATE merchant_commerce_reservations SET state='committed' WHERE attempt_id=$1 AND state='held'",[id]);
    });
   }catch(e){await this.fail(id,'payment_sending',e instanceof MerchantProviderError&&e.code==='DECLINED',e instanceof MerchantProviderError?e.code:'PAYMENT_OUTCOME_UNKNOWN');}
  }return this.status(id);
 }
 private async fail(id:string,expected:string,definite:boolean,code:string){
  await this.db.transaction(async tx=>{const a=await locked(tx,id);if(a.state!==expected)return;if(definite&&!a.payment_id)await release(tx,id);await tx.query('UPDATE merchant_commerce_attempts SET state=$2,failure_code=$3,updated_at=now() WHERE id=$1',[id,definite?'failed':'review',code]);});
 }
 async cancel(value:unknown){const id=uuid(value);await this.fail(id,'reserved',true,'CANCELED_BEFORE_DISPATCH');return this.status(id);}
 async inventory(){return (await this.db.query('SELECT v.id,v.sku,v.price_minor,p.name,COALESCE(i.stock_quantity,0) AS stock_quantity,COALESCE(i.enabled,false) AS enabled,COALESCE(i.revision,0) AS revision FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id LEFT JOIN merchant_commerce_inventory i ON i.variant_id=v.id ORDER BY v.id')).rows;}
 async updateInventory(input:{variantId:string;quantity:number;enabled:boolean;revision:number}){
  if(!input||Object.keys(input).sort().join(',')!=='enabled,quantity,revision,variantId'||typeof input.variantId!=='string'||!Number.isSafeInteger(input.quantity)||input.quantity<0||input.quantity>1000000||typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.revision)||input.revision<0)throw new CommerceError('INVALID_STOCK',400);
  await this.db.transaction(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`merchant-stock:${input.variantId}`]);
   const owner=(await tx.query<{inventory_owner:string}>('SELECT inventory_owner FROM merchant_catalog_identity WHERE singleton=true FOR UPDATE')).rows[0];
   if(owner?.inventory_owner!=='website')throw new CommerceError('WEBSITE_STOCK_OWNERSHIP_REQUIRED');
   const row=(await tx.query<{revision:number}>('SELECT revision FROM merchant_commerce_inventory WHERE variant_id=$1 FOR UPDATE',[input.variantId])).rows[0];
   if((row?.revision??0)!==input.revision)throw new CommerceError('STOCK_CHANGED');
   // Available stock must leave capacity for every outstanding reservation to be released.
   const held=(await tx.query<{total:string}>("SELECT COALESCE(sum(quantity),0)::text AS total FROM merchant_commerce_reservations WHERE variant_id=$1 AND state='held'",[input.variantId])).rows[0]!.total;
   if(input.quantity+Number(held)>1000000)throw new CommerceError('STOCK_EXCEEDS_CAPACITY');
   await tx.query('INSERT INTO merchant_commerce_inventory(variant_id,stock_quantity,enabled) VALUES($1,$2,$3) ON CONFLICT(variant_id) DO UPDATE SET stock_quantity=EXCLUDED.stock_quantity,enabled=EXCLUDED.enabled,revision=merchant_commerce_inventory.revision+1',[input.variantId,input.quantity,input.enabled]);
  });return this.inventory();
 }
 async activate(enabled:boolean){if(typeof enabled!=='boolean')throw new CommerceError('INVALID_ACTIVATION',400);if(enabled&&this.context.environment==='production'&&!(await this.readiness()).ready)throw new CommerceError('MERCHANT_NOT_READY');if(enabled){const owner=(await this.db.query<{inventory_owner:string}>('SELECT inventory_owner FROM merchant_catalog_identity WHERE singleton=true')).rows[0];if(owner?.inventory_owner!=='website')throw new CommerceError('WEBSITE_STOCK_OWNERSHIP_REQUIRED');}await this.db.query('UPDATE merchant_commerce_config SET enabled=$1 WHERE singleton=true',[enabled]);return {enabled,productionPayments:this.context.environment==='production'};}
 async orders(options:{q?:unknown;cursor?:unknown}={}){
  const q=options.q??'';if(typeof q!=='string'||q.length>100||/[\x00-\x1f\x7f]/.test(q))throw new CommerceError('INVALID_SEARCH',400);
  let at:string|null=null,id:string|null=null;
  if(options.cursor!==undefined&&options.cursor!==''){
   try{if(typeof options.cursor!=='string'||options.cursor.length>256||!/^[A-Za-z0-9_-]+$/.test(options.cursor))throw new Error();const value=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'));if(Object.keys(value).sort().join(',')!=='at,id'||!validAttemptId(value.id)||typeof value.at!=='string'||new Date(value.at).toISOString()!==value.at)throw new Error();at=value.at;id=value.id;}catch{throw new CommerceError('INVALID_CURSOR',400);}
  }
  const rows=(await this.db.query<{id:string;created_at:Date|string}>("SELECT a.id,a.state,a.pickup,a.order_id,a.payment_id,a.refunded_minor,a.fulfillment_state,a.created_at,a.pickup_at AS \"pickupAt\",a.pickup_time_zone AS \"pickupTimeZone\",q.pricing,q.line_snapshot AS lines FROM merchant_commerce_attempts a JOIN merchant_commerce_quotes q ON q.id=a.id WHERE ($1='' OR position(lower($1) in lower(concat(a.id::text,' ',a.order_id,' ',a.pickup->>'name',' ',a.pickup->>'email',' ',q.line_snapshot::text)))>0) AND ($2::timestamptz IS NULL OR (a.created_at,a.id)<($2::timestamptz,$3::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT 51",[q.trim(),at,id])).rows;
  const orders=rows.slice(0,50),last=orders.at(-1);
  return {orders,nextCursor:rows.length>50&&last?Buffer.from(JSON.stringify({at:new Date(last.created_at).toISOString(),id:last.id})).toString('base64url'):null};
 }
 private async fulfillmentEligible(tx:SqlExecutor,id:string){
  const a=await locked(tx,id);const liability=(await tx.query("SELECT id::text FROM merchant_commerce_refund_requests WHERE attempt_id=$1 AND state<>'failed' UNION ALL SELECT refund_id AS id FROM sandbox_refund_projections WHERE payment_id=$2 AND status IN('PENDING','COMPLETED')",[id,a.payment_id])).rows.length;
  if(a.state!=='completed'||a.refunded_minor!==0||liability||!a.order_id)throw new CommerceError('FULFILLMENT_NOT_READY');return a;
 }
 private async providerOrder(id:string,orderId:string){const q=await quoteRow(this.db,id),order=await this.provider.readOrder(orderId);if(order.referenceId!==id||order.locationId!==this.context.locationId||order.amountMinor!==q.pricing.totalMinor||order.currency!=='USD')throw new CommerceError('FULFILLMENT_CONTEXT_CONFLICT');return order;}
 async fulfill(value:unknown,state:unknown,staffId='merchant-admin',recover=false){
  const id=uuid(value);if(!['ready','picked_up'].includes(String(state)))throw new CommerceError('INVALID_FULFILLMENT',400);
  const target=state==='ready'?'PREPARED':'COMPLETED';
  const a=await this.db.transaction(tx=>this.fulfillmentEligible(tx,id));
  const pending=(await this.db.query<{id:string;target_state:string;provider_state:'PREPARED'|'COMPLETED';fulfillment_id:string;order_version:number;idempotency_key:string;state:string}>("SELECT * FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1 AND state IN('reserved','sending','review') ORDER BY created_at,id LIMIT 1",[id])).rows[0];
  if(pending&&pending.target_state!==state)throw new CommerceError('FULFILLMENT_RECOVERY_REQUIRED');
  if(pending&&!recover)return this.status(id);
  if(!pending&&a.fulfillment_state===state)return this.status(id);
  if(!pending&&(state==='ready'&&a.fulfillment_state!=='unfulfilled'||state==='picked_up'&&a.fulfillment_state!=='ready'))throw new CommerceError('FULFILLMENT_NOT_READY');
  const observed=await this.providerOrder(id,a.order_id!),fulfillment=observed.fulfillments[0]!;
  if(fulfillment.state===target||(target==='PREPARED'&&fulfillment.state==='COMPLETED')){
   await this.db.transaction(async tx=>{await this.fulfillmentEligible(tx,id);await tx.query("UPDATE merchant_commerce_attempts SET fulfillment_state=CASE WHEN fulfillment_state='picked_up' THEN 'picked_up' ELSE $2 END,updated_at=now() WHERE id=$1",[id,fulfillment.state==='COMPLETED'?'picked_up':'ready']);if(pending)await tx.query("UPDATE merchant_commerce_fulfillment_requests SET state='completed',evidence=$2::jsonb,updated_at=now() WHERE id=$1 AND state IN('reserved','sending','review')",[pending.id,JSON.stringify(observed)]);});return this.status(id);
  }
  if(['CANCELED','FAILED'].includes(fulfillment.state)||observed.state!=='OPEN')throw new CommerceError('FULFILLMENT_STATE_CONFLICT');
  const operation=pending??await this.db.transaction(async tx=>{
   const current=await this.fulfillmentEligible(tx,id);if(current.fulfillment_state===state)return null;if(current.fulfillment_state==='picked_up'||state==='picked_up'&&current.fulfillment_state!=='ready')throw new CommerceError('FULFILLMENT_NOT_READY');
   const existing=(await tx.query<{id:string;target_state:string;provider_state:'PREPARED'|'COMPLETED';fulfillment_id:string;order_version:number;idempotency_key:string;state:string}>("SELECT * FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1 AND state IN('reserved','sending','review') ORDER BY created_at,id LIMIT 1",[id])).rows[0];
   if(existing){if(existing.target_state!==state)throw new CommerceError('FULFILLMENT_RECOVERY_REQUIRED');return existing;}
   const operationId=randomUUID(),key='ful_'+operationId;
   await tx.query("INSERT INTO merchant_commerce_fulfillment_requests(id,attempt_id,target_state,provider_state,fulfillment_id,order_version,idempotency_key,state,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8)",[operationId,id,state,target,fulfillment.id,observed.version,key,staffId]);
   return {id:operationId,target_state:String(state),provider_state:target,fulfillment_id:fulfillment.id,order_version:observed.version,idempotency_key:key,state:'reserved'};
  });
  if(!operation)return this.status(id);const claimToken=randomUUID();
  const claimed=await this.db.query("UPDATE merchant_commerce_fulfillment_requests SET state='sending',claim_token=$3,updated_at=now() WHERE id=$1 AND (state='reserved' OR ($2=true AND (state='review' OR (state='sending' AND updated_at<now()-interval '30 seconds')))) RETURNING id",[operation.id,recover,claimToken]);
  if(!claimed.rows.length)return this.status(id);
  try{
   const result=await this.provider.updatePickupFulfillment(a.order_id!,operation.fulfillment_id,operation.order_version,operation.provider_state,operation.idempotency_key);
   if(result.referenceId!==id||result.locationId!==this.context.locationId||result.amountMinor!==observed.amountMinor)throw new CommerceError('FULFILLMENT_CONTEXT_CONFLICT');
   await this.db.transaction(async tx=>{await this.fulfillmentEligible(tx,id);const saved=await tx.query("UPDATE merchant_commerce_fulfillment_requests SET state='completed',evidence=$2::jsonb,updated_at=now() WHERE id=$1 AND state='sending' AND claim_token=$3 RETURNING id",[operation.id,JSON.stringify(result),claimToken]);if(saved.rows.length)await tx.query("UPDATE merchant_commerce_attempts SET fulfillment_state=CASE WHEN fulfillment_state='picked_up' THEN 'picked_up' ELSE $2 END,updated_at=now() WHERE id=$1",[id,state]);});
  }catch(error){const definite=operation.state==='reserved'&&error instanceof MerchantProviderError&&['ORDER_CHANGED','FULFILLMENT_STATE_CONFLICT'].includes(error.code);await this.db.query("UPDATE merchant_commerce_fulfillment_requests SET state=$2,updated_at=now() WHERE id=$1 AND state='sending' AND claim_token=$3",[operation.id,definite?'failed':'review',claimToken]);if(definite)throw new CommerceError('FULFILLMENT_REFRESH_REQUIRED');}
  return this.status(id);
 }
 async recoverFulfillment(value:unknown,staffId:string){const id=uuid(value),row=(await this.db.query<{target_state:string}>("SELECT target_state FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1 AND state IN('reserved','sending','review') ORDER BY created_at,id LIMIT 1",[id])).rows[0];if(!row)return this.status(id);return this.fulfill(id,row.target_state,staffId,true);}
 async refund(value:unknown,refundIdentity:unknown,amount:unknown,staffId:string,recover=false){
  const id=uuid(value),refundId=uuid(refundIdentity);if(!Number.isSafeInteger(amount)||(amount as number)<1)throw new CommerceError('INVALID_REFUND',400);
  const reserved=await this.db.transaction(async tx=>{
   const a=await locked(tx,id);if((await tx.query("SELECT id FROM merchant_commerce_fulfillment_requests WHERE attempt_id=$1 AND state IN('reserved','sending','review')",[id])).rows.length)throw new CommerceError('FULFILLMENT_RECOVERY_REQUIRED');if(a.state!=='completed'||!a.payment_evidence)throw new CommerceError('PAYMENT_NOT_COMPLETED');
   const previous=(await tx.query<RefundRow>('SELECT * FROM merchant_commerce_refund_requests WHERE id=$1 FOR UPDATE',[refundId])).rows[0];
   if(previous){if(previous.attempt_id!==id||previous.amount_minor!==amount)throw new CommerceError('REFUND_IDENTITY_CONFLICT');return {row:previous,payment:a.payment_evidence};}
   // Count settled external refunds plus outstanding dispatch liabilities exactly once.
   const liability=(await tx.query<{total:number}>("SELECT COALESCE(sum(amount_minor),0)::integer AS total FROM (SELECT amount_minor FROM merchant_commerce_refund_requests r WHERE attempt_id=$1 AND state<>'failed' AND (refund_id IS NULL OR NOT EXISTS(SELECT 1 FROM sandbox_refund_projections p WHERE p.refund_id=r.refund_id AND p.status IN('PENDING','COMPLETED'))) UNION ALL SELECT amount_minor FROM sandbox_refund_projections WHERE payment_id=$2 AND status='PENDING') liabilities",[id,a.payment_id])).rows[0]!.total;
   if(a.refunded_minor+liability+(amount as number)>a.payment_evidence.amountMinor)throw new CommerceError('REFUND_EXCEEDS_BALANCE');
   const row=(await tx.query<RefundRow>("INSERT INTO merchant_commerce_refund_requests(id,attempt_id,amount_minor,state,requested_by) VALUES($1,$2,$3,'reserved',$4) RETURNING *",[refundId,id,amount,staffId])).rows[0]!;
   return {row,payment:a.payment_evidence};
  });
  const claimed=await this.db.query("UPDATE merchant_commerce_refund_requests SET state='sending',updated_at=now() WHERE id=$1 AND (state='reserved' OR ($2=true AND (state IN('review','pending') OR (state='sending' AND updated_at<now()-interval '30 seconds')))) RETURNING id",[refundId,recover]);
  if(claimed.rows.length){try{
   const evidence=await this.provider.refund(reserved.payment,refundId,amount as number);
   await this.db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sandbox-payment:${reserved.payment.id}`]);
    await locked(tx,id);
    const projection=(await tx.query<{payment_id:string;amount_minor:number;currency:string;status:string}>('SELECT payment_id,amount_minor,currency,status FROM sandbox_refund_projections WHERE refund_id=$1',[evidence.id])).rows[0];
    if(projection&&(projection.payment_id!==reserved.payment.id||projection.amount_minor!==amount||projection.currency!=='USD'))throw new CommerceError('REFUND_CONTEXT_CONFLICT');
    const status=projection&&['COMPLETED','FAILED','REJECTED'].includes(projection.status)?projection.status:evidence.status;
    await tx.query('UPDATE merchant_commerce_refund_requests SET state=$2,refund_id=$3,evidence=$4::jsonb,updated_at=now() WHERE id=$1 AND state=\'sending\'',[refundId,status==='COMPLETED'?'completed':['FAILED','REJECTED'].includes(status)?'failed':'pending',evidence.id,JSON.stringify(evidence)]);
   });
   // Completion remains a financial liability until a signed provider event reconciles it.
  }catch(e){await this.db.query('UPDATE merchant_commerce_refund_requests SET state=$2,updated_at=now() WHERE id=$1 AND state=\'sending\'',[refundId,reserved.row.state==='reserved'&&e instanceof MerchantProviderError&&e.code==='PROVIDER_REJECTED'?'failed':'review']);}}
  return (await this.db.query<RefundRow>('SELECT id,attempt_id,amount_minor,state,refund_id FROM merchant_commerce_refund_requests WHERE id=$1',[refundId])).rows[0];
 }

 async refundHistory(value:unknown){return (await this.db.query('SELECT id,attempt_id,amount_minor,state,refund_id,created_at FROM merchant_commerce_refund_requests WHERE attempt_id=$1 ORDER BY created_at',[uuid(value)])).rows;}
 async recoverRefund(value:unknown,staffId:string){const refundId=uuid(value);const row=(await this.db.query<RefundRow>('SELECT * FROM merchant_commerce_refund_requests WHERE id=$1',[refundId])).rows[0];if(!row)throw new CommerceError('REFUND_NOT_FOUND',404);return this.refund(row.attempt_id,refundId,row.amount_minor,staffId,true);}
 /** Explicit admin recovery only. Orders/refunds replay identical durable idempotency keys;
  * card payment recovery is READ ONLY and never re-tokenizes or resends a charge. */
 async recover(value:unknown){
  const id=uuid(value);
  let a=await this.db.transaction(tx=>locked(tx,id));
  if(!a.order_id&&['order_sending','review'].includes(a.state)){
   const claimed=await this.db.query("UPDATE merchant_commerce_attempts SET state='order_sending',updated_at=now() WHERE id=$1 AND order_id IS NULL AND (state='review' OR (state='order_sending' AND updated_at<now()-interval '30 seconds')) RETURNING id",[id]);
   if(claimed.rows.length){try{
    const q=await quoteRow(this.db,id),order=await this.provider.createOrder(q.pricing,a.pickup);
    await this.db.transaction(async tx=>{const current=await locked(tx,id);if(current.state!=='order_sending')throw new CommerceError('ORDER_STATE_CONFLICT');await tx.query("UPDATE merchant_commerce_attempts SET state='order_ready',order_id=$2,order_evidence=$3::jsonb,failure_code=NULL,updated_at=now() WHERE id=$1",[id,order.id,JSON.stringify(order)]);});
   }catch(e){if(e instanceof MerchantProviderError&&e.code==='PRICE_CHANGED'&&e.changedOrder)await this.db.query("UPDATE merchant_commerce_attempts SET order_id=$2,order_evidence=$3::jsonb WHERE id=$1 AND state='order_sending'",[id,e.changedOrder.id,JSON.stringify(e.changedOrder)]);await this.fail(id,'order_sending',e instanceof MerchantProviderError&&['PROVIDER_REJECTED','PRICE_CHANGED'].includes(e.code),e instanceof MerchantProviderError?e.code:'ORDER_OUTCOME_UNKNOWN');}}
  }
  a=await this.db.transaction(tx=>locked(tx,id));
  if(a.order_evidence&&['payment_sending','pending','review'].includes(a.state)){
   const since=(await this.db.query<{created_at:Date|string}>('SELECT created_at FROM merchant_commerce_attempts WHERE id=$1',[id])).rows[0]!.created_at;
   const payment=await this.provider.findPayment(a.order_evidence,new Date(new Date(since).getTime()-60000).toISOString());
   if(payment)await this.db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sandbox-payment:${payment.id}`]);const current=await locked(tx,id);
    if(!['payment_sending','pending','review','completed'].includes(current.state)||current.payment_id&&current.payment_id!==payment.id)throw new CommerceError('PAYMENT_CONTEXT_CONFLICT');
    if(current.state==='completed')return;
    await tx.query('INSERT INTO sandbox_payment_projections(payment_id,checkout_id,merchant_id,location_id,order_id,amount_minor,currency,payment_status) VALUES($1,$2,$3,$4,$5,$6,\'USD\',$7) ON CONFLICT(payment_id) DO NOTHING',[payment.id,id,this.context.merchantId,this.context.locationId,payment.orderId,payment.amountMinor,payment.status]);
    const projected=(await tx.query<{checkout_id:string;payment_status:string}>('SELECT checkout_id,payment_status FROM sandbox_payment_projections WHERE payment_id=$1',[payment.id])).rows[0];if(projected?.checkout_id!==id||['CANCELED','FAILED'].includes(projected.payment_status))throw new CommerceError('PAYMENT_CONTEXT_CONFLICT');
    await tx.query("UPDATE sandbox_payment_projections SET payment_status=$2 WHERE payment_id=$1 AND payment_status NOT IN('COMPLETED','CANCELED','FAILED') AND NOT(payment_status='APPROVED' AND $2='PENDING')",[payment.id,payment.status]);
    await tx.query('UPDATE merchant_commerce_attempts SET state=$2,payment_id=$3,payment_evidence=$4::jsonb,failure_code=NULL,updated_at=now() WHERE id=$1',[id,payment.status==='COMPLETED'?'completed':'pending',payment.id,JSON.stringify(payment)]);
    if(payment.status==='COMPLETED')await tx.query("UPDATE merchant_commerce_reservations SET state='committed' WHERE attempt_id=$1 AND state='held'",[id]);
   });
  }
  return this.status(id);
 }

}
/** Reuse verified signature/event ordering/deduplication and projection primitives. */
export function merchantCommerceBridge(context:{merchantId:string;locationId:string;environment?:'sandbox'|'production';applicationId?:string}):SandboxEventBridge {
 return {
  async before(tx,event){
   if(event.merchantId!==context.merchantId||event.locationId!==context.locationId)throw new CommerceError('WEBHOOK_CONTEXT_MISMATCH');
   if(event.kind!=='payment'||!event.referenceId)return;
   const a=(await tx.query<AttemptRow>('SELECT * FROM merchant_commerce_attempts WHERE id=$1 FOR UPDATE',[event.referenceId])).rows[0];if(!a)return;
   const q=await quoteRow(tx,a.id);
   if(!a.order_id||event.orderId!==a.order_id||q.pricing.totalMinor!==event.amountMinor||a.payment_id&&a.payment_id!==event.paymentId)throw new CommerceError('WEBHOOK_PAYMENT_MISMATCH');
   if(!['payment_sending','review','pending','completed'].includes(a.state))throw new CommerceError('WEBHOOK_DISPATCH_REQUIRED');
   await tx.query('INSERT INTO sandbox_payment_projections(payment_id,checkout_id,merchant_id,location_id,order_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6,\'USD\') ON CONFLICT(payment_id) DO NOTHING',[event.paymentId,a.id,context.merchantId,context.locationId,a.order_id,event.amountMinor]);
  },
  async after(tx,event:NormalizedEvent){
   const a=(await tx.query<AttemptRow>('SELECT a.* FROM merchant_commerce_attempts a JOIN sandbox_payment_projections p ON p.checkout_id=a.id WHERE p.payment_id=$1 FOR UPDATE OF a',[event.paymentId])).rows[0];if(!a)return;
   if(event.kind==='payment'){
    if(event.status==='COMPLETED'||event.status==='PENDING'||event.status==='APPROVED'){
     const evidence:MerchantPayment={...(a.payment_evidence?.receiptUrl?{receiptUrl:a.payment_evidence.receiptUrl}:{}),...(context.environment==='production'?{environment:'production' as const,merchantId:context.merchantId,applicationId:context.applicationId}:{}),id:event.paymentId,orderId:a.order_id!,checkoutId:a.id,locationId:context.locationId,amountMinor:event.amountMinor,currency:'USD',status:event.status,fulfillmentAuthorized:false};
     await tx.query('UPDATE merchant_commerce_attempts SET payment_id=$2,payment_evidence=$3::jsonb,state=$4,failure_code=NULL,updated_at=now() WHERE id=$1',[a.id,event.paymentId,JSON.stringify(evidence),event.status==='COMPLETED'?'completed':'pending']);
     if(event.status==='COMPLETED')await tx.query("UPDATE merchant_commerce_reservations SET state='committed' WHERE attempt_id=$1 AND state='held'",[a.id]);
    }else {await release(tx,a.id);await tx.query("UPDATE merchant_commerce_attempts SET state='failed',failure_code='PROVIDER_PAYMENT_FAILED',updated_at=now() WHERE id=$1",[a.id]);}
   }else{
    await tx.query("UPDATE merchant_commerce_attempts SET refunded_minor=(SELECT COALESCE(sum(amount_minor),0)::integer FROM sandbox_refund_projections WHERE payment_id=$2 AND status='COMPLETED'),updated_at=now() WHERE id=$1",[a.id,event.paymentId]);
    await tx.query('UPDATE merchant_commerce_refund_requests SET state=$2,updated_at=now() WHERE refund_id=$1',[event.resourceId,event.status==='COMPLETED'?'completed':['FAILED','REJECTED'].includes(event.status)?'failed':'pending']);
   }
  },
 };
}
