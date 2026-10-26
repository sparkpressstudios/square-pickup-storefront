import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSquareServices, squareServicesAvailability, SquareServiceError,
} from '../server/src/square-services';
import { validatePreorderWindow, scheduledSquarePickupFulfillment, SquarePreorderError } from '../server/src/square-preorders';

const settings = {
  STARTER_DATASET: 'merchant-catalog-v1',
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_SANDBOX_REQUESTS_ENABLED: 'true',
  SQUARE_APPLICATION_ID: 'sandbox-sq0idb-services-unit',
  SQUARE_LOCATION_ID: 'SANDBOXLOCATION',
  SQUARE_SANDBOX_MERCHANT_ID: 'SANDBOXMERCHANT',
  SQUARE_SANDBOX_ACCESS_TOKEN: 'synthetic-square-services-test-token',
  SQUARE_PREORDERS_PREVIEW_ENABLED: 'true',
  SQUARE_GIFT_CARDS_READ_ENABLED: 'true',
  SQUARE_LOYALTY_READ_ENABLED: 'true',
};
const now=Date.parse('2026-10-23T12:00:00Z');
const giftId='gftc:TESTGIFTCARD0012';
const loyaltyId='TESTLOYALTYACCOUNT';
const provider: typeof fetch=async(input, init)=>{
  const url=new URL(String(input));
  assert.equal(url.origin,'https://connect.squareupsandbox.com');
  assert.equal(init?.method,'GET');
  assert.equal(init?.redirect,'error');
  assert.equal((init?.headers as Record<string,string>).Authorization,
    'Bearer '+settings.SQUARE_SANDBOX_ACCESS_TOKEN);
  if(url.pathname==='/v2/gift-cards/'+encodeURIComponent(giftId))
    return new Response(JSON.stringify({gift_card:{
      id:giftId,state:'ACTIVE',balance_money:{amount:2500,currency:'USD'},
      gan:'0000000000000000',customer_id:'NEVER_LEAK',
    }}));
  if(url.pathname==='/v2/loyalty/programs/main')
    return new Response(JSON.stringify({program:{
      id:'TESTPROGRAM123',status:'ACTIVE',
      reward_tiers:[{name:'Fictional reward',points:80}],
      customer_id:'DO_NOT_RETURN',
    }}));
  if(url.pathname==='/v2/loyalty/accounts/'+encodeURIComponent(loyaltyId))
    return new Response(JSON.stringify({loyalty_account:{
      id:loyaltyId,program_id:'TESTPROGRAM123',balance:-2,lifetime_points:128,
      mapping:{phone_number:'+15555550123'},customer_id:'DO_NOT_RETURN',
    }}));
  throw new Error('No other Square URL allowed');
};

