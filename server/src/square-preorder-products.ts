import { SquarePreorderError } from './square-preorders';

/** Product-specific seasonal preorder rules. Merchant-configured; preview only.
 * No stock, slots, orders, notifications or payments are reserved or dispatched.
 */
export interface SquareProductRelease {
  readonly productId:string;
  readonly orderOpensAt:string;
  readonly orderClosesAt:string;
  readonly pickupStartsAt:string;
  readonly pickupEndsAt:string;
  readonly maxQuantity:number;
}
export interface SquarePreorderEligibility {
  readonly productId:string;
  readonly quantity:number;
  readonly pickupAt:string;
  readonly eligibleForPreorderPreview:boolean;
  readonly reason:'NOT_RELEASED'|'ORDER_CUTOFF'|'OUTSIDE_PICKUP_WINDOW'|'OVER_QUANTITY_LIMIT'|null;
  readonly capacityReservationRequired:true;
  readonly inventoryReserved:false;
  readonly orderCreated:false;
  readonly checkoutAuthorized:false;
}
function isObject(v:unknown):v is Record<string,unknown> {
  return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
}
function instant(v:unknown):number|null {
  if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v))return null;
  const ms=Date.parse(v);
  if(!Number.isFinite(ms)||new Date(ms).toISOString()!==v.replace('Z','.000Z'))return null;
  return ms;
}
const productId=(v:unknown):v is string=>typeof v==='string'&&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v)&&v.length<=100;
/** Reject unknown fields, overlapping invalid windows and duplicated product IDs. */
export function parseSquareProductReleases(input:unknown):readonly SquareProductRelease[] {
  if(!Array.isArray(input)||input.length>50)throw new SquarePreorderError('INVALID_WINDOW');
  const ids=new Set<string>();
  return input.map(v=>{
    if(!isObject(v)||Object.keys(v).length!==6||
        !['productId','orderOpensAt','orderClosesAt','pickupStartsAt','pickupEndsAt','maxQuantity']
          .every(key=>Object.hasOwn(v,key))||
        !productId(v.productId)||ids.has(v.productId)||
        !Number.isSafeInteger(v.maxQuantity)||(v.maxQuantity as number)<1||(v.maxQuantity as number)>100)
      throw new SquarePreorderError('INVALID_WINDOW');
    const start=instant(v.orderOpensAt),close=instant(v.orderClosesAt);
    const pickupFrom=instant(v.pickupStartsAt),pickupTo=instant(v.pickupEndsAt);
    if(start===null||close===null||pickupFrom===null||pickupTo===null||
        start>=close||pickupFrom>=pickupTo||pickupTo<=start||
        (close-start)>90*86400000||(pickupTo-pickupFrom)>90*86400000)
      throw new SquarePreorderError('INVALID_WINDOW');
    ids.add(v.productId);
    return v as unknown as SquareProductRelease;
  });
}
export function productReleasesFromSettings(settings:Readonly<Record<string,string|undefined>>):readonly SquareProductRelease[] {
  if(settings.SQUARE_PREORDERS_PREVIEW_ENABLED!=='true')return [];
  const raw=settings.SQUARE_PREORDER_RELEASES_JSON;
  if(!raw)return [];
  if(raw.length>8000)throw new SquarePreorderError('INVALID_WINDOW');
  let data:unknown;
  try{data=JSON.parse(raw);}
  catch{throw new SquarePreorderError('INVALID_WINDOW');}
  return parseSquareProductReleases(data);
}
export function previewProductPreorder(release:SquareProductRelease,input:unknown,now=Date.now()):SquarePreorderEligibility {
  if(!isObject(input)||Object.keys(input).length!==3||
      !['productId','quantity','pickupAt'].every(key=>Object.hasOwn(input,key))||
      input.productId!==release.productId||
      !Number.isSafeInteger(input.quantity)||(input.quantity as number)<1||(input.quantity as number)>100||
      instant(input.pickupAt)===null||!Number.isSafeInteger(now))
    throw new SquarePreorderError('INVALID_WINDOW');
  const pickup=instant(input.pickupAt)!;
  const saleStart=instant(release.orderOpensAt)!;
  const saleEnd=instant(release.orderClosesAt)!;
  const pickupStart=instant(release.pickupStartsAt)!;
  const pickupEnd=instant(release.pickupEndsAt)!;
  const reason:SquarePreorderEligibility['reason']=
    now<saleStart?'NOT_RELEASED':
    now>=saleEnd?'ORDER_CUTOFF':
    pickup<pickupStart||pickup>pickupEnd?'OUTSIDE_PICKUP_WINDOW':
    (input.quantity as number)>release.maxQuantity?'OVER_QUANTITY_LIMIT':null;
  return {
    productId:release.productId,quantity:input.quantity as number,pickupAt:input.pickupAt as string,
    eligibleForPreorderPreview:reason===null,reason,
    capacityReservationRequired:true,inventoryReserved:false,
    orderCreated:false,checkoutAuthorized:false,
  };
}
