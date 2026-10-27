import {isDeepStrictEqual} from 'node:util';
import type {SqlDatabase} from '../../db/sql-database';
import type {ShippingDraft} from '../../shared/merchant-shipping';
import {shippingDraftFingerprint,ShippingError} from './merchant-shipping';
/** Development-only immutable store. No router, initialization hook, purchase or checkout capability. */
export class ShippingDraftStore {
 constructor(private readonly db:SqlDatabase,private readonly context:{merchantId:string;locationId:string}) {
  if(!/^[A-Za-z0-9_-]{1,192}$/.test(context.merchantId)||!/^[A-Za-z0-9_-]{1,192}$/.test(context.locationId))throw new ShippingError('SHIPPING_CHANGED');
  this.context=Object.freeze({...context});
 }
 async save(input:{id:string;cartFingerprint:string;draft:ShippingDraft;expiresAt:string}) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.id)||!/^[a-f0-9]{64}$/.test(input.cartFingerprint)||!Number.isFinite(Date.parse(input.expiresAt)))throw new ShippingError('SHIPPING_CHANGED');
  const id=input.id,cartFingerprint=input.cartFingerprint;
  const expiresAt=new Date(input.expiresAt).toISOString(),fingerprint=shippingDraftFingerprint(input.draft),snapshot=JSON.stringify(input.draft);
  if(new Date(expiresAt).getTime()<=Date.now()||new Date(expiresAt).getTime()>Date.now()+10*60*1000)throw new ShippingError('SHIPPING_CHANGED');
  return this.db.transaction(async tx=>{
   await tx.query('INSERT INTO merchant_shipping_drafts(id,merchant_id,location_id,cart_fingerprint,draft_fingerprint,draft,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(id) DO NOTHING',[id,this.context.merchantId,this.context.locationId,cartFingerprint,fingerprint,snapshot,expiresAt]);
   const row=(await tx.query<{draft:ShippingDraft;draft_fingerprint:string;cart_fingerprint:string;expires_at:Date|string}>('SELECT draft,draft_fingerprint,cart_fingerprint,expires_at FROM merchant_shipping_drafts WHERE id=$1 AND merchant_id=$2 AND location_id=$3',[id,this.context.merchantId,this.context.locationId])).rows[0];
   if(!row||row.draft_fingerprint!==fingerprint||row.cart_fingerprint!==cartFingerprint||new Date(row.expires_at).toISOString()!==expiresAt||!isDeepStrictEqual(row.draft,JSON.parse(snapshot)))throw new ShippingError('SHIPPING_CHANGED');
   return {id:id,fingerprint,expiresAt,checkoutEnabled:false as const};
  });
 }
 async read(id:string) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))return null;
  const row=(await this.db.query<{draft:ShippingDraft;draft_fingerprint:string;cart_fingerprint:string;expires_at:Date|string}>('SELECT draft,draft_fingerprint,cart_fingerprint,expires_at FROM merchant_shipping_drafts WHERE id=$1 AND merchant_id=$2 AND location_id=$3 AND expires_at>now()',[id,this.context.merchantId,this.context.locationId])).rows[0];
  if(!row)return null;
  if(shippingDraftFingerprint(row.draft)!==row.draft_fingerprint)throw new ShippingError('SHIPPING_CHANGED');
  return {draft:row.draft,cartFingerprint:row.cart_fingerprint,expiresAt:new Date(row.expires_at).toISOString(),checkoutEnabled:false as const};
 }
}