test('all Square services default disabled and synthetic/production settings cannot bypass isolation',()=>{
  const availability=squareServicesAvailability({...settings,
    SQUARE_PREORDERS_PREVIEW_ENABLED:'false',
    SQUARE_GIFT_CARDS_READ_ENABLED:'false',SQUARE_LOYALTY_READ_ENABLED:'false'});
  assert.deepEqual(availability,{
    mode:'square-sandbox-admin-only',preorders:false,preorderSlotsConfigured:false,giftCardsRead:false,loyaltyRead:false,
    preorderCheckout:false,giftCardSales:false,giftCardRedemption:false,
    loyaltyEnrollment:false,loyaltyRedemption:false,
  });
  for(const configuration of [
    {...settings,STARTER_DATASET:'synthetic-retail-v1'},
    {...settings,SQUARE_ENVIRONMENT:'production'},
    {...settings,SQUARE_SANDBOX_REQUESTS_ENABLED:'false'},
  ]) assert.throws(()=>createSquareServices(configuration,provider),
    (e:unknown)=>e instanceof SquareServiceError&&e.code==='CONFIGURATION');
});
test('Square scheduled pickup preview uses exact RFC3339, 15-minute slots, future cutoffs, no payment dispatch',()=>{
  const service=createSquareServices(settings,provider);
  const input={pickupAt:'2026-10-24T12:30:00Z',windowMinutes:30};
  const preview=service.preorder(input,now);
  assert.equal(preview.scheduleType,'SCHEDULED');
  assert.equal(preview.orderCreated,false);
  assert.equal(preview.inventoryReserved,false);
  assert.equal(preview.checkoutAuthorized,false);
  assert.equal(preview.requiresSlotCapacity,true);
  const fulfillment=scheduledSquarePickupFulfillment(preview);
  assert.equal(fulfillment.type,'PICKUP');
  assert.equal(fulfillment.state,'PROPOSED');
  assert.equal(fulfillment.pickup_details.schedule_type,'SCHEDULED');
  assert.equal(fulfillment.pickup_details.pickup_at,'2026-10-24T12:30:00.000Z');
  assert.equal(fulfillment.pickup_details.pickup_window_duration,'PT30M');
  assert.equal(fulfillment.pickup_details.recipient.email_address,'shopper@example.invalid');
  assert.match(fulfillment.pickup_details.note,/PREVIEW ONLY/);
  // An explicit offset converts to UTC without silently changing the instant.
  assert.equal(service.preorder({pickupAt:'2026-10-24T08:30:00-04:00',windowMinutes:15},now).pickupAt,
    '2026-10-24T12:30:00.000Z');
  for(const wrong of [
    null,{},[],{pickupAt:input.pickupAt,windowMinutes:31},
    {...input,orderId:'CUSTOMER_FORGED'}, {pickupAt:'2026-10-24T12:30',windowMinutes:30},
    {pickupAt:'2026-10-24T12:31:00Z',windowMinutes:30},
    {pickupAt:'2026-10-23T12:15:00Z',windowMinutes:30},
    {pickupAt:'2026-12-20T12:00:00Z',windowMinutes:30},
  ]) assert.throws(()=>service.preorder(wrong,now),
    (e:unknown)=>e instanceof SquarePreorderError);
});
test('gift card balance read uses exact ID; Square card number, PIN and customer data stay on server',async()=>{
  const services=createSquareServices(settings,provider);
  const result=await services.giftCard(giftId);
  assert.deepEqual(result,{cardSuffix:'0012',state:'ACTIVE',balanceMinor:2500,
    currency:'USD',redemptionAuthorized:false});
  assert.doesNotMatch(JSON.stringify(result),/gan|customer_id|00000000|synthetic-square/);
  for(const wrong of ['7783320000123456','gftc:','gftc:../bad','card-on-file',null,{}])
    await assert.rejects(services.giftCard(wrong),(e:unknown)=>e instanceof SquareServiceError&&e.code==='INVALID_INPUT');
});
test('loyalty program and account retrieval exclude customer phone and tolerate negative points',async()=>{
  const services=createSquareServices(settings,provider);
  assert.deepEqual(await services.loyaltyProgram(),{
    active:true,status:'ACTIVE',rewardTiers:[{name:'Fictional reward',points:80}],
    pointsRedemptionAuthorized:false,
  });
  assert.deepEqual(await services.loyaltyAccount(loyaltyId),{
    accountSuffix:'OUNT',pointsBalance:-2,lifetimePoints:128,currency:null,
    pointsRedemptionAuthorized:false,
  });
  assert.doesNotMatch(JSON.stringify(await services.loyaltyAccount(loyaltyId)),/phone_number|customer_id|DO_NOT_RETURN/);
});
test('per-service opt-ins refuse fetch before any network call',async()=>{
  let calls=0;
  const noFetch:typeof fetch=async()=>{calls++;throw Error('Should never be called');};
  const service=createSquareServices({...settings,SQUARE_PREORDERS_PREVIEW_ENABLED:'false',
    SQUARE_GIFT_CARDS_READ_ENABLED:'false',SQUARE_LOYALTY_READ_ENABLED:'false'},noFetch);
  assert.throws(()=>service.preorder({pickupAt:'2026-10-24T12:30:00Z',windowMinutes:30},now),
    (e:unknown)=>e instanceof SquareServiceError&&e.code==='FEATURE_DISABLED');
  await assert.rejects(service.giftCard(giftId),(e:unknown)=>e instanceof SquareServiceError&&e.code==='FEATURE_DISABLED');
  await assert.rejects(service.loyaltyProgram(),(e:unknown)=>e instanceof SquareServiceError&&e.code==='FEATURE_DISABLED');
  await assert.rejects(service.loyaltyAccount(loyaltyId),(e:unknown)=>e instanceof SquareServiceError&&e.code==='FEATURE_DISABLED');
  assert.equal(calls,0);
});
test('provider permission, missing program and mismatched rewards fail closed without leaking errors',async()=>{
  await assert.rejects(createSquareServices(settings,async()=>new Response('{}',{status:403})).giftCard(giftId),
    (e:unknown)=>e instanceof SquareServiceError&&e.code==='PERMISSION_DENIED');
  await assert.rejects(createSquareServices(settings,async()=>new Response('{}',{status:404})).loyaltyProgram(),
    (e:unknown)=>e instanceof SquareServiceError&&e.code==='NOT_AVAILABLE');
  const wrongId:typeof fetch=async(input)=>{
    const path=new URL(String(input)).pathname;
    return new Response(JSON.stringify(path.includes('programs')?
      {program:{id:'REALPROGRAM',status:'ACTIVE'}}:
      {loyalty_account:{id:loyaltyId,program_id:'OTHERPROGRAM',balance:5,lifetime_points:5}}));
  };
  await assert.rejects(createSquareServices(settings,wrongId).loyaltyAccount(loyaltyId),
    (e:unknown)=>e instanceof SquareServiceError&&e.code==='UNVERIFIED_RESPONSE');
  const malformed:typeof fetch=async()=>new Response(JSON.stringify({gift_card:{id:giftId,gan:'private'}}));
  await assert.rejects(createSquareServices(settings,malformed).giftCard(giftId),
    (e:unknown)=>e instanceof SquareServiceError&&e.code==='UNVERIFIED_RESPONSE'&&!e.message.includes('private'));
});
test('read-only lookup budget limits repeated Square calls in one setup process',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async()=>{calls++;return new Response(JSON.stringify({gift_card:{
    id:giftId,state:'ACTIVE',balance_money:{amount:0,currency:'USD'},
  }}));};
  const service=createSquareServices(settings,fetcher);
  for(let i=0;i<20;i++) await service.giftCard(giftId);
  await assert.rejects(service.giftCard(giftId),
    (e:unknown)=>e instanceof SquareServiceError&&e.code==='RATE_LIMITED');
  assert.equal(calls,20);
});

