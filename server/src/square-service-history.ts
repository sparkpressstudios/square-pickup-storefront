import { squareApiVersion } from './square-sandbox';
import { previewConfiguration } from './square-catalog-readonly';

/** Merchant-admin-only Square history. Every operation is read-only at Square,
 * despite search endpoints using POST. Never returns GAN, PIN or customer details.
 */
export class SquareHistoryError extends Error {
  constructor(readonly code: 'FEATURE_DISABLED'|'INVALID_INPUT'|'PROVIDER_UNAVAILABLE'|
    'PERMISSION_DENIED'|'UNVERIFIED_RESPONSE'|'RATE_LIMITED') { super(code); }
}
export interface GiftActivityHistory {
  readonly cardSuffix:string;
  readonly activities:readonly {
    readonly type:string;readonly createdAt:string;
    readonly balanceAfterMinor:number|null;
  }[];
  readonly moreAvailable:boolean;
  readonly giftCardBalanceModified:false;
}
export interface LoyaltyRewardHistory {
  readonly accountSuffix:string;
  readonly rewards:readonly {readonly status:string;readonly points:number;readonly updatedAt:string}[];
  readonly moreAvailable:boolean;
  readonly pointsModified:false;
}
export interface LoyaltyEventHistory {
  readonly accountSuffix:string;
  readonly events:readonly {readonly type:string;readonly createdAt:string;readonly pointsDelta:number|null}[];
  readonly moreAvailable:boolean;
  readonly pointsModified:false;
}
export interface SquareHistoryReader {
  giftCardActivities(cardId:unknown):Promise<GiftActivityHistory>;
  loyaltyRewards(accountId:unknown):Promise<LoyaltyRewardHistory>;
  loyaltyEvents(accountId:unknown):Promise<LoyaltyEventHistory>;
}
type Dict=Record<string,unknown>;
function obj(value:unknown):Dict {
  return !!value && typeof value==='object' && !Array.isArray(value)?value as Dict:{};
}
function cleanId(value:unknown,max:number):value is string {
  return typeof value==='string' && value.length>=4 && value.length<=max &&
    /^[A-Za-z0-9_-]+$/.test(value);
}
function giftId(value:unknown):value is string {
  return typeof value==='string' && /^gftc:[A-Za-z0-9_-]{4,120}$/.test(value);
}
function safeTimestamp(value:unknown):value is string {
  return typeof value==='string' && value.length<=40 &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value));
}
function state(value:unknown):value is string {
  return typeof value==='string' && /^[A-Z][A-Z_]{0,39}$/.test(value);
}
function nonnegativeMoney(value:unknown):number|null {
  if(value===undefined)return null;
  const money=obj(value);
  if(money.currency!=='USD' || typeof money.amount!=='number' ||
      !Number.isSafeInteger(money.amount) || money.amount<0 || money.amount>2147483647)
    throw new SquareHistoryError('UNVERIFIED_RESPONSE');
  return money.amount;
}
function validPoints(value:unknown):value is number {
  return typeof value==='number' && Number.isSafeInteger(value) &&
    value>=-2147483648 && value<=2147483647;
}
const base='https://connect.squareupsandbox.com';
const maxBytes=96*1024;
function available(values:Readonly<Record<string,string|undefined>>) {
  if(values.STARTER_DATASET!=='merchant-catalog-v1' ||
      values.SQUARE_ENVIRONMENT!=='sandbox' || values.SQUARE_SANDBOX_REQUESTS_ENABLED!=='true')
    throw new SquareHistoryError('FEATURE_DISABLED');
  try{previewConfiguration(values);}
  catch{throw new SquareHistoryError('FEATURE_DISABLED');}
  return {gift:values.SQUARE_GIFT_CARDS_READ_ENABLED==='true',
    loyalty:values.SQUARE_LOYALTY_READ_ENABLED==='true'};
}
export function createSquareHistoryReader(values:Readonly<Record<string,string|undefined>>,
  fetcher:typeof fetch):SquareHistoryReader {
  const flags=available(values);
  if(typeof fetcher!=='function')throw new SquareHistoryError('FEATURE_DISABLED');
  const token=values.SQUARE_SANDBOX_ACCESS_TOKEN!;
  const location=values.SQUARE_LOCATION_ID!;
  let begin=0,count=0;
  async function request(path:string,body?:unknown):Promise<Dict> {
    const url=new URL(path,base);
    if(url.origin!==base || ![
      '/v2/gift-cards/activities','/v2/loyalty/rewards/search','/v2/loyalty/events/search',
    ].includes(url.pathname))throw new SquareHistoryError('INVALID_INPUT');
    const time=Date.now();
    if(time-begin>=60000){begin=time;count=0;}
    if(++count>12)throw new SquareHistoryError('RATE_LIMITED');
    let response:Response;
    try {
      response=await fetcher(url.toString(),{
        method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{Authorization:'Bearer '+token,'Square-Version':squareApiVersion,
          'Content-Type':'application/json',Accept:'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
    }catch{throw new SquareHistoryError('PROVIDER_UNAVAILABLE');}
    if(response.status===401 || response.status===403)throw new SquareHistoryError('PERMISSION_DENIED');
    if(response.status===429)throw new SquareHistoryError('RATE_LIMITED');
    if(response.status!==200 || Number(response.headers.get('content-length')??0)>maxBytes)
      throw new SquareHistoryError('PROVIDER_UNAVAILABLE');
    const reader=response.body?.getReader();
    if(!reader)throw new SquareHistoryError('UNVERIFIED_RESPONSE');
    const chunks:Uint8Array[]=[];let size=0;
    try {
      for(;;){
        const part=await reader.read();if(part.done)break;
        size+=part.value.byteLength;
        if(size>maxBytes)throw new SquareHistoryError('PROVIDER_UNAVAILABLE');
        chunks.push(part.value);
      }
    }finally{await reader.cancel().catch(()=>{});}
    let data:unknown;
    try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
    catch{throw new SquareHistoryError('UNVERIFIED_RESPONSE');}
    if(!data || typeof data!=='object' || Array.isArray(data) || 'errors' in data)
      throw new SquareHistoryError('UNVERIFIED_RESPONSE');
    return data as Dict;
  }
  function boundedRows(reply:Dict,key:string):Dict[] {
    const candidate=reply[key];
    if(candidate===undefined)return [];
    if(!Array.isArray(candidate) || candidate.length>20 ||
        candidate.some(value=>!value || typeof value!=='object' || Array.isArray(value)))
      throw new SquareHistoryError('UNVERIFIED_RESPONSE');
    return candidate as Dict[];
  }
  function more(reply:Dict):boolean {
    if(reply.cursor===undefined || reply.cursor===null || reply.cursor==='')return false;
    if(typeof reply.cursor!=='string' || reply.cursor.length>256)
      throw new SquareHistoryError('UNVERIFIED_RESPONSE');
    return true;
  }
  return {
    async giftCardActivities(cardId) {
      if(!flags.gift)throw new SquareHistoryError('FEATURE_DISABLED');
      if(!giftId(cardId))throw new SquareHistoryError('INVALID_INPUT');
      const url=new URL('/v2/gift-cards/activities',base);
      url.searchParams.set('gift_card_id',cardId);
      url.searchParams.set('location_id',location);
      url.searchParams.set('limit','20');
      url.searchParams.set('sort_order','DESC');
      const response=await request(url.pathname+url.search);
      const activities=boundedRows(response,'gift_card_activities').map(activity=>{
        if(activity.gift_card_id!==cardId || activity.location_id!==location ||
            !state(activity.type) || !safeTimestamp(activity.created_at))
          throw new SquareHistoryError('UNVERIFIED_RESPONSE');
        return {
          type:activity.type as string,createdAt:activity.created_at as string,
          balanceAfterMinor:nonnegativeMoney(activity.gift_card_balance_money),
        };
      });
      return {cardSuffix:cardId.slice(-4),activities,moreAvailable:more(response),
        giftCardBalanceModified:false as const};
    },
    async loyaltyRewards(accountId) {
      if(!flags.loyalty)throw new SquareHistoryError('FEATURE_DISABLED');
      if(!cleanId(accountId,64))throw new SquareHistoryError('INVALID_INPUT');
      const response=await request('/v2/loyalty/rewards/search',{
        query:{loyalty_account_id:accountId},limit:15,
      });
      const rewards=boundedRows(response,'rewards').map(reward=>{
        if(reward.loyalty_account_id!==accountId || !state(reward.status) ||
            !validPoints(reward.points) || reward.points<0 ||
            !safeTimestamp(reward.updated_at))
          throw new SquareHistoryError('UNVERIFIED_RESPONSE');
        return {status:reward.status as string,points:reward.points as number,
          updatedAt:reward.updated_at as string};
      });
      return {accountSuffix:accountId.slice(-4),rewards,moreAvailable:more(response),
        pointsModified:false as const};
    },
    async loyaltyEvents(accountId) {
      if(!flags.loyalty)throw new SquareHistoryError('FEATURE_DISABLED');
      if(!cleanId(accountId,64))throw new SquareHistoryError('INVALID_INPUT');
      const response=await request('/v2/loyalty/events/search',{
        query:{filter:{loyalty_account_filter:{loyalty_account_id:accountId}}},limit:15,
      });
      const events=boundedRows(response,'events').map(event=>{
        if(event.loyalty_account_id!==accountId || !state(event.type) ||
            !safeTimestamp(event.created_at))
          throw new SquareHistoryError('UNVERIFIED_RESPONSE');
        const details=obj(event.accumulate_points ?? event.adjust_points ??
          event.create_reward ?? event.expire_points);
        const points=details.points;
        if(points!==undefined && !validPoints(points))
          throw new SquareHistoryError('UNVERIFIED_RESPONSE');
        return {type:event.type as string,createdAt:event.created_at as string,
          pointsDelta:points===undefined?null:points as number};
      });
      return {accountSuffix:accountId.slice(-4),events,moreAvailable:more(response),
        pointsModified:false as const};
    },
  };
}
