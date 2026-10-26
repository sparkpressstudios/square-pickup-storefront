import { squareApiVersion } from './square-sandbox';
import { previewConfiguration } from './square-catalog-readonly';
import { validatePreorderWindow, SquarePreorderError, type PreorderPreview, type PreorderPolicy } from './square-preorders';
import { preorderScheduleFromSettings, previewPreorderSlots, type PreorderSlotPreview } from './square-preorder-availability';
import { productReleasesFromSettings, previewProductPreorder, type SquarePreorderEligibility } from './square-preorder-products';
import { createSquareHistoryReader, type SquareHistoryReader } from './square-service-history';

const origin = 'https://connect.squareupsandbox.com';
const limitBytes = 96 * 1024;
type ObjectRecord = Record<string, unknown>;
function object(value: unknown): ObjectRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRecord : {};
}
function safeText(value: unknown, max = 100): string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max &&
    !/[\x00-\x1f\x7f]/.test(value) ? value : '';
}
function normalId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max &&
    /^[A-Za-z0-9_-]+$/.test(value);
}
export class SquareServiceError extends Error {
  constructor(readonly code: 'CONFIGURATION' | 'FEATURE_DISABLED' | 'INVALID_INPUT' |
    'NOT_AVAILABLE' | 'PERMISSION_DENIED' | 'RATE_LIMITED' | 'UNVERIFIED_RESPONSE' |
    'PROVIDER_UNAVAILABLE') { super(code); }
}
export interface SquareServicesAvailability {
  readonly mode: 'square-sandbox-admin-only';
  readonly preorders: boolean;
  readonly preorderSlotsConfigured: boolean;
  readonly giftCardsRead: boolean;
  readonly loyaltyRead: boolean;
  readonly preorderCheckout: false;
  readonly giftCardSales: false;
  readonly giftCardRedemption: false;
  readonly loyaltyEnrollment: false;
  readonly loyaltyRedemption: false;
}
export interface SquareGiftCardSummary {
  readonly cardSuffix: string;
  readonly state: string;
  readonly balanceMinor: number | null;
  readonly currency: 'USD';
  readonly redemptionAuthorized: false;
}
export interface SquareLoyaltyProgramSummary {
  readonly active: boolean;
  readonly status: string;
  readonly rewardTiers: readonly { name: string; points: number }[];
  readonly pointsRedemptionAuthorized: false;
}
export interface SquareGiftCardCoveragePreview {
  readonly cardSuffix: string;
  readonly giftCardMinor: number;
  readonly remainingMinor: number;
  readonly currency: 'USD';
  readonly paymentDispatched: false;
  readonly checkoutAuthorized: false;
}
export interface SquareLoyaltyPointsPreview {
  readonly orderSuffix: string;
  readonly points: number;
  readonly promotionPoints: number;
  readonly totalPoints: number;
  readonly pointsAwarded: false;
  readonly checkoutAuthorized: false;
}
export interface SquareLoyaltyEligibility {
  readonly accountSuffix: string; readonly availablePoints: number;
  readonly rewardTiers: readonly { readonly name: string; readonly requiredPoints: number; readonly eligible: boolean }[];
  readonly pointsSpent: false; readonly rewardCreated: false; readonly checkoutAuthorized: false;
}
export interface SquareLoyaltyAccountSummary {
  readonly accountSuffix: string;
  readonly pointsBalance: number;
  readonly lifetimePoints: number;
  readonly currency: null;
  readonly pointsRedemptionAuthorized: false;
}
export interface SquareServices extends SquareHistoryReader {
  readonly availability: SquareServicesAvailability;
  preorder(input: unknown, now?: number): PreorderPreview;
  preorderSlots(date: string, now?: number): PreorderSlotPreview;
  preorderProducts?(): readonly {readonly productId:string;readonly maxQuantity:number}[];
  preorderProduct?(input:unknown,now?:number):SquarePreorderEligibility;
  giftCard(cardId: unknown): Promise<SquareGiftCardSummary>;
  giftCardCoverage(cardId: unknown, orderTotalMinor: unknown): Promise<SquareGiftCardCoveragePreview>;
  estimateLoyaltyPoints(orderId: unknown, accountId?: unknown): Promise<SquareLoyaltyPointsPreview>;
  loyaltyProgram(): Promise<SquareLoyaltyProgramSummary>;
  loyaltyAccount(accountId: unknown): Promise<SquareLoyaltyAccountSummary>;
  rewardEligibility?(accountId: unknown): Promise<SquareLoyaltyEligibility>;
}
/** Explicit per-feature opt-ins. Do not infer Square subscriptions from token possession. */
export function squareServicesAvailability(values: Readonly<Record<string, string | undefined>>): SquareServicesAvailability {
  if (values.STARTER_DATASET !== 'merchant-catalog-v1' ||
      values.SQUARE_ENVIRONMENT !== 'sandbox' || values.SQUARE_SANDBOX_REQUESTS_ENABLED !== 'true')
    throw new SquareServiceError('CONFIGURATION');
  return {
    mode: 'square-sandbox-admin-only',
    preorders: values.SQUARE_PREORDERS_PREVIEW_ENABLED === 'true',
    preorderSlotsConfigured: values.SQUARE_PREORDERS_PREVIEW_ENABLED === 'true' && Boolean(values.SQUARE_PREORDER_SCHEDULE_JSON),
    giftCardsRead: values.SQUARE_GIFT_CARDS_READ_ENABLED === 'true',
    loyaltyRead: values.SQUARE_LOYALTY_READ_ENABLED === 'true',
    preorderCheckout: false, giftCardSales: false, giftCardRedemption: false,
    loyaltyEnrollment: false, loyaltyRedemption: false,
  };
}
export function createSquareServices(values: Readonly<Record<string,string|undefined>>,
  fetcher: typeof fetch): SquareServices {
  const availability = squareServicesAvailability(values);
  if (typeof fetcher !== 'function' ||
      !normalId(values.SQUARE_SANDBOX_MERCHANT_ID, 192)) throw new SquareServiceError('CONFIGURATION');
  let configuration: ReturnType<typeof previewConfiguration>;
  try { configuration=previewConfiguration(values); }
  catch { throw new SquareServiceError('CONFIGURATION'); }
  const token = values.SQUARE_SANDBOX_ACCESS_TOKEN!;
  const schedule=preorderScheduleFromSettings(values);
  const productReleases=productReleasesFromSettings(values);
  const history=createSquareHistoryReader(values,fetcher);
  // This limits a single setup server; distributed merchants must add shared rate limiting.
  let windowStart = 0, calls = 0;
  /** Only Square sandbox lookup endpoints and calculation-only POSTs are allowed by callers. */
  async function request(path:string,method:'GET'|'POST',body?:Record<string,unknown>):Promise<ObjectRecord> {
    const now=Date.now();
    if(now-windowStart>=60000){windowStart=now;calls=0;}
    if(++calls>20)throw new SquareServiceError('RATE_LIMITED');
    let response:Response;
    try {
      response=await fetcher(origin+path,{
        method,redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{Authorization:'Bearer '+token,'Square-Version':squareApiVersion,
          Accept:'application/json',...(method==='POST'?{'Content-Type':'application/json'}:{})},
        ...(method==='POST'?{body:JSON.stringify(body)}:{}),
      });
    }catch{throw new SquareServiceError('PROVIDER_UNAVAILABLE');}
    if(response.status===401||response.status===403)throw new SquareServiceError('PERMISSION_DENIED');
    if(response.status===404)throw new SquareServiceError('NOT_AVAILABLE');
    if(response.status===429)throw new SquareServiceError('RATE_LIMITED');
    if(response.status!==200||Number(response.headers.get('content-length')||0)>limitBytes)
      throw new SquareServiceError('PROVIDER_UNAVAILABLE');
    const reader=response.body?.getReader();
    if(!reader)throw new SquareServiceError('UNVERIFIED_RESPONSE');
    const parts:Uint8Array[]=[];let size=0;
    try{
      for(;;){
        const part=await reader.read();
        if(part.done)break;
        size+=part.value.byteLength;
        if(size>limitBytes)throw new SquareServiceError('PROVIDER_UNAVAILABLE');
        parts.push(part.value);
      }
    }finally{await reader.cancel().catch(()=>{});}
    let raw:unknown;
    try{raw=JSON.parse(Buffer.concat(parts).toString('utf8'));}
    catch{throw new SquareServiceError('UNVERIFIED_RESPONSE');}
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||'errors' in raw)
      throw new SquareServiceError('UNVERIFIED_RESPONSE');
    return raw as ObjectRecord;
  }
  const retrieve=(path:string)=>request(path,'GET');
  async function fetchProgram() {
    if (!availability.loyaltyRead) throw new SquareServiceError('FEATURE_DISABLED');
    const payload=await retrieve('/v2/loyalty/programs/main');
    const program=object(payload.program);
    const id=program.id;
    if(!normalId(id, 64) || !safeText(program.status, 32)) throw new SquareServiceError('UNVERIFIED_RESPONSE');
    return program;
  }
  return {
    availability,
    ...history,
    preorder(input: unknown, now?: number) {
      if(!availability.preorders)throw new SquareServiceError('FEATURE_DISABLED');
      const result=validatePreorderWindow(input,{enabled:true,
        minLeadMinutes:schedule?.minLeadMinutes ?? 120,
        maxDaysAhead:schedule?.maxDaysAhead ?? 30} satisfies PreorderPolicy,now);
      if(schedule){
        const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
          timeZone:schedule.businessTimezone,year:'numeric',month:'2-digit',day:'2-digit',
        }).formatToParts(new Date(result.pickupAt)).map(part=>[part.type,part.value]));
        const date=parts.year+'-'+parts.month+'-'+parts.day;
        const candidates=previewPreorderSlots(schedule,date,now);
        if(!candidates.slots.some(slot=>slot.pickupAt===result.pickupAt))
          throw new SquarePreorderError('INVALID_PICKUP_TIME');
      }
      return result;
    },
    preorderProducts() {
      if(!availability.preorders)throw new SquareServiceError('FEATURE_DISABLED');
      return productReleases.map(p=>({productId:p.productId,maxQuantity:p.maxQuantity}));
    },
    preorderProduct(input:unknown,now?:number) {
      if(!availability.preorders)throw new SquareServiceError('FEATURE_DISABLED');
      const source=input && typeof input==='object' && !Array.isArray(input)? input as Record<string,unknown> : {};
      const release=productReleases.find(item=>item.productId===source.productId);
      if(!release)throw new SquareServiceError('NOT_AVAILABLE');
      const result=previewProductPreorder(release,input,now);
      // A closed release can be described without incorrectly advertising a bookable slot.
      if(result.eligibleForPreorderPreview)
        this.preorder({pickupAt:result.pickupAt,windowMinutes:schedule?.slotMinutes??30},now);
      return result;
    },
    preorderSlots(date:string,now?:number){
      if(!availability.preorders || !schedule)
        throw new SquareServiceError('FEATURE_DISABLED');
      return previewPreorderSlots(schedule,date,now);
    },
    async giftCard(cardId:unknown) {
      if (!availability.giftCardsRead) throw new SquareServiceError('FEATURE_DISABLED');
      // Square-issued IDs only, never raw GAN, PIN, card token or personal details.
      if (typeof cardId!=='string' || !/^gftc:[A-Za-z0-9_-]{4,120}$/.test(cardId))
        throw new SquareServiceError('INVALID_INPUT');
      const data=object((await retrieve('/v2/gift-cards/'+encodeURIComponent(cardId))).gift_card);
      const state=safeText(data.state,32);
      const money=object(data.balance_money);
      if(data.id!==cardId || !state || money.currency!=='USD' ||
        typeof money.amount!=='number' || !Number.isSafeInteger(money.amount) ||
        money.amount<0 || money.amount>2147483647)
        throw new SquareServiceError('UNVERIFIED_RESPONSE');
      return {
        cardSuffix:cardId.slice(-4),state,balanceMinor:money.amount,currency:'USD',
        redemptionAuthorized:false,
      };
    },
    async giftCardCoverage(cardId: unknown, orderTotalMinor: unknown) {
      if(!Number.isSafeInteger(orderTotalMinor)||Number(orderTotalMinor)<1||
          Number(orderTotalMinor)>2147483647)throw new SquareServiceError('INVALID_INPUT');
      const card=await this.giftCard(cardId);
      if(card.state!=='ACTIVE'||card.balanceMinor===null)throw new SquareServiceError('NOT_AVAILABLE');
      const amount=Math.min(card.balanceMinor,Number(orderTotalMinor));
      return {cardSuffix:card.cardSuffix,giftCardMinor:amount,
        remainingMinor:Number(orderTotalMinor)-amount,currency:'USD' as const,
        paymentDispatched:false as const,checkoutAuthorized:false as const};
    },
    async estimateLoyaltyPoints(orderId: unknown, accountId?: unknown) {
      if(!availability.loyaltyRead)throw new SquareServiceError('FEATURE_DISABLED');
      if(!normalId(orderId,192)||(accountId!==undefined&&!normalId(accountId,64)))
        throw new SquareServiceError('INVALID_INPUT');
      const program=await fetchProgram();
      if(program.status!=='ACTIVE')throw new SquareServiceError('NOT_AVAILABLE');
      const order=object((await retrieve('/v2/orders/'+encodeURIComponent(orderId))).order);
      const money=object(order.total_money);
      if(order.id!==orderId||order.location_id!==configuration.locationId||
          money.currency!=='USD'||typeof money.amount!=='number'||
          !Number.isSafeInteger(money.amount)||money.amount<1||money.amount>2147483647)
        throw new SquareServiceError('UNVERIFIED_RESPONSE');
      const calculated=await request('/v2/loyalty/programs/'+encodeURIComponent(String(program.id))+'/calculate',
        'POST',{order_id:orderId,...(accountId?{loyalty_account_id:accountId}:{})});
      const base=calculated.points,promo=calculated.promotion_points??0;
      if(typeof base!=='number'||!Number.isSafeInteger(base)||base<0||base>2147483647||
          typeof promo!=='number'||!Number.isSafeInteger(promo)||promo<0||promo>2147483647||
          base+promo>2147483647)throw new SquareServiceError('UNVERIFIED_RESPONSE');
      return {orderSuffix:String(orderId).slice(-4),points:base,promotionPoints:promo,
        totalPoints:base+promo,pointsAwarded:false as const,checkoutAuthorized:false as const};
    },
    async loyaltyProgram() {
      const program=await fetchProgram();
      const tiers=program.reward_tiers;
      if(tiers!==undefined && (!Array.isArray(tiers) || tiers.length>30))
        throw new SquareServiceError('UNVERIFIED_RESPONSE');
      const rewardTiers=(Array.isArray(tiers)?tiers:[]).map((row:unknown)=>{
        const tier=object(row);
        if(!safeText(tier.name,120) || !Number.isSafeInteger(tier.points) ||
            (tier.points as number)<0 || (tier.points as number)>2147483647)
          throw new SquareServiceError('UNVERIFIED_RESPONSE');
        return {name:tier.name as string,points:tier.points as number};
      });
      return {active:program.status==='ACTIVE',status:program.status as string,
        rewardTiers,pointsRedemptionAuthorized:false};
    },
    async rewardEligibility(accountId:unknown) {
      if(!availability.loyaltyRead)throw new SquareServiceError('FEATURE_DISABLED');
      const [program,account]=await Promise.all([this.loyaltyProgram(),this.loyaltyAccount(accountId)]);
      if(!program.active)throw new SquareServiceError('NOT_AVAILABLE');
      return {accountSuffix:account.accountSuffix,availablePoints:account.pointsBalance,
        rewardTiers:program.rewardTiers.map(tier=>({name:tier.name,requiredPoints:tier.points,
          eligible:account.pointsBalance>=tier.points})),
        pointsSpent:false as const,rewardCreated:false as const,checkoutAuthorized:false as const};
    },
    async loyaltyAccount(accountId:unknown) {
      if (!availability.loyaltyRead) throw new SquareServiceError('FEATURE_DISABLED');
      if(!normalId(accountId,64))throw new SquareServiceError('INVALID_INPUT');
      const program=await fetchProgram();
      const account=object((await retrieve('/v2/loyalty/accounts/'+encodeURIComponent(accountId))).loyalty_account);
      if(account.id!==accountId || account.program_id!==program.id ||
        typeof account.balance!=='number' || !Number.isInteger(account.balance) ||
        account.balance< -2147483648 || account.balance>2147483647 ||
        typeof account.lifetime_points!=='number' || !Number.isInteger(account.lifetime_points) ||
        account.lifetime_points<0 || account.lifetime_points>2147483647)
        throw new SquareServiceError('UNVERIFIED_RESPONSE');
      // Intentionally strip Square phone_number, customer_id, mappings and enrollment details.
      return {accountSuffix:accountId.slice(-4),pointsBalance:account.balance,
        lifetimePoints:account.lifetime_points,currency:null,pointsRedemptionAuthorized:false};
    },
  };
}
