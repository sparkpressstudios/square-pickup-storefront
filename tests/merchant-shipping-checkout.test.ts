import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {ShippingQuoteService} from '../server/src/merchant-shipping-quote';
import {ShippingCheckoutRehearsal} from '../server/src/merchant-shipping-checkout';
import {verifyShippingMoney} from '../server/src/merchant-shipping-money';
import {adminCatalogRouter} from '../server/src/admin-catalog';
import type {ShippingPayableQuote,ShippingTaxRequest} from '../shared/merchant-shipping-quote';
const address={name:'Fixture Recipient',line1:'123 Fixture Street',city:'Testville',region:'PA',postalCode:'17000',country:'US'};
const contact={email:'fixture@example.invalid',phone:'+15555550123'};
const policy={enabled:true,revision:'rate-v1',rates:[{id:'ground',label:'Ground',regions:['PA'],amountMinor:500}]};
const basis={cartFingerprint:'a'.repeat(64),lines:[{id:'item',quantity:1,subtotalMinor:1200,discountMinor:200,basisMinor:1000,taxCategory:'configured'}],subtotalMinor:1200,discountMinor:200,basisMinor:1000,currency:'USD' as const};
const context={merchantId:'fixture-merchant',locationId:'fixture-location'};
const config={...context,adapterId:'fixture',revision:'tax-v1'};
const money=(amount:number)=>({amount,currency:'USD'});
function square(q:ShippingPayableQuote){return {reference_id:q.id,location_id:q.request.locationId,total_money:money(q.totalMinor),total_tax_money:money(90),total_discount_money:money(200),total_service_charge_money:money(500),total_tip_money:money(0),line_items:[{uid:'item',quantity:'1',base_price_money:money(1200),total_discount_money:money(200),total_tax_money:money(60),total_money:money(1060)}],service_charges:[{uid:'shipping',scope:'ORDER',calculation_phase:'SUBTOTAL_PHASE',taxable:true,amount_money:money(500),applied_money:money(500),total_tax_money:money(30),total_money:money(530)}]};}
async function fixture(){
 const db=await PGlite.create();await db.exec(await readFile(new URL('../db/merchant-shipping-checkout.sql',import.meta.url),'utf8'));
 let taxCalls=0,squareCalls=0;let currentPolicy=structuredClone(policy),currentBasis=structuredClone(basis);let enabled=true,invalidPricing=false;let now=Date.now();
 const registry=new Map([['fixture',{quote:async (r:ShippingTaxRequest)=>{taxCalls++;return {requestFingerprint:r.requestFingerprint,configurationRevision:r.taxConfigurationRevision,reference:'fixture-tax',currency:'USD' as const,merchandiseIncludedTaxMinor:0,merchandiseAdditionalTaxMinor:60,shippingIncludedTaxMinor:0,shippingAdditionalTaxMinor:30,totalMinor:r.merchandise.basisMinor+r.shipping.shippingFeeMinor+90,expiresAt:r.expiresAt};}}]]);let tax=new ShippingQuoteService(config,registry,()=>now);
 const resolve=async()=>({merchandise:currentBasis,policy:currentPolicy,...(enabled?{tax,calculate:async(q:ShippingPayableQuote)=>{squareCalls++;return invalidPricing?{...square(q),total_money:money(1)}:square(q);}}:{})});
 return {db,tax,service:new ShippingCheckoutRehearsal(db,context,resolve),restart:()=>new ShippingCheckoutRehearsal(db,context,resolve),counts:()=>({taxCalls,squareCalls}),advance:(ms:number)=>{now+=ms;},corruptPricing:()=>{invalidPricing=true;},changeTax:()=>{tax=new ShippingQuoteService({...config,revision:'tax-v2'},registry,()=>now);},other:()=>new ShippingCheckoutRehearsal(db,{...context,merchantId:'other'},resolve),disable:()=>{enabled=false;},changeRate:()=>{currentPolicy={...policy,revision:'rate-v2'};},resetRate:()=>{currentPolicy=structuredClone(policy);},changeCart:()=>{currentBasis={...basis,cartFingerprint:'b'.repeat(64)};}};
}
test('durable configured rehearsal coalesces duplicates, survives reconstruction and rejects stale selections',async()=>{
 const f=await fixture();try {
  const input={requestId:randomUUID(),cartId:'cart',address,rateId:'ground'};
  const [one,two]=await Promise.all([f.service.quote(input),f.service.quote(input)]);assert.equal(one.quote.id,two.quote.id);assert.deepEqual(f.counts(),{taxCalls:1,squareCalls:1});assert.equal(one.paymentExecutionEnabled,false);
  const replay=await f.restart().quote(input);assert.equal(replay.quote.fingerprint,one.quote.fingerprint);assert.deepEqual(f.counts(),{taxCalls:1,squareCalls:1});
  await assert.rejects(f.service.quote({...input,address:{...address,postalCode:'17001'}}),/SHIPPING_REQUEST_CHANGED/);
  const prepare={quoteId:one.quote.id,address,rateId:'ground',contact};
  await assert.rejects(f.service.prepare({...prepare,address:{...address,line1:'Changed'}}),/SHIPPING_QUOTE_CHANGED/);
  f.changeRate();await assert.rejects(f.service.prepare(prepare),/SHIPPING_QUOTE_CHANGED/);f.resetRate();
  const [first,second]=await Promise.all([f.service.prepare(prepare),f.service.prepare(prepare)]);assert.equal(first.state,'preview_prepared');assert.equal(second.quote.id,first.quote.id);assert.equal(first.fulfillment.type,'SHIPMENT');
  await assert.rejects(f.service.prepare({...prepare,contact:{...contact,phone:'+15555550124'}}),/SHIPPING_PREPARATION_CHANGED/);
  assert.throws(()=>f.service.execute(),/SHIPPING_EXECUTION_DISABLED/);assert.deepEqual(f.counts(),{taxCalls:1,squareCalls:1});
  f.changeCart();await assert.rejects(f.service.prepare(prepare),/SHIPPING_QUOTE_CHANGED/);assert.equal((await f.db.query('SELECT * FROM merchant_shipping_checkout_previews')).rows.length,1);
 } finally {await f.db.close();}
});
test('unconfigured shipping refuses before persistence and stranded quoting identity never redispatches',async()=>{
 const f=await fixture();try {
  const input={requestId:randomUUID(),cartId:'cart',address,rateId:'ground'};f.disable();await assert.rejects(f.service.quote(input),/SHIPPING_UNCONFIGURED/);assert.equal((await f.db.query('SELECT * FROM merchant_shipping_checkout_previews')).rows.length,0);assert.deepEqual(f.counts(),{taxCalls:0,squareCalls:0});
 } finally {await f.db.close();}
 const g=await fixture();try {const input={requestId:randomUUID(),cartId:'cart',address,rateId:'ground'};const quote=await g.service.quote(input);await g.db.query("UPDATE merchant_shipping_checkout_previews SET state='quoting',quote_id=NULL,quote=NULL WHERE request_id=$1",[input.requestId]);await assert.rejects(g.restart().quote(input),/SHIPPING_QUOTE_REVIEW/);assert.deepEqual(g.counts(),{taxCalls:1,squareCalls:1});assert.equal(quote.paymentExecutionEnabled,false);} finally {await g.db.close();}
});
test('Square money evidence separates shipping fee/additive tax and rejects hidden charges or wrong contexts',async()=>{
 const f=await fixture();try {const {quote}=await f.service.quote({requestId:randomUUID(),cartId:'cart',address,rateId:'ground'});verifyShippingMoney(square(quote),quote);
  for(const patch of [{location_id:'other'},{reference_id:randomUUID()},{total_money:money(1500)},{total_service_charge_money:money(530)},{total_tax_money:money(60)},{total_tip_money:money(1)},{service_charges:[]}])assert.throws(()=>verifyShippingMoney({...square(quote),...patch},quote),/UNVERIFIED_SHIPPING_PRICING/);
  assert.throws(()=>verifyShippingMoney({...square(quote),service_charges:[{...square(quote).service_charges[0],total_money:money(560)}]},quote),/UNVERIFIED_SHIPPING_PRICING/);
 } finally {await f.db.close();}
});
test('existing admin router enforces role/CSRF and shipping execution stays disabled over HTTP',async()=>{
 const f=await fixture();const app=express();app.use('/api/admin',adminCatalogRouter({shippingRehearsal:f.service,origin:'https://fixture.example',verifyStaff:async req=>req.headers['x-role']?{id:'fixture-admin',role:req.headers['x-role'] as 'admin',csrfToken:'fixture-csrf-token-123'}:null}));const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/shipping`;
 const headers={'content-type':'application/json','origin':'https://fixture.example','x-csrf-token':'fixture-csrf-token-123','x-role':'admin'};
 try {
  assert.equal((await fetch(url+'/status')).status,401);assert.equal((await fetch(url+'/status',{headers:{'x-role':'manager'}})).status,403);
  const status=await (await fetch(url+'/status',{headers})).json();assert.equal(status.shippingCheckoutEnabled,false);assert.equal(status.configured,true);
  const input={requestId:randomUUID(),cartId:'cart',address,rateId:'ground'};
  assert.equal((await fetch(url+'/quote',{method:'POST',headers:{...headers,'x-csrf-token':'wrong'},body:JSON.stringify(input)})).status,403);
  assert.deepEqual(f.counts(),{taxCalls:0,squareCalls:0});
  const response=await fetch(url+'/quote',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,200);const quote=(await response.json()).quote;assert.equal(quote.paymentExecutionEnabled,false);
  const prepared=await fetch(url+'/prepare',{method:'POST',headers,body:JSON.stringify({quoteId:quote.id,address,rateId:'ground',contact})});assert.equal(prepared.status,200);
  assert.equal((await fetch(url+'/execute',{method:'POST',headers,body:'{}'})).status,423);assert.deepEqual(f.counts(),{taxCalls:1,squareCalls:1});
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await f.db.close();}
});

test('linewise Square evidence rejects offsetting errors even when order totals match',async()=>{
 const tax=new ShippingQuoteService(config,new Map([['fixture',{quote:async (r:ShippingTaxRequest)=>({requestFingerprint:r.requestFingerprint,configurationRevision:r.taxConfigurationRevision,reference:'fixture-zero-tax',currency:'USD' as const,merchandiseIncludedTaxMinor:0,merchandiseAdditionalTaxMinor:0,shippingIncludedTaxMinor:0,shippingAdditionalTaxMinor:0,totalMinor:300,expiresAt:r.expiresAt})}]]));
 const q=await tax.quote({cartFingerprint:'c'.repeat(64),currency:'USD',subtotalMinor:300,discountMinor:0,basisMinor:300,lines:[{id:'a',quantity:1,subtotalMinor:100,discountMinor:0,basisMinor:100,taxCategory:'reviewed'},{id:'b',quantity:1,subtotalMinor:200,discountMinor:0,basisMinor:200,taxCategory:'reviewed'}]},{...policy,rates:[{...policy.rates[0],amountMinor:0}]},address,'ground');
 const raw={reference_id:q.id,location_id:context.locationId,total_money:money(300),total_tax_money:money(0),total_discount_money:money(0),total_service_charge_money:money(0),total_tip_money:money(0),service_charges:[],line_items:[{uid:'a',quantity:'1',base_price_money:money(100),total_discount_money:money(0),total_tax_money:money(0),total_money:money(100)},{uid:'b',quantity:'1',base_price_money:money(200),total_discount_money:money(0),total_tax_money:money(0),total_money:money(200)}]};
 verifyShippingMoney(raw,q);const changed=structuredClone(raw);changed.line_items[0]!.total_money=money(0);changed.line_items[1]!.total_money=money(300);assert.throws(()=>verifyShippingMoney(changed,q),/UNVERIFIED_SHIPPING_PRICING/);
 const modified=structuredClone(raw);Object.assign(modified.line_items[0]!,{modifiers:[{name:'unexpected'}]});assert.throws(()=>verifyShippingMoney(modified,q),/UNVERIFIED_SHIPPING_PRICING/);
});

test('tax revision/expiry reject preparation and failed pricing does not silently redispatch',async()=>{
 const f=await fixture();try {const input={requestId:randomUUID(),cartId:'cart',address,rateId:'ground'},one=await f.service.quote(input);await assert.rejects(f.other().quote(input),/SHIPPING_REQUEST_CHANGED/);f.changeTax();await assert.rejects(f.service.prepare({quoteId:one.quote.id,address,rateId:'ground',contact}),/SHIPPING_QUOTE_CHANGED/);assert.deepEqual(f.counts(),{taxCalls:1,squareCalls:1});}finally{await f.db.close();}
 const g=await fixture();try {const one=await g.service.quote({requestId:randomUUID(),cartId:'cart',address,rateId:'ground'});g.advance(600000);await assert.rejects(g.service.prepare({quoteId:one.quote.id,address,rateId:'ground',contact}),/SHIPPING_QUOTE_EXPIRED/);}finally{await g.db.close();}
 const h=await fixture();try {h.corruptPricing();const input={requestId:randomUUID(),cartId:'cart',address,rateId:'ground'};await assert.rejects(h.service.quote(input),/SHIPPING_QUOTE_FAILED/);await assert.rejects(h.restart().quote(input),/SHIPPING_QUOTE_REVIEW/);assert.deepEqual(h.counts(),{taxCalls:1,squareCalls:1});const row=(await h.db.query<{state:string;quote:unknown}>('SELECT state,quote FROM merchant_shipping_checkout_previews')).rows[0]!;assert.equal(row.state,'failed');assert.equal(row.quote,null);}finally{await h.db.close();}
});
test('default admin shipping registration is absent and cannot be enabled by request data',async()=>{
 const app=express();app.use('/api/admin',adminCatalogRouter({origin:'https://fixture.example',verifyStaff:async()=>({id:'fixture',role:'admin',csrfToken:'fixture-csrf-token-123'})}));const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/shipping`,headers={'content-type':'application/json',origin:'https://fixture.example','x-csrf-token':'fixture-csrf-token-123'};
 try {const status=await(await fetch(url+'/status')).json();assert.equal(status.configured,false);assert.equal(status.shippingCheckoutEnabled,false);assert.equal((await fetch(url+'/quote',{method:'POST',headers,body:JSON.stringify({enabled:true})})).status,503);assert.equal((await fetch(url+'/execute',{method:'POST',headers,body:'{}'})).status,423);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('admin shipping UI is explicit rehearsal only, never a pay or enable control',async()=>{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{ShippingRehearsalPanel}=await import('../client/src/shipping-rehearsal');const html=renderToStaticMarkup(createElement(ShippingRehearsalPanel,{csrfToken:'fixture-only'}));assert.match(html,/checkout disabled/);assert.match(html,/cannot charge a card/);assert.match(html,/Pickup checkout is unchanged/);assert.doesNotMatch(html,/Pay now|Enable shipping|cardToken/);
});

test('inclusive taxes remain inside merchandise and shipping bases, never added twice',async()=>{
 const tax=new ShippingQuoteService(config,new Map([['fixture',{quote:async(r:ShippingTaxRequest)=>({requestFingerprint:r.requestFingerprint,configurationRevision:r.taxConfigurationRevision,reference:'fixture-included-tax',currency:'USD' as const,merchandiseIncludedTaxMinor:60,merchandiseAdditionalTaxMinor:0,shippingIncludedTaxMinor:30,shippingAdditionalTaxMinor:0,totalMinor:1500,expiresAt:r.expiresAt})}]]));
 const q=await tax.quote(basis,policy,address,'ground'),raw=square(q);raw.line_items[0]!.total_money=money(1000);raw.service_charges[0]!.total_money=money(500);verifyShippingMoney(raw,q);
 const double=structuredClone(raw);double.service_charges[0]!.total_money=money(530);assert.throws(()=>verifyShippingMoney(double,q),/UNVERIFIED_SHIPPING_PRICING/);
 const phase=structuredClone(raw);phase.service_charges[0]!.calculation_phase='TOTAL_PHASE';assert.throws(()=>verifyShippingMoney(phase,q),/UNVERIFIED_SHIPPING_PRICING/);
});
