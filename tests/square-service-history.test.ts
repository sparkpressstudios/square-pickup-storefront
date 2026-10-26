import assert from 'node:assert/strict';
import test from 'node:test';
import { createSquareHistoryReader, SquareHistoryError } from '../server/src/square-service-history';

const cardId='gftc:TESTCARD0012', accountId='ACCOUNT123';
const settings={
  STARTER_DATASET:'merchant-catalog-v1',SQUARE_ENVIRONMENT:'sandbox',
  SQUARE_SANDBOX_REQUESTS_ENABLED:'true',SQUARE_APPLICATION_ID:'sandbox-sq0idb-test-app',
  SQUARE_LOCATION_ID:'LOCATION123',SQUARE_SANDBOX_ACCESS_TOKEN:'synthetic-not-real-sandbox-token',
  SQUARE_GIFT_CARDS_READ_ENABLED:'true',SQUARE_LOYALTY_READ_ENABLED:'true',
};
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});

test('gift card activity read is scoped by card and location, one page only, with no GAN or PII',async()=>{
  const urls:string[]=[];
  const reader=createSquareHistoryReader(settings,async(input,init)=>{
    const url=new URL(String(input));urls.push(url.toString());
    assert.equal(url.origin,'https://connect.squareupsandbox.com');
    assert.equal(url.pathname,'/v2/gift-cards/activities');
    assert.equal(url.searchParams.get('gift_card_id'),cardId);
    assert.equal(url.searchParams.get('location_id'),'LOCATION123');
    assert.equal(url.searchParams.get('limit'),'20');
    assert.equal(url.searchParams.get('sort_order'),'DESC');
    assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+settings.SQUARE_SANDBOX_ACCESS_TOKEN);
    return reply({gift_card_activities:[
      {id:'gcact_123',type:'REDEEM',gift_card_id:cardId,location_id:'LOCATION123',
        created_at:'2026-10-20T12:15:00Z',gift_card_gan:'7783320000000001',
        gift_card_balance_money:{amount:700,currency:'USD'},customer_id:'SECRET_CUSTOMER',
        redeem_activity_details:{amount_money:{amount:300,currency:'USD'}}},
      {id:'gcact_456',type:'ACTIVATE',gift_card_id:cardId,location_id:'LOCATION123',
        created_at:'2026-10-01T12:00:00Z',gift_card_balance_money:{amount:1000,currency:'USD'}},
    ],cursor:'ANOTHER_PAGE'});
  });
  const result=await reader.giftCardActivities(cardId);
  assert.deepEqual(result,{cardSuffix:'0012',activities:[
    {type:'REDEEM',createdAt:'2026-10-20T12:15:00Z',balanceAfterMinor:700},
    {type:'ACTIVATE',createdAt:'2026-10-01T12:00:00Z',balanceAfterMinor:1000},
  ],moreAvailable:true,giftCardBalanceModified:false});
  assert.equal(urls.length,1);
  assert.doesNotMatch(JSON.stringify(result),/gift_card_gan|customer_id|gcact_|778332|SECRET_CUSTOMER|synthetic-not-real/);
});

test('loyalty rewards/events require exact known account and send only filtered read-only searches',async()=>{
  const called:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));called.push(url.pathname);
    assert.equal(url.origin,'https://connect.squareupsandbox.com');
    assert.equal(init?.method,'POST');
    assert.equal(init?.redirect,'error');
    const body=JSON.parse(String(init?.body));
    assert.equal(body.limit,15);
    if(url.pathname==='/v2/loyalty/rewards/search'){
      assert.deepEqual(body.query,{loyalty_account_id:accountId});
      return reply({rewards:[{id:'REWARD99',loyalty_account_id:accountId,status:'ISSUED',
        points:40,updated_at:'2026-10-24T08:00:00Z',order_id:'PRIVATE_ORDER',
        customer_id:'PRIVATE_CUSTOMER'}],cursor:'NEXT'});
    }
    assert.equal(url.pathname,'/v2/loyalty/events/search');
    assert.deepEqual(body.query,{filter:{loyalty_account_filter:{loyalty_account_id:accountId}}});
    return reply({events:[
      {id:'E1',loyalty_account_id:accountId,type:'ACCUMULATE_POINTS',
        created_at:'2026-10-23T09:00:00Z',
        accumulate_points:{points:6,order_id:'PRIVATE_ORDER'}},
      {id:'E2',loyalty_account_id:accountId,type:'REDEEM_REWARD',
        created_at:'2026-10-23T10:00:00Z',
        redeem_reward:{reward_id:'PRIVATE_REWARD',order_id:'PRIVATE_ORDER'}},
    ]});
  };
  const history=createSquareHistoryReader(settings,fetcher);
  const rewards=await history.loyaltyRewards(accountId);
  assert.deepEqual(rewards,{accountSuffix:'T123',rewards:[
    {status:'ISSUED',points:40,updatedAt:'2026-10-24T08:00:00Z'},
  ],moreAvailable:true,pointsModified:false});
  const events=await history.loyaltyEvents(accountId);
  assert.deepEqual(events,{accountSuffix:'T123',events:[
    {type:'ACCUMULATE_POINTS',createdAt:'2026-10-23T09:00:00Z',pointsDelta:6},
    {type:'REDEEM_REWARD',createdAt:'2026-10-23T10:00:00Z',pointsDelta:null},
  ],moreAvailable:false,pointsModified:false});
  assert.deepEqual(called,['/v2/loyalty/rewards/search','/v2/loyalty/events/search']);
  assert.doesNotMatch(JSON.stringify({rewards,events}),/PRIVATE_|customer_id|order_id|E1|REWARD99/);
});

