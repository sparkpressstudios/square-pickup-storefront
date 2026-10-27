import test from 'node:test';
import assert from 'node:assert/strict';
import {ShippingQuoteService,type ShippingTaxAdapter} from '../server/src/merchant-shipping-quote';
import type {ShippingTaxRequest,ShippingTaxEvidence} from '../shared/merchant-shipping-quote';
const address={name:'Fixture',line1:'123 Fixture Street',city:'Testville',region:'PA',postalCode:'17000',country:'US'};
const policy={enabled:true,revision:'rate-v1',rates:[{id:'ground',label:'Ground',regions:['PA'],amountMinor:500}]};
const basis={cartFingerprint:'a'.repeat(64),lines:[{id:'fixture-item',quantity:1,subtotalMinor:1200,discountMinor:200,basisMinor:1000,taxCategory:'merchant-configured-category'}],subtotalMinor:1200,discountMinor:200,basisMinor:1000,currency:'USD' as const};
const config={adapterId:'fixture',revision:'tax-v1',merchantId:'fixture-merchant',locationId:'fixture-location'};
const answer=(r:ShippingTaxRequest):ShippingTaxEvidence=>({requestFingerprint:r.requestFingerprint,configurationRevision:r.taxConfigurationRevision,reference:'fixture-evidence',currency:'USD',merchandiseIncludedTaxMinor:0,merchandiseAdditionalTaxMinor:60,shippingIncludedTaxMinor:0,shippingAdditionalTaxMinor:30,totalMinor:1590,expiresAt:r.expiresAt});
const service=(quote:ShippingTaxAdapter['quote']=async r=>answer(r),now=()=>1000000,timeout=4000)=>new ShippingQuoteService(config,new Map([['fixture',{quote}]]),now,timeout);
test('no configured/registered tax adapter means no shipping amount; never assume zero tax',()=>{
 for(const configuration of [undefined,{...config,adapterId:'missing'},{...config,revision:''},{...config,merchantId:''},{...config,locationId:''}])assert.throws(()=>new ShippingQuoteService(configuration,new Map()),/SHIPPING_TAX_UNCONFIGURED/);
});
test('trusted adapter bound to complete normalized cart/address/fee/revision yields immutable amount only',async()=>{
 let captured:ShippingTaxRequest|undefined;const quote=await service(async r=>{captured=r;assert.ok(Object.isFrozen(r));assert.ok(Object.isFrozen(r.shipping.address));assert.ok(Object.isFrozen(r.merchandise.lines[0]));return answer(r);}).quote(basis,policy,address,'ground');
 assert.equal(quote.totalMinor,1590);assert.equal(quote.paymentExecutionEnabled,false);assert.equal(quote.request.shipping.checkoutEnabled,false);assert.equal(quote.tax.reference,'fixture-evidence');assert.ok(Object.isFrozen(quote.tax));assert.ok(Object.isFrozen(quote));assert.equal(captured?.merchandise.basisMinor,1000);assert.equal(captured?.shipping.shippingFeeMinor,500);
});
test('inclusive taxes stay included rather than being charged twice; explicit verified zero tax is allowed',async()=>{
 const inclusive=await service(async r=>({...answer(r),merchandiseIncludedTaxMinor:60,merchandiseAdditionalTaxMinor:0,shippingIncludedTaxMinor:30,shippingAdditionalTaxMinor:0,totalMinor:1500})).quote(basis,policy,address,'ground');assert.equal(inclusive.totalMinor,1500);
 const zero=await service(async r=>({...answer(r),merchandiseAdditionalTaxMinor:0,shippingAdditionalTaxMinor:0,totalMinor:1500})).quote(basis,policy,address,'ground');assert.equal(zero.totalMinor,1500);assert.equal(zero.paymentExecutionEnabled,false);
});
test('changed address, rate or cart produces different tax request identity',async()=>{
 const s=service();const original=await s.quote(basis,policy,address,'ground');
 for(const changed of [await s.quote({...basis,cartFingerprint:'b'.repeat(64)},policy,address,'ground'),await s.quote(basis,policy,{...address,postalCode:'17001'},'ground'),await s.quote(basis,{...policy,revision:'rate-v2'},address,'ground')])assert.notEqual(changed.request.requestFingerprint,original.request.requestFingerprint);
});
test('unbound, stale, mismatched, malformed and arithmetically wrong tax evidence fail closed',async()=>{
 const bad:Partial<ShippingTaxEvidence>[]=[{requestFingerprint:'b'.repeat(64)},{configurationRevision:'other'},{currency:'EUR' as 'USD'},{reference:''},{totalMinor:1500},{totalMinor:0},{shippingIncludedTaxMinor:501},{merchandiseIncludedTaxMinor:1001},{merchandiseAdditionalTaxMinor:-1},{shippingAdditionalTaxMinor:1.5},{expiresAt:new Date(999999).toISOString()},{expiresAt:new Date(9999999999).toISOString()}];
 for(const patch of bad)await assert.rejects(service(async r=>({...answer(r),...patch})).quote(basis,policy,address,'ground'),/UNVERIFIED_SHIPPING_TAX/);
 await assert.rejects(service(async r=>({...answer(r),extra:'not accepted'})).quote(basis,policy,address,'ground'),/UNVERIFIED_SHIPPING_TAX/);
});
test('invalid server merchandise basis fails before adapter access',async()=>{
 let calls=0;const s=service(async r=>{calls++;return answer(r);});
 for(const patch of [{basisMinor:999},{subtotalMinor:Infinity},{discountMinor:1201},{currency:'EUR'},{cartFingerprint:'invalid'},{lines:[]},{lines:Array(1),subtotalMinor:0,discountMinor:0,basisMinor:0},{lines:[{...basis.lines[0],taxCategory:''}]},{lines:[basis.lines[0],basis.lines[0]]}])await assert.rejects(s.quote({...basis,...patch} as typeof basis,policy,address,'ground'),/INVALID_SHIPPING_QUOTE/);
 assert.equal(calls,0);
});
test('adapter errors/timeouts are sanitized, bounded and never retried',async()=>{
 let calls=0;await assert.rejects(service(async()=>{calls++;throw new Error('sensitive provider body');}).quote(basis,policy,address,'ground'),/^Error: SHIPPING_TAX_UNAVAILABLE$/);assert.equal(calls,1);
 let aborted=false;await assert.rejects(service(async(_r,signal)=>{calls++;signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});},()=>1000000,10).quote(basis,policy,address,'ground'),/SHIPPING_TAX_UNAVAILABLE/);assert.equal(aborted,true);assert.equal(calls,2);
});
test('server-retained quote identity rejects any late price/address tampering and expires',async()=>{
 let now=1000000;const s=service(undefined,()=>now),quote=await s.quote(basis,policy,address,'ground');s.assertUnchanged(quote,structuredClone(quote));
 assert.throws(()=>s.assertUnchanged(quote,{...quote,totalMinor:1}),/SHIPPING_QUOTE_CHANGED/);
 assert.throws(()=>s.assertUnchanged(quote,{...quote,request:{...quote.request,shipping:{...quote.request.shipping,address:{...quote.request.shipping.address,postalCode:'10000'}}}}),/SHIPPING_QUOTE_CHANGED/);
 now+=600000;assert.throws(()=>s.assertUnchanged(quote,quote),/SHIPPING_QUOTE_EXPIRED/);
});

