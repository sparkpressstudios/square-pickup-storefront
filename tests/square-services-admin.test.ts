import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/src/app';
import type { StaffPrincipal } from '../server/src/admin-catalog';
import type { SquareServices } from '../server/src/square-services';
import { SquareServicesPanel } from '../client/src/square-services-panel';
import { AdminLayout } from '../client/src/admin';

const origin='https://merchant-services.example.invalid';
const token='synthetic-merchant-csrf-token-with-32-characters';
const admin:StaffPrincipal={id:'verified-admin',role:'admin',csrfToken:token};
const flags={
  mode:'square-sandbox-admin-only' as const,preorders:true,preorderSlotsConfigured:true,giftCardsRead:true,loyaltyRead:true,
  preorderCheckout:false as const,giftCardSales:false as const,giftCardRedemption:false as const,
  loyaltyEnrollment:false as const,loyaltyRedemption:false as const,
};
async function serve(service:SquareServices|undefined,
  callback:(base:string,setIdentity:(staff:StaffPrincipal|null)=>void)=>Promise<void>) {
  let principal:StaffPrincipal|null=null;
  const app=await createApp(undefined,{origin,admin:{verifyStaff:async()=>principal,squareServices:service}});
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  try{await callback('http://127.0.0.1:'+(server.address() as AddressInfo).port,next=>{principal=next;});}
  finally{await new Promise<void>(done=>server.close(()=>done()));}
}
function post(base:string,path:string,value:unknown,headers:Record<string,string>={}) {
  return fetch(base+'/api/admin/square-services/'+path,{
    method:'POST',
    headers:{Origin:origin,'X-CSRF-Token':token,'Content-Type':'application/json',...headers},
    body:JSON.stringify(value),
  });
}
test('Square services page offers an explanatory preview but no unverified actions',()=>{
  const html=renderToStaticMarkup(createElement(SquareServicesPanel,{
    preview:true,role:'',enabled:false,csrfToken:'',
  }));
  assert.match(html,/Preorders, gift cards &amp; loyalty/);
  assert.match(html,/off by default/);
  assert.match(html,/No merchant services are enabled/);
  assert.doesNotMatch(html,/type="text"|type="datetime-local"|Check gift card|Check Loyalty program/);
  const shell=renderToStaticMarkup(createElement(AdminLayout,{path:'/admin/preview/square-services',
    root:'/admin/preview',navigate:()=>{},preview:true,children:'Square services'}));
  assert.match(shell,/aria-current="page">Square services/);
});
test('no configured merchant service remains closed despite forged role headers',async()=>{
  await serve(undefined,async(base,set)=>{
    let res=await fetch(base+'/api/admin/square-services/capabilities',{headers:{'X-Role':'admin'}});
    assert.equal(res.status,401);
    set(admin);
    const session=await (await fetch(base+'/api/admin/session')).json();
    assert.equal(session.squareServicesEnabled,false);
    res=await fetch(base+'/api/admin/square-services/capabilities');
    assert.equal(res.status,503);
    assert.equal((await res.json()).error.code,'SQUARE_SERVICES_DISABLED');
  });
});
test('merchant services require administrator, same-origin and CSRF for each lookup and preorder preview',async()=>{
  const events:string[]=[];
  const service:SquareServices={
    availability:flags,
    preorder(input) { events.push('preorder');return {
      mode:'square-sandbox-preview',pickupAt:(input as {pickupAt:string}).pickupAt,
      windowMinutes:30,scheduleType:'SCHEDULED',orderCreated:false,inventoryReserved:false,
      customerNotified:false,checkoutAuthorized:false,requiresSlotCapacity:true,
    }; },
    preorderSlots(date) {events.push('slots:'+date);return {
      mode:'scheduled-pickup-slots-preview',date,businessTimezone:'America/New_York',
      slots:[],capacityVerified:false,businessHoursVerified:false,checkoutAuthorized:false,
    };},
    async giftCardActivities(id){events.push('gift-history:'+String(id));return {
      cardSuffix:'0012',activities:[],moreAvailable:false,giftCardBalanceModified:false,
    };},
    async loyaltyRewards(id){events.push('rewards:'+String(id));return {
      accountSuffix:'CCT1',rewards:[],moreAvailable:false,pointsModified:false,
    };},
    async loyaltyEvents(id){events.push('events:'+String(id));return {
      accountSuffix:'CCT1',events:[],moreAvailable:false,pointsModified:false,
    };},
    async giftCard(id) {events.push('gift:'+String(id));return {
      cardSuffix:'0012',state:'ACTIVE',balanceMinor:2500,currency:'USD',redemptionAuthorized:false,
    };},
    async giftCardCoverage(cardId,total) {events.push('coverage:'+String(cardId)+':'+String(total));return {
      cardSuffix:'0012',giftCardMinor:2500,remainingMinor:500,currency:'USD',
      paymentDispatched:false,checkoutAuthorized:false,
    };},
    async estimateLoyaltyPoints(orderId,accountId) {events.push('points:'+String(orderId)+':'+String(accountId));return {
      orderSuffix:'DER1',points:5,promotionPoints:2,totalPoints:7,
      pointsAwarded:false,checkoutAuthorized:false,
    };},
    async loyaltyProgram() {events.push('loyalty-program');return {
      active:true,status:'ACTIVE',rewardTiers:[],pointsRedemptionAuthorized:false,
    };},
    async loyaltyAccount(id) {events.push('loyalty:'+String(id));return {
      accountSuffix:'UNT1',pointsBalance:15,lifetimePoints:100,currency:null,
      pointsRedemptionAuthorized:false,
    };},
  };
  await serve(service,async(base,set)=>{
    let res=await fetch(base+'/api/admin/square-services/capabilities',{headers:{'X-Role':'admin'}});
    assert.equal(res.status,401);
    set({id:'manager',role:'manager',csrfToken:token});
    assert.equal((await fetch(base+'/api/admin/square-services/capabilities')).status,403);
    assert.equal((await post(base,'gift-cards/lookup',{cardId:'gftc:TESTCARD0012'})).status,403);
    set(admin);
    const session=await (await fetch(base+'/api/admin/session')).json();
    assert.equal(session.squareServicesEnabled,true);
    res=await fetch(base+'/api/admin/square-services/capabilities');
    assert.equal(res.status,200);
    assert.equal((await res.json()).giftCardRedemption,false);
    assert.equal((await post(base,'gift-cards/lookup',{cardId:'gftc:TESTCARD0012'},{Origin:'https://evil.invalid'})).status,403);
    assert.equal((await post(base,'gift-cards/lookup',{cardId:'gftc:TESTCARD0012'},{'X-CSRF-Token':'invalid'})).status,403);
    assert.equal((await post(base,'loyalty/accounts/lookup',{accountId:'ACCT1'},{Origin:''})).status,403);
    for(const body of [{cardId:'gftc:TESTCARD0012',pin:'0000'},{},null,['card']]) {
      res=await post(base,'gift-cards/lookup',body);
      assert.equal(res.status,400);
    }
    assert.deepEqual(events,[]);
    res=await post(base,'preorders/preview',{pickupAt:'2026-11-01T12:00:00.000Z',windowMinutes:30});
    assert.equal(res.status,200);
    assert.equal((await res.json()).orderCreated,false);
    res=await post(base,'gift-cards/lookup',{cardId:'gftc:TESTCARD0012'});
    assert.equal(res.status,200);
    const gift=await res.json();
    assert.equal(gift.balanceMinor,2500);
    assert.deepEqual(Object.keys(gift).sort(),['balanceMinor','cardSuffix','currency','redemptionAuthorized','state'].sort());
    res=await fetch(base+'/api/admin/square-services/loyalty/program');
    assert.equal(res.status,200);
    assert.equal((await res.json()).pointsRedemptionAuthorized,false);
    res=await post(base,'loyalty/accounts/lookup',{accountId:'ACCT1'});
    assert.equal(res.status,200);
    assert.equal((await res.json()).pointsBalance,15);
    assert.equal((await fetch(base+'/api/admin/square-services/preorders/slots?date=2026-11-01')).status,200);
    assert.equal((await fetch(base+'/api/admin/square-services/preorders/slots?other=2026-11-01')).status,400);
    assert.equal((await post(base,'gift-cards/activities',{cardId:'gftc:TESTCARD0012',pin:'BAD'})).status,400);
    assert.equal((await post(base,'gift-cards/activities',{cardId:'gftc:TESTCARD0012'},
      {'X-CSRF-Token':'invalid'})).status,403);
    assert.equal((await post(base,'loyalty/rewards/history',{accountId:'ACCT1'},
      {Origin:'https://attacker.invalid'})).status,403);
    res=await post(base,'gift-cards/activities',{cardId:'gftc:TESTCARD0012'});
    assert.equal(res.status,200);assert.equal((await res.json()).giftCardBalanceModified,false);
    res=await post(base,'loyalty/rewards/history',{accountId:'ACCT1'});
    assert.equal(res.status,200);assert.equal((await res.json()).pointsModified,false);
    res=await post(base,'loyalty/events/history',{accountId:'ACCT1'});
    assert.equal(res.status,200);assert.equal((await res.json()).pointsModified,false);

    res=await post(base,'gift-cards/coverage',{cardId:'gftc:TESTCARD0012',orderTotalMinor:3000});
    assert.equal(res.status,200);
    assert.equal((await res.json()).paymentDispatched,false);
    res=await post(base,'loyalty/points/estimate',{orderId:'TESTORDER1',accountId:'ACCT1'});
    assert.equal(res.status,200);
    assert.equal((await res.json()).pointsAwarded,false);
    assert.equal((await post(base,'gift-cards/coverage',{cardId:'gftc:TESTCARD0012',orderTotalMinor:3000},{'X-CSRF-Token':'invalid'})).status,403);
    assert.equal((await post(base,'loyalty/points/estimate',{orderId:'TESTORDER1',phone_number:'555-0100'})).status,400);
    assert.deepEqual(events,[
      'preorder','gift:gftc:TESTCARD0012','loyalty-program','loyalty:ACCT1',
      'slots:2026-11-01','gift-history:gftc:TESTCARD0012','rewards:ACCT1','events:ACCT1',
      'coverage:gftc:TESTCARD0012:3000','points:TESTORDER1:ACCT1',
    ]);
  });
});