test('disabled or invalid history access refuses all network calls and production/synthetic cannot opt in',async()=>{
  let called=0;
  const fetcher:typeof fetch=async()=>{called++;throw new Error('UNEXPECTED');};
  const disabled=createSquareHistoryReader({...settings,SQUARE_GIFT_CARDS_READ_ENABLED:'false',SQUARE_LOYALTY_READ_ENABLED:'false'},fetcher);
  for(const query of [
    disabled.giftCardActivities(cardId),disabled.loyaltyRewards(accountId),disabled.loyaltyEvents(accountId),
  ])await assert.rejects(query,(e:unknown)=>e instanceof SquareHistoryError&&e.code==='FEATURE_DISABLED');
  const enabled=createSquareHistoryReader(settings,fetcher);
  for(const q of [
    enabled.giftCardActivities('7783320000000001'),enabled.giftCardActivities('gftc:'),
    enabled.loyaltyRewards('invalid/../../abc'),enabled.loyaltyEvents(''),
  ])await assert.rejects(q,(e:unknown)=>e instanceof SquareHistoryError&&e.code==='INVALID_INPUT');
  assert.equal(called,0);
  for(const values of [
    {...settings,STARTER_DATASET:'synthetic-retail-v1'},
    {...settings,SQUARE_ENVIRONMENT:'production'},
    {...settings,SQUARE_SANDBOX_REQUESTS_ENABLED:'false'},
  ])assert.throws(()=>createSquareHistoryReader(values,fetcher),
    (e:unknown)=>e instanceof SquareHistoryError&&e.code==='FEATURE_DISABLED');
});
test('reject mismatched card/location, loyalty account, unsafe totals, malformed cursors and provider errors',async()=>{
  const invalid=[
    {gift_card_activities:[{gift_card_id:'gftc:OTHER',location_id:'LOCATION123',
      type:'REDEEM',created_at:'2026-10-24T08:00:00Z'}]},
    {gift_card_activities:[{gift_card_id:cardId,location_id:'OTHER',
      type:'ACTIVATE',created_at:'2026-10-24T08:00:00Z'}]},
    {gift_card_activities:[{gift_card_id:cardId,location_id:'LOCATION123',
      type:'REDEEM',created_at:'not-a-date'}]},
    {gift_card_activities:[{gift_card_id:cardId,location_id:'LOCATION123',
      type:'REDEEM',created_at:'2026-10-24T08:00:00Z',
      gift_card_balance_money:{amount:-30,currency:'USD'}}]},
    {gift_card_activities:[],cursor:13},
  ];
  for(const response of invalid)await assert.rejects(
    createSquareHistoryReader(settings,async()=>reply(response)).giftCardActivities(cardId),
    (e:unknown)=>e instanceof SquareHistoryError&&e.code==='UNVERIFIED_RESPONSE');
  await assert.rejects(createSquareHistoryReader(settings,async()=>reply({rewards:[
    {loyalty_account_id:'OTHER',status:'ISSUED',points:5,updated_at:'2026-10-24T08:00:00Z'},
  ]})).loyaltyRewards(accountId),(e:unknown)=>e instanceof SquareHistoryError&&e.code==='UNVERIFIED_RESPONSE');
  await assert.rejects(createSquareHistoryReader(settings,async()=>reply({events:[
    {loyalty_account_id:accountId,type:'ACCUMULATE_POINTS',created_at:'2026-10-24T08:00:00Z',
      accumulate_points:{points:2.5}},
  ]})).loyaltyEvents(accountId),(e:unknown)=>e instanceof SquareHistoryError&&e.code==='UNVERIFIED_RESPONSE');
  await assert.rejects(createSquareHistoryReader(settings,async()=>reply({},403)).giftCardActivities(cardId),
    (e:unknown)=>e instanceof SquareHistoryError&&e.code==='PERMISSION_DENIED');
  await assert.rejects(createSquareHistoryReader(settings,async()=>{throw new Error('SECRET_TOKEN');}).giftCardActivities(cardId),
    (e:unknown)=>e instanceof SquareHistoryError&&e.code==='PROVIDER_UNAVAILABLE'&&!e.message.includes('SECRET_TOKEN'));
});
test('history lookups have a bounded per-process request budget and no automatic pagination',async()=>{
  let count=0;
  const service=createSquareHistoryReader(settings,async()=>{count++;return reply({gift_card_activities:[]});});
  for(let i=0;i<12;i++)assert.equal((await service.giftCardActivities(cardId)).activities.length,0);
  await assert.rejects(service.giftCardActivities(cardId),
    (e:unknown)=>e instanceof SquareHistoryError&&e.code==='RATE_LIMITED');
  assert.equal(count,12);
});