test('gift card coverage previews full and partial split without charging or redeeming',async()=>{
  const service=createSquareServices(settings,provider);
  assert.deepEqual(await service.giftCardCoverage(giftId,4000),{
    cardSuffix:'0012',giftCardMinor:2500,remainingMinor:1500,currency:'USD',
    paymentDispatched:false,checkoutAuthorized:false,
  });
  assert.deepEqual(await service.giftCardCoverage(giftId,1200),{
    cardSuffix:'0012',giftCardMinor:1200,remainingMinor:0,currency:'USD',
    paymentDispatched:false,checkoutAuthorized:false,
  });
  for(const value of [null,-1,0,1.5,'500',2147483648])await assert.rejects(
    service.giftCardCoverage(giftId,value),e=>e instanceof SquareServiceError&&e.code==='INVALID_INPUT');
  const inactive=createSquareServices(settings,async()=>new Response(JSON.stringify({
    gift_card:{id:giftId,state:'PENDING',balance_money:{amount:2500,currency:'USD'}},
  })));
  await assert.rejects(inactive.giftCardCoverage(giftId,1000),
    e=>e instanceof SquareServiceError&&e.code==='NOT_AVAILABLE');
});
test('Square loyalty points preview validates existing order, location, program and provider result',async()=>{
  const paths:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    paths.push(path+':'+init?.method);
    assert.equal(new URL(String(input)).origin,'https://connect.squareupsandbox.com');
    assert.equal((init?.headers as Record<string,string>).Authorization,
      'Bearer '+settings.SQUARE_SANDBOX_ACCESS_TOKEN);
    if(path==='/v2/loyalty/programs/main')return new Response(JSON.stringify({
      program:{id:'TESTPROGRAM123',status:'ACTIVE'},
    }));
    if(path==='/v2/orders/TESTORDER123')return new Response(JSON.stringify({
      order:{id:'TESTORDER123',location_id:settings.SQUARE_LOCATION_ID,
        total_money:{amount:2500,currency:'USD'},state:'COMPLETED'},
    }));
    if(path==='/v2/loyalty/programs/TESTPROGRAM123/calculate'){
      assert.equal(init?.method,'POST');
      const body=JSON.parse(String(init?.body));
      assert.deepEqual(body,{order_id:'TESTORDER123',loyalty_account_id:'TESTLOYALTYACCOUNT'});
      return new Response(JSON.stringify({points:5,promotion_points:2,
        customer_id:'DO_NOT_RETURN'}));
    }
    throw new Error('Unexpected sandbox URL');
  };
  const service=createSquareServices(settings,fetcher);
  assert.deepEqual(await service.estimateLoyaltyPoints('TESTORDER123','TESTLOYALTYACCOUNT'),{
    orderSuffix:'R123',points:5,promotionPoints:2,totalPoints:7,
    pointsAwarded:false,checkoutAuthorized:false,
  });
  assert.deepEqual(paths,[
    '/v2/loyalty/programs/main:GET','/v2/orders/TESTORDER123:GET',
    '/v2/loyalty/programs/TESTPROGRAM123/calculate:POST',
  ]);
  assert.doesNotMatch(JSON.stringify(await service.loyaltyProgram()),/DO_NOT_RETURN/);
});
test('unverified order location, inactive loyalty and malformed point totals fail before any points award',async()=>{
  const wrong:typeof fetch=async input=>{
    const path=new URL(String(input)).pathname;
    if(path.includes('/programs/main'))return new Response(JSON.stringify({
      program:{id:'TESTPROGRAM123',status:'ACTIVE'},
    }));
    return new Response(JSON.stringify({order:{id:'TESTORDER123',location_id:'OTHER',
      total_money:{amount:800,currency:'USD'}}}));
  };
  await assert.rejects(createSquareServices(settings,wrong).estimateLoyaltyPoints('TESTORDER123'),
    e=>e instanceof SquareServiceError&&e.code==='UNVERIFIED_RESPONSE');
  const inactive:typeof fetch=async()=>new Response(JSON.stringify({
    program:{id:'TESTPROGRAM123',status:'INACTIVE'},
  }));
  await assert.rejects(createSquareServices(settings,inactive).estimateLoyaltyPoints('TESTORDER123'),
    e=>e instanceof SquareServiceError&&e.code==='NOT_AVAILABLE');
  for(const points of [-1,1.5,2147483648,'7']) {
    const stub:typeof fetch=async(input)=>{
      const path=new URL(String(input)).pathname;
      return new Response(JSON.stringify(path.includes('/main')?
        {program:{id:'TESTPROGRAM123',status:'ACTIVE'}}:
        path.includes('/v2/orders/')?
          {order:{id:'TESTORDER123',location_id:settings.SQUARE_LOCATION_ID,
            total_money:{amount:800,currency:'USD'}}}:
          {points,promotion_points:0}));
    };
    await assert.rejects(createSquareServices(settings,stub).estimateLoyaltyPoints('TESTORDER123'),
      e=>e instanceof SquareServiceError&&e.code==='UNVERIFIED_RESPONSE');
  }
  let calls=0;
  const noFetch:typeof fetch=async()=>{calls++;throw new Error('Unexpected network');};
  for(const [order,account] of [['../bad','ACCOUNT1'],['TESTORDER123','bad account'],
    [null,undefined]]) {
    await assert.rejects(createSquareServices(settings,noFetch).estimateLoyaltyPoints(order,account),
      e=>e instanceof SquareServiceError&&e.code==='INVALID_INPUT');
  }
  assert.equal(calls,0);
});
