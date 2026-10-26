import assert from 'node:assert/strict';
import test from 'node:test';
import { createSquareServices, SquareServiceError } from '../server/src/square-services';
import {
  parseSquareProductReleases, productReleasesFromSettings,
  previewProductPreorder,
} from '../server/src/square-preorder-products';
import { SquarePreorderError } from '../server/src/square-preorders';

const release={
  productId:'sq-item-seasonal1',
  orderOpensAt:'2026-10-23T09:00:00Z',
  orderClosesAt:'2026-10-26T09:00:00Z',
  pickupStartsAt:'2026-10-25T09:00:00Z',
  pickupEndsAt:'2026-10-28T17:00:00Z',
  maxQuantity:4,
};
const now=Date.parse('2026-10-24T12:00:00Z');
const settings={
  STARTER_DATASET:'merchant-catalog-v1',SQUARE_ENVIRONMENT:'sandbox',
  SQUARE_SANDBOX_REQUESTS_ENABLED:'true',
  SQUARE_APPLICATION_ID:'sandbox-sq0idb-benefits-test',
  SQUARE_LOCATION_ID:'TESTLOCATION',
  SQUARE_SANDBOX_MERCHANT_ID:'TESTMERCHANT',
  SQUARE_SANDBOX_ACCESS_TOKEN:'fictional-sandbox-credential-for-unit-tests',
  SQUARE_PREORDERS_PREVIEW_ENABLED:'true',
  SQUARE_LOYALTY_READ_ENABLED:'true',
  SQUARE_PREORDER_RELEASES_JSON:JSON.stringify([release]),
};
const emptyProvider:typeof fetch=async()=>{throw Error('Provider should not be accessed');};

test('product-specific preorder seasons gate releases, order cutoff and quantity without creating or reserving',()=>{
  assert.deepEqual(parseSquareProductReleases([release]),[release]);
  const service=createSquareServices(settings,emptyProvider);
  assert.deepEqual(service.preorderProducts?.(),[{productId:release.productId,maxQuantity:4}]);
  const request={productId:release.productId,quantity:2,pickupAt:'2026-10-25T12:30:00Z'};
  const accepted=service.preorderProduct?.(request,now);
  assert.equal(accepted?.eligibleForPreorderPreview,true);
  assert.equal(accepted?.reason,null);
  assert.equal(accepted?.orderCreated,false);
  assert.equal(accepted?.inventoryReserved,false);
  assert.equal(accepted?.checkoutAuthorized,false);
  assert.equal(accepted?.capacityReservationRequired,true);
  assert.equal(service.preorderProduct?.(request,Date.parse('2026-10-22T12:00:00Z'))?.reason,'NOT_RELEASED');
  assert.equal(service.preorderProduct?.(request,Date.parse('2026-10-27T12:00:00Z'))?.reason,'ORDER_CUTOFF');
  assert.equal(service.preorderProduct?.({...request,quantity:5},now)?.reason,'OVER_QUANTITY_LIMIT');
  assert.equal(service.preorderProduct?.({...request,pickupAt:'2026-10-29T12:30:00Z'},now)?.reason,'OUTSIDE_PICKUP_WINDOW');
  assert.throws(()=>service.preorderProduct?.({...request,role:'admin'},now),
    e=>e instanceof SquarePreorderError&&e.code==='INVALID_WINDOW');
  assert.throws(()=>service.preorderProduct?.({...request,pickupAt:'2026-10-25T12:31:00Z'},now),
    e=>e instanceof SquarePreorderError);
  assert.throws(()=>service.preorderProduct?.({productId:'other-item',quantity:1,pickupAt:request.pickupAt},now),
    e=>e instanceof SquareServiceError&&e.code==='NOT_AVAILABLE');
});
test('malformed, duplicate, overlong or impossible seasonal release definitions fail before merchant setup',()=>{
  for(const raw of [
    null,{},[release,release],[{...release,maxQuantity:0}],
    [{...release,pickupEndsAt:'2026-10-21T12:00:00Z'}],
    [{...release,orderClosesAt:'2026-10-21T12:00:00Z'}],
    [{...release,orderClosesAt:'2026-10-26T09:00:00.000Z'}],
    [{...release,extra:'forged'}],
    Array.from({length:51},(_,i)=>({...release,productId:'product-'+i})),
  ]){
    assert.throws(()=>parseSquareProductReleases(raw),e=>e instanceof SquarePreorderError);
  }
  assert.throws(()=>productReleasesFromSettings({...settings,SQUARE_PREORDER_RELEASES_JSON:'{invalid'}));
  assert.deepEqual(productReleasesFromSettings({...settings,SQUARE_PREORDERS_PREVIEW_ENABLED:'false'}),[]);
});
test('Square loyalty reward tier eligibility reads existing program/account but never awards or spends points',async()=>{
  const methods:string[]=[];
  const provider:typeof fetch=async(url,init)=>{
    const pathname=new URL(String(url)).pathname;
    methods.push(pathname);
    assert.equal(init?.method,'GET');
    if(pathname==='/v2/loyalty/programs/main')return new Response(JSON.stringify({program:{
      id:'PROGRAM1',status:'ACTIVE',reward_tiers:[
        {name:'Small reward',points:30},{name:'Large reward',points:100},
      ],
      customer_id:'PRIVATE',
    }}));
    if(pathname==='/v2/loyalty/accounts/ACCOUNT123')return new Response(JSON.stringify({loyalty_account:{
      id:'ACCOUNT123',program_id:'PROGRAM1',balance:60,lifetime_points:230,
      phone_number:'+12025550101',customer_id:'PRIVATE',
    }}));
    throw new Error('Unexpected Square operation');
  };
  const service=createSquareServices(settings,provider);
  const result=await service.rewardEligibility?.('ACCOUNT123');
  assert.deepEqual(result,{
    accountSuffix:'T123',availablePoints:60,
    rewardTiers:[{name:'Small reward',requiredPoints:30,eligible:true},
      {name:'Large reward',requiredPoints:100,eligible:false}],
    pointsSpent:false,rewardCreated:false,checkoutAuthorized:false,
  });
  assert.ok(methods.every(path=>!path.includes('redeem')&&!path.includes('accumulate')));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|phone|customer/);
});
test('loyalty reward eligibility is separately disabled when merchant has not enabled it',async()=>{
  const service=createSquareServices({...settings,SQUARE_LOYALTY_READ_ENABLED:'false'},emptyProvider);
  await assert.rejects(service.rewardEligibility!('ACCOUNT123'),
    (e:unknown)=>e instanceof SquareServiceError&&e.code==='FEATURE_DISABLED');
});