test('quote snapshots server input before awaiting adapter and does not trust later source mutation',async()=>{
 let release:()=>void=()=>{},seen:ShippingTaxRequest|undefined;const gate=new Promise<void>(resolve=>{release=resolve;});const mutableBasis=structuredClone(basis),mutableAddress={...address};
 const s=service(async r=>{seen=r;await gate;return answer(r);});const pending=s.quote(mutableBasis,policy,mutableAddress,'ground');
 mutableBasis.lines[0]!.taxCategory='changed';mutableAddress.postalCode='10000';await Promise.resolve();release();const quote=await pending;
 assert.equal(quote.request.shipping.address.postalCode,'17000');assert.equal(seen?.merchandise.lines[0]?.taxCategory,'merchant-configured-category');
});

test('retained quote fingerprints ignore object key order but preserve array/value identity',async()=>{
 const s=service(),quote=await s.quote(basis,policy,address,'ground');
 const reordered=(value:unknown):unknown=>Array.isArray(value)?value.map(reordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,v])=>[key,reordered(v)])):value;
 s.assertUnchanged(quote,reordered(quote) as typeof quote);
 assert.throws(()=>s.assertUnchanged(quote,{...quote,request:{...quote.request,merchandise:{...quote.request.merchandise,lines:Array(1)}}}),/SHIPPING_QUOTE_CHANGED/);
 assert.throws(()=>s.assertUnchanged(quote,{...quote,extra:undefined} as typeof quote),/SHIPPING_QUOTE_CHANGED/);
});

test('unchanged quote survives actual PostgreSQL JSONB key reordering; changed values still reject',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=await PGlite.create();
 try {const s=service(),quote=await s.quote(basis,policy,address,'ground');const row=(await db.query<{quote:typeof quote}>('SELECT $1::jsonb AS quote',[JSON.stringify(quote)])).rows[0]!;s.assertUnchanged(quote,row.quote);assert.throws(()=>s.assertUnchanged(quote,{...row.quote,totalMinor:1500}),/SHIPPING_QUOTE_CHANGED/);} finally {await db.close();}
});

test('merchant and location are trusted configuration and isolate adapter request identity',async()=>{
 const original=await service().quote(basis,policy,address,'ground');
 for(const change of [{merchantId:'other-merchant'},{locationId:'other-location'}]) {
  const s=new ShippingQuoteService({...config,...change},new Map([['fixture',{quote:async (r:ShippingTaxRequest)=>answer(r)}]]),()=>1000000);
  const quote=await s.quote(basis,policy,address,'ground');assert.notEqual(quote.request.requestFingerprint,original.request.requestFingerprint);
 }
});
