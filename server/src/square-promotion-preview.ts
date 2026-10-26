import { createHash } from 'node:crypto';
import type { SqlDatabase, SqlExecutor } from '../../db/sql-database';
import { previewConfiguration } from './square-catalog-readonly';
import { squareApiVersion } from './square-sandbox';
import type { SquareServices } from './square-services';

/**
 * Read-only Square Catalog pricing-rule preview for reviewed merchant variations.
 * This does NOT create a Square order, accept a coupon, collect taxes, reserve stock,
 * authorize payment, or alter an existing checked-out amount.
 */
export class SquarePromotionError extends Error {
  constructor(readonly code: 'FEATURE_DISABLED' | 'WRONG_MERCHANT' | 'INVALID_ITEMS' |
    'UNMAPPED_VARIATION' | 'CATALOG_PRICE_MISMATCH' | 'PROVIDER_UNAVAILABLE' |
    'UNVERIFIED_AMOUNT') { super(code); }
}
export interface PromotionItem { readonly variantId: string; readonly quantity: number }
export interface PromotionVariation {
  readonly variantId: string; readonly sku: string; readonly productName: string;
  readonly unitPriceMinor: number; readonly enabled: false; readonly stockQuantity: 0;
  readonly squareVariationSuffix: string;
}
export interface SquarePromotionQuote {
  readonly mode: 'square-sandbox-catalog-rules-preview';
  readonly fingerprint: string;
  readonly itemCount: number;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly currency: 'USD';
  readonly autoApplyDiscounts: true;
  readonly autoApplyTaxes: true;
  readonly inventoryVerified: false;
  readonly checkoutAuthorized: false;
  readonly orderCreated: false;
  readonly paymentDispatched: false;
}
export interface SquarePromotionGiftCoverage {
  readonly fingerprint: string; readonly cardSuffix: string; readonly giftCardMinor: number;
  readonly remainingMinor: number; readonly totalMinor: number; readonly currency: 'USD';
  readonly giftCardRedeemed: false; readonly paymentDispatched: false;
  readonly checkoutAuthorized: false;
}
export interface SquarePromotionService {
  variations(): Promise<readonly PromotionVariation[]>;
  quote(input: unknown): Promise<SquarePromotionQuote>;
  giftCoverage(input: unknown, cardId: unknown): Promise<SquarePromotionGiftCoverage>;
}
type Row = {
  id: string; sku: string; price_minor: number; currency: string;
  enabled: boolean; stock_quantity: number; square_variation_id: string; product_name: string;
};
const MAX_TOTAL = 2_147_483_647;
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v.length <= 100;
const squareId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(v);
function parseItems(input: unknown): PromotionItem[] {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).length !== 1 || !Object.hasOwn(input, 'items'))
    throw new SquarePromotionError('INVALID_ITEMS');
  const values = (input as {items?:unknown}).items;
  if (!Array.isArray(values) || values.length < 1 || values.length > 15)
    throw new SquarePromotionError('INVALID_ITEMS');
  const unique = new Set<string>();
  const lines: PromotionItem[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).length !== 2 || !Object.hasOwn(value,'variantId') ||
        !Object.hasOwn(value,'quantity')) throw new SquarePromotionError('INVALID_ITEMS');
    const v=value as Record<string,unknown>;
    if (!id(v.variantId) || !Number.isSafeInteger(v.quantity) ||
        (v.quantity as number)<1 || (v.quantity as number)>50 ||
        unique.has(v.variantId)) throw new SquarePromotionError('INVALID_ITEMS');
    unique.add(v.variantId);
    lines.push({variantId:v.variantId,quantity:v.quantity as number});
  }
  return lines.sort((a,b)=>a.variantId.localeCompare(b.variantId));
}
function money(value: unknown, optional = false): number | null {
  if (value === undefined && optional) return 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data=value as Record<string, unknown>;
  return data.currency === 'USD' && typeof data.amount === 'number' &&
    Number.isSafeInteger(data.amount) && data.amount>=0 && data.amount<=MAX_TOTAL ? data.amount : null;
}
async function boundedJson(response: Response): Promise<Record<string,unknown>> {
  if (response.status!==200 || Number(response.headers.get('content-length')||0)>192*1024)
    throw new SquarePromotionError('PROVIDER_UNAVAILABLE');
  const reader=response.body?.getReader(); if (!reader) throw new SquarePromotionError('UNVERIFIED_AMOUNT');
  const parts: Uint8Array[] = []; let size=0;
  try {
    for (;;) {
      const next=await reader.read();if (next.done) break;
      size+=next.value.byteLength;
      if (size>192*1024) throw new SquarePromotionError('PROVIDER_UNAVAILABLE');
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  let parsed:unknown;
  try { parsed=JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new SquarePromotionError('UNVERIFIED_AMOUNT'); }
  if (!parsed || typeof parsed!=='object' || Array.isArray(parsed) || 'errors' in parsed)
    throw new SquarePromotionError('UNVERIFIED_AMOUNT');
  return parsed as Record<string,unknown>;
}
function object(value:unknown):Record<string,unknown> {
  return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
export function createSquarePromotionService(db: SqlDatabase, settings: Readonly<Record<string,string|undefined>>,
  fetcher: typeof fetch, cardReader?: Pick<SquareServices,'giftCard'>): SquarePromotionService {
  if (settings.STARTER_DATASET!=='merchant-catalog-v1' ||
      settings.SQUARE_ENVIRONMENT!=='sandbox' ||
      settings.SQUARE_SANDBOX_REQUESTS_ENABLED!=='true' ||
      settings.SQUARE_PROMOTIONS_PREVIEW_ENABLED!=='true' ||
      !squareId(settings.SQUARE_SANDBOX_MERCHANT_ID) ||
      !db || typeof db.transaction!=='function' || typeof fetcher!=='function')
    throw new SquarePromotionError('FEATURE_DISABLED');
  let config: ReturnType<typeof previewConfiguration>;
  try { config=previewConfiguration(settings); }
  catch { throw new SquarePromotionError('FEATURE_DISABLED'); }
  const merchantId=settings.SQUARE_SANDBOX_MERCHANT_ID!;
  async function verifiedRead<T>(load:(tx:SqlExecutor)=>Promise<T>):Promise<T>{
    return db.transaction(async tx=>{
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let marker:{rows:{dataset:string;square_merchant_id:string;square_location_id:string;checkout_enabled:boolean}[]};
      try { marker=await tx.query('SELECT dataset,square_merchant_id,square_location_id,checkout_enabled FROM merchant_catalog_identity WHERE singleton=true'); }
      catch { throw new SquarePromotionError('WRONG_MERCHANT'); }
      const m=marker.rows[0];
      if (marker.rows.length!==1 || m?.dataset!=='merchant-catalog-v1' ||
          m.square_merchant_id!==merchantId || m.square_location_id!==config.locationId ||
          m.checkout_enabled!==false) throw new SquarePromotionError('WRONG_MERCHANT');
      return load(tx);
    });
  }
  async function retrieveRows(variants:readonly string[]):Promise<Row[]>{
    return verifiedRead(async tx=>{
      const filter=variants.length ? ' WHERE v.id IN ('+variants.map((_,i)=>'$'+(i+1)).join(',')+')' : '';
      const rows=await tx.query<Row>('SELECT v.id,v.sku,v.price_minor,v.currency,v.enabled,v.stock_quantity,'+
        ' l.square_variation_id,p.name AS product_name FROM catalog_variants v '+
        ' JOIN merchant_square_variation_links l ON l.variant_id=v.id '+
        ' JOIN catalog_products p ON p.id=v.product_id'+filter+' ORDER BY v.id LIMIT 51', [...variants]);
      return rows.rows;
    });
  }
  let windowStart=0,readCount=0;
  return {
    async variations() {
      const rows=await retrieveRows([]);
      if(rows.length>50) throw new SquarePromotionError('INVALID_ITEMS');
      return rows.map(row=>{
        if(!id(row.id)||!squareId(row.square_variation_id) ||
          !row.sku || !row.product_name || row.currency!=='USD' ||
          !Number.isSafeInteger(row.price_minor) || row.price_minor<0 ||
          row.enabled!==false || row.stock_quantity!==0) throw new SquarePromotionError('UNMAPPED_VARIATION');
        return {variantId:row.id,sku:row.sku,productName:row.product_name,
          unitPriceMinor:row.price_minor,enabled:false as const,stockQuantity:0 as const,
          squareVariationSuffix:row.square_variation_id.slice(-6)};
      });
    },
    async giftCoverage(input, cardId) {
      if(settings.SQUARE_GIFT_CARDS_READ_ENABLED!=='true' || !cardReader)
        throw new SquarePromotionError('FEATURE_DISABLED');
      // Always reprice using Square's fresh Catalog rules. A browser cannot supply a total.
      const quote=await this.quote(input);
      const card=await cardReader.giftCard(cardId);
      if(card.state!=='ACTIVE' || card.currency!=='USD' ||
          !Number.isSafeInteger(card.balanceMinor) || card.balanceMinor===null ||
          card.balanceMinor<0 || card.balanceMinor>MAX_TOTAL)
        throw new SquarePromotionError('UNVERIFIED_AMOUNT');
      const applied=Math.min(card.balanceMinor,quote.totalMinor);
      return {fingerprint:quote.fingerprint,cardSuffix:card.cardSuffix,
        giftCardMinor:applied,remainingMinor:quote.totalMinor-applied,
        totalMinor:quote.totalMinor,currency:'USD',giftCardRedeemed:false,
        paymentDispatched:false,checkoutAuthorized:false};
    },
    async quote(input) {
      const items=parseItems(input);
      const rows=await retrieveRows(items.map(x=>x.variantId));
      if(rows.length!==items.length) throw new SquarePromotionError('UNMAPPED_VARIATION');
      const byId=new Map(rows.map(row=>[row.id,row]));
      let subtotal=0;
      const expected=items.map(item=>{
        const row=byId.get(item.variantId);
        if(!row || !squareId(row.square_variation_id) || row.currency!=='USD' ||
            row.enabled!==false || row.stock_quantity!==0 ||
            !Number.isSafeInteger(row.price_minor) || row.price_minor<0)
          throw new SquarePromotionError('UNMAPPED_VARIATION');
        subtotal+=row.price_minor*item.quantity;
        if(!Number.isSafeInteger(subtotal) || subtotal>MAX_TOTAL)
          throw new SquarePromotionError('INVALID_ITEMS');
        return {id:row.square_variation_id,quantity:item.quantity,unitPriceMinor:row.price_minor};
      });
      if(subtotal<1)throw new SquarePromotionError('INVALID_ITEMS');
      const now=Date.now();
      if(now-windowStart>=60000){windowStart=now;readCount=0;}
      if(++readCount>10)throw new SquarePromotionError('PROVIDER_UNAVAILABLE');
      let response:Response;
      try {
        response=await fetcher('https://connect.squareupsandbox.com/v2/orders/calculate',{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),
          headers:{Authorization:'Bearer '+config.token,'Square-Version':squareApiVersion,
            'Content-Type':'application/json',Accept:'application/json'},
          body:JSON.stringify({order:{location_id:config.locationId,
            line_items:expected.map(item=>({catalog_object_id:item.id,quantity:String(item.quantity)})),
            pricing_options:{auto_apply_discounts:true,auto_apply_taxes:true}}}),
        });
      }catch {throw new SquarePromotionError('PROVIDER_UNAVAILABLE');}
      const data=await boundedJson(response);
      const order=object(data.order);
      if(order.location_id!==config.locationId ||
          !Array.isArray(order.line_items) || order.line_items.length!==expected.length)
        throw new SquarePromotionError('UNVERIFIED_AMOUNT');
      const seen=new Set<string>();
      for(const raw of order.line_items as unknown[]){
        const row=object(raw);
        const match=expected.find(e=>e.id===row.catalog_object_id);
        if(!match || seen.has(match.id) || row.quantity!==String(match.quantity) ||
            money(row.base_price_money)!==match.unitPriceMinor)
          throw new SquarePromotionError('CATALOG_PRICE_MISMATCH');
        seen.add(match.id);
      }
      const total=money(order.total_money);
      const discount=money(order.total_discount_money,true);
      const tax=money(order.total_tax_money,true);
      const serviceCharge=money(order.total_service_charge_money,true);
      const tip=money(order.total_tip_money,true);
      const gross=money(order.gross_sales_money);
      if(total===null||discount===null||tax===null||gross===null ||
          serviceCharge!==0||tip!==0||gross!==subtotal||
          discount>subtotal||total!==subtotal-discount+tax)
        throw new SquarePromotionError('UNVERIFIED_AMOUNT');
      const fingerprint=createHash('sha256').update(JSON.stringify({
        merchantId,locationId:config.locationId,expected,subtotal,discount,tax,total,
      })).digest('hex');
      return {
        mode:'square-sandbox-catalog-rules-preview',fingerprint,
        itemCount:items.reduce((sum,item)=>sum+item.quantity,0),subtotalMinor:subtotal,
        discountMinor:discount,taxMinor:tax,totalMinor:total,currency:'USD' as const,
        autoApplyDiscounts:true as const,autoApplyTaxes:true as const,
        inventoryVerified:false as const,checkoutAuthorized:false as const,
        orderCreated:false as const,paymentDispatched:false as const,
      };
    },
  };
}
