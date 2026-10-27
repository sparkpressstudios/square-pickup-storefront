import {once} from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {initializeEmptyMerchantCatalog} from '../server/src/merchant-catalog-import';
import {initializeMerchantCommerce} from '../db/merchant-commerce';
import {MerchantCommerce} from '../server/src/merchant-commerce';
import type {MerchantSquareProvider} from '../server/src/merchant-square-provider';
import {ShippingQuoteService} from '../server/src/merchant-shipping-quote';
import {MerchantShippingBuyer} from '../server/src/merchant-shipping-buyer';
import type {ShippingTaxRequest,ShippingPayableQuote} from '../shared/merchant-shipping-quote';
const context={merchantId:'TESTMERCHANT',locationId:'TESTLOCATION'},values={STARTER_DATASET:'merchant-catalog-v1',SQUARE_ENVIRONMENT:'sandbox',SQUARE_APPLICATION_ID:'sandbox-sq0idb-shipping-test',SQUARE_LOCATION_ID:context.locationId,SQUARE_SANDBOX_MERCHANT_ID:context.merchantId,SQUARE_SANDBOX_ACCESS_TOKEN:'unit-private-placeholder',SQUARE_SANDBOX_REQUESTS_ENABLED:'true',SQUARE_MERCHANT_COMMERCE_ENABLED:'true'};
const address={name:'Test Shopper',line1:'123 Fixture Street',city:'Fixture',region:'PA',postalCode:'17000',country:'US'},contact={email:'fixture@example.invalid',phone:'+15555550123'},cart={items:[{productId:'item',variantId:'item-regular',quantity:1}],currency:'USD',fulfillment:'shipping'},policy={enabled:true,revision:'rate-v1',rates:[{id:'ground',label:'Ground',regions:['PA'],amountMinor:500}]},categories={'item-regular':'reviewed-category'};
const money=(amount:number)=>({amount,currency:'USD'});
async function fixture(stock=2){
 const db=await PGlite.create();await initializeEmptyMerchantCatalog(db,{squareMerchantId:context.merchantId,squareLocationId:context.locationId});
 await db.exec("UPDATE merchant_catalog_identity SET inventory_owner='website'; INSERT INTO catalog_products(id,name,description,category,options) VALUES('item','Fixture item','Fixture','Fixture','[]'); INSERT INTO catalog_variants(id,product_id,sku,selections,price_minor) VALUES('item-regular','item','FIXTURE','{}',1000); INSERT INTO merchant_square_item_links(square_item_id,product_id) VALUES('VAR_ITEM','item'); INSERT INTO merchant_square_variation_links(square_variation_id,variant_id,square_item_id) VALUES('VAR','item-regular','VAR_ITEM');");
 await initializeMerchantCommerce(db,values);await db.exec(await readFile(new URL('../db/merchant-shipping-buyer.sql',import.meta.url),'utf8'));
 const pickupProvider={calculate:async(lines:unknown,id:string)=>({checkoutId:id,locationId:context.locationId,lines,subtotalMinor:1000,taxMinor:0,discountMinor:0,totalMinor:1000,currency:'USD',lineEvidence:[{unitPriceMinor:1000,totalMinor:1000}]})} as unknown as MerchantSquareProvider;
 const pickup=new MerchantCommerce(db,pickupProvider,context);await pickup.updateInventory({variantId:'item-regular',quantity:stock,enabled:true,revision:0});await pickup.activate(true);
 let calls=0;const tax=new ShippingQuoteService({...context,adapterId:'fixture',revision:'tax-v1'},new Map([['fixture',{quote:async(r:ShippingTaxRequest)=>({requestFingerprint:r.requestFingerprint,configurationRevision:r.taxConfigurationRevision,reference:'fixture-tax',currency:'USD' as const,merchandiseIncludedTaxMinor:0,merchandiseAdditionalTaxMinor:60,shippingIncludedTaxMinor:0,shippingAdditionalTaxMinor:30,totalMinor:r.merchandise.basisMinor+r.shipping.shippingFeeMinor+90,expiresAt:r.expiresAt})}]]));
 const adapters=new Map([['fixture-v1',{tax,calculate:async(q:ShippingPayableQuote)=>{calls++;return {reference_id:q.id,location_id:context.locationId,total_money:money(q.totalMinor),total_tax_money:money(90),total_discount_money:money(0),total_service_charge_money:money(500),total_tip_money:money(0),line_items:[{uid:'item-regular',quantity:'1',base_price_money:money(1000),total_discount_money:money(0),total_tax_money:money(60),total_money:money(1060)}],service_charges:[{uid:'shipping',scope:'ORDER',calculation_phase:'SUBTOTAL_PHASE',taxable:true,amount_money:money(500),applied_money:money(500),total_tax_money:money(30),total_money:money(530)}]};}}]]);
 const service=new MerchantShippingBuyer(db,context,adapters);
 return {db,pickup,service,configure:()=>service.configure(policy,categories,'fixture-v1'),restart:()=>new MerchantShippingBuyer(db,context,adapters),other:()=>new MerchantShippingBuyer(db,{...context,merchantId:'OTHER'},adapters),calls:()=>calls,stock:async()=>(await db.query<{stock_quantity:number}>("SELECT stock_quantity FROM merchant_commerce_inventory WHERE variant_id='item-regular'")).rows[0]!.stock_quantity};
}
const input=()=>({cart:structuredClone(cart),address:structuredClone(address),rateId:'ground'});
test('buyer shipment quote scopes tokens, reserves once, rejects payment and releases once after restart',async()=>{
 const f=await fixture();try{await assert.rejects(f.service.quote(input()),/SHIPPING_UNCONFIGURED/);await f.configure();const q=await f.service.quote(input());assert.equal(q.paymentExecutionEnabled,false);assert.equal(q.quote.totalMinor,1590);
 await assert.rejects(f.service.status(q.quoteId,'x'.repeat(43)),/SHIPPING_CHECKOUT_NOT_FOUND/);await assert.rejects(f.other().status(q.quoteId,q.checkoutToken),/SHIPPING_CHECKOUT_NOT_FOUND/);await assert.rejects(f.pickup.authorizeCheckout(q.quoteId,q.checkoutToken),/CHECKOUT_NOT_FOUND/);
 const [a,b]=await Promise.all([f.service.prepare(q.quoteId,q.checkoutToken,contact),f.service.prepare(q.quoteId,q.checkoutToken,contact)]);assert.equal(a.state,'reserved');assert.deepEqual(a,b);assert.equal(await f.stock(),1);
 await assert.rejects(f.service.prepare(q.quoteId,q.checkoutToken,{...contact,phone:'+15555550124'}),/SHIPPING_ATTEMPT_CHANGED/);await assert.rejects(f.service.submit(q.quoteId,q.checkoutToken),/SHIPPING_EXECUTION_DISABLED/);assert.equal(await f.stock(),1);assert.equal(f.calls(),1);
 assert.equal((await f.restart().status(q.quoteId,q.checkoutToken)).state,'reserved');await f.restart().cancel(q.quoteId,q.checkoutToken);await f.service.cancel(q.quoteId,q.checkoutToken);assert.equal(await f.stock(),2);assert.equal((await f.service.status(q.quoteId,q.checkoutToken)).state,'canceled');assert.equal((await f.db.query('SELECT * FROM merchant_commerce_attempts')).rows.length,0);
 const saved=JSON.stringify((await f.db.query('SELECT * FROM merchant_shipping_buyer_quotes')).rows);assert.ok(!saved.includes(q.checkoutToken));
 }finally{await f.db.close();}
});
test('pickup and shipping reserve the same final inventory unit without double selling',async()=>{
 const f=await fixture(1);try{await f.configure();const ship=await f.service.quote(input()),pickup=await f.pickup.quote({...cart,fulfillment:'pickup'});
 const results=await Promise.allSettled([f.service.prepare(ship.quoteId,ship.checkoutToken,contact),f.pickup.prepare(pickup.quoteId,{name:'Fixture pickup',...contact})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await f.stock(),0);
 if(results[0]!.status==='fulfilled')await f.service.cancel(ship.quoteId,ship.checkoutToken);else await f.pickup.cancel(pickup.quoteId);assert.equal(await f.stock(),1);
 }finally{await f.db.close();}
});
test('configuration and price revisions refuse preparation; expired reservations restore stock without dispatch',async()=>{
 const f=await fixture();try{await f.configure();const old=await f.service.quote(input());await f.configure();await assert.rejects(f.service.prepare(old.quoteId,old.checkoutToken,contact),/SHIPPING_CONFIGURATION_CHANGED/);assert.equal(await f.stock(),2);
 const price=await f.service.quote(input());await f.db.query("UPDATE catalog_variants SET price_minor=1100 WHERE id='item-regular'");await assert.rejects(f.service.prepare(price.quoteId,price.checkoutToken,contact),/SHIPPING_QUOTE_CHANGED/);await f.db.query("UPDATE catalog_variants SET price_minor=1000 WHERE id='item-regular'");
 const q=await f.service.quote(input());await f.service.prepare(q.quoteId,q.checkoutToken,contact);await f.db.query("UPDATE merchant_shipping_buyer_quotes SET expires_at=now()-interval '1 second' WHERE id=$1",[q.quoteId]);await f.service.expire();await f.service.expire();assert.equal(await f.stock(),2);assert.equal((await f.service.status(q.quoteId,q.checkoutToken)).state,'expired');await assert.rejects(f.service.submit(q.quoteId,q.checkoutToken),/SHIPPING_EXECUTION_DISABLED/);
 }finally{await f.db.close();}
});
test('buyer UI validates scoped identities and never offers a card/pay control',async()=>{
 const {ShippingBuyerPanel,validShippingIdentity}=await import('../client/src/shipping-buyer'),{createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');assert.equal(validShippingIdentity({quoteId:'bad',checkoutToken:'x'.repeat(43)}),false);const html=renderToStaticMarkup(createElement(ShippingBuyerPanel,{items:[],storageKey:'fixture',onLock:()=>{}}));assert.match(html,/cannot create an order, take payment/);assert.doesNotMatch(html,/Pay now|cardToken|Secure Square/);
});

test('actual merchant app keeps shipping absent by default and configured buyer routes enforce origin/token/no payment',async()=>{
 const {createMerchantCommerceApp}=await import('../server/src/merchant-commerce-app'),{merchant}=await import('../config/merchant');
 const f=await fixture();let server:ReturnType<ReturnType<typeof createMerchantCommerceApp>['listen']>|undefined;try{
 const origin='https://fixture.example',env={...values,PUBLIC_ORIGIN:origin,SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY:'fixture-signature-placeholder'},auth={origin,verifyStaff:async()=>null,login:async()=>{throw Error('unused');},logout:async()=>{}};let network=0;const forbidden:typeof fetch=async()=>{network++;throw Error('No provider requests permitted');};
 const start=async(enabled:boolean)=>{server=createMerchantCommerceApp(f.db,env,auth,merchant,forbidden,forbidden,enabled?{shippingBuyer:f.service}:{}).listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;};
 let url=await start(false);const post=(path:string,body:unknown,from=origin)=>fetch(url+'/api/commerce/shipping/'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:from},body:JSON.stringify(body)});
 assert.equal((await post('quote',input())).status,503);assert.equal((await(await fetch(url+'/api/storefront')).json()).shippingDevelopment,false);await new Promise<void>(r=>server!.close(()=>r()));server=undefined;
 await f.configure();url=await start(true);assert.equal((await(await fetch(url+'/api/storefront')).json()).shippingDevelopment,true);assert.equal((await post('quote',input(),'https://evil.invalid')).status,403);assert.equal(f.calls(),0);
 const response=await post('quote',input());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const q=await response.json();const identity={quoteId:q.quoteId,checkoutToken:q.checkoutToken};
 assert.equal((await post('prepare',{...identity,contact,priceMinor:0})).status,409);assert.equal((await post('prepare',{...identity,contact})).status,200);assert.equal((await post('submit',identity)).status,423);assert.equal((await post('submit',{...identity,cardToken:'not-accepted'})).status,409);assert.equal((await post('status',{...identity,checkoutToken:'x'.repeat(43)})).status,404);assert.equal((await post('cancel',identity)).status,200);assert.equal(await f.stock(),2);assert.equal(network,0);
 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await f.db.close();}
});


test('cancel before or competing with first prepare persists a tombstone and leaves no orphaned hold',async()=>{
 const f=await fixture();try{await f.configure();const q=await f.service.quote(input());assert.equal((await f.service.cancel(q.quoteId,q.checkoutToken)).state,'canceled');assert.equal((await f.restart().prepare(q.quoteId,q.checkoutToken,contact)).state,'canceled');assert.equal(await f.stock(),2);
 const next=await f.service.quote(input());await Promise.all([f.service.cancel(next.quoteId,next.checkoutToken),f.service.prepare(next.quoteId,next.checkoutToken,contact)]);assert.equal((await f.service.status(next.quoteId,next.checkoutToken)).state,'canceled');assert.equal(await f.stock(),2);assert.equal((await f.db.query("SELECT * FROM merchant_shipping_buyer_reservations WHERE state='held'")).rows.length,0);
 }finally{await f.db.close();}
});

test('available-stock edits reserve capacity for both shipping and pickup holds so release cannot overflow',async()=>{
 const f=await fixture();const edit=async(quantity:number)=>{const row=(await f.pickup.inventory())[0]!;return f.pickup.updateInventory({variantId:'item-regular',quantity,enabled:true,revision:Number(row.revision)});};try{await f.configure();const ship=await f.service.quote(input());await f.service.prepare(ship.quoteId,ship.checkoutToken,contact);await assert.rejects(edit(1000000),/STOCK_EXCEEDS_CAPACITY/);assert.equal(await f.stock(),1);await edit(999999);await f.service.cancel(ship.quoteId,ship.checkoutToken);assert.equal(await f.stock(),1000000);
 await edit(2);const pickup=await f.pickup.quote({...cart,fulfillment:'pickup'});await f.pickup.prepare(pickup.quoteId,{name:'Fixture pickup',...contact});await assert.rejects(edit(1000000),/STOCK_EXCEEDS_CAPACITY/);await edit(999999);await f.pickup.cancel(pickup.quoteId);assert.equal(await f.stock(),1000000);
 }finally{await f.db.close();}
});
test('present but incompatible optional shipping reservation schema fails stock updates closed',async()=>{
 const f=await fixture();try{await f.db.exec('ALTER TABLE merchant_shipping_buyer_reservations RENAME TO shipping_reservation_history_fixture; CREATE TABLE merchant_shipping_buyer_reservations(unrelated text)');const row=(await f.pickup.inventory())[0]!;await assert.rejects(f.pickup.updateInventory({variantId:'item-regular',quantity:999,enabled:true,revision:Number(row.revision)}));assert.equal(await f.stock(),2);}finally{await f.db.close();}
});

test('temporary relation shadow cannot hide public shipping holds from stock capacity checks',async()=>{
 const f=await fixture();try{await f.configure();const q=await f.service.quote(input());await f.service.prepare(q.quoteId,q.checkoutToken,contact);await f.db.exec("CREATE TEMP TABLE merchant_shipping_buyer_reservations(variant_id text,quantity integer,state text)");const row=(await f.pickup.inventory())[0]!;await assert.rejects(f.pickup.updateInventory({variantId:'item-regular',quantity:1000000,enabled:true,revision:Number(row.revision)}),/STOCK_EXCEEDS_CAPACITY/);await f.service.cancel(q.quoteId,q.checkoutToken);assert.equal(await f.stock(),2);}finally{await f.db.close();}
});

test('merchant settings persist drafts, reject stale writers and keep missing tax fail closed',async()=>{
 const f=await fixture();try{
 const blank=await f.service.settings();assert.equal(blank.revision,0);assert.equal(blank.readiness.taxAdapterConfigured,false);
 const draft={revision:0,enabled:true,rates:policy.rates,taxCategories:{},taxConfigurationId:''};
 const saved=await f.service.saveSettings(draft);assert.equal(saved.revision,1);assert.equal(saved.policy.revision,'1');assert.equal(saved.paymentExecutionEnabled,false);assert.deepEqual(saved.readiness.missingTaxCategories,['item-regular']);
 assert.equal((await f.restart().settings()).revision,1);await assert.rejects(f.service.quote(input()),/SHIPPING_UNCONFIGURED/);assert.equal(f.calls(),0);
 await assert.rejects(f.service.saveSettings(draft),/SHIPPING_SETTINGS_CHANGED/);
 await assert.rejects(f.service.saveSettings({...draft,revision:1,taxConfigurationId:'invented'}),/INVALID_SHIPPING_SETTINGS/);
 await assert.rejects(f.service.saveSettings({...draft,revision:1,taxCategories:{unknown:'category'}}),/INVALID_SHIPPING_SETTINGS/);
 const configured=await f.service.saveSettings({...draft,revision:1,taxConfigurationId:'fixture-v1',taxCategories:categories});assert.equal(configured.revision,2);const q=await f.service.quote(input());
 const changes=await Promise.allSettled([f.service.saveSettings({...draft,revision:2}),f.service.saveSettings({...draft,revision:2})]);assert.equal(changes.filter(x=>x.status==='fulfilled').length,1);assert.equal((await f.service.settings()).revision,3);await assert.rejects(f.service.prepare(q.quoteId,q.checkoutToken,contact),/SHIPPING_UNCONFIGURED|SHIPPING_CONFIGURATION_CHANGED/);assert.equal(await f.stock(),2);
 await assert.rejects(f.other().settings(),/SHIPPING_CONTEXT_MISMATCH/);
 }finally{await f.db.close();}
});

test('shipping settings HTTP requires admin session, origin and CSRF; absent service fails closed',async()=>{
 const express=(await import('express')).default,{adminCatalogRouter}=await import('../server/src/admin-catalog');const f=await fixture();let role='admin',signedIn=true;const app=express();app.use('/absent',adminCatalogRouter({verifyStaff:async()=>({id:'fixture',role:'admin',csrfToken:'fixture-csrf-valid-token'})}));app.use('/api/admin',adminCatalogRouter({origin:'https://fixture.invalid',shippingBuyer:f.service,verifyStaff:async()=>signedIn?{id:'fixture',role:role as 'admin',csrfToken:'fixture-csrf-valid-token'}:null}));const server=app.listen(0);await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/admin/shipping/settings`;
 const post=(body:unknown,csrf='fixture-csrf-valid-token',origin='https://fixture.invalid')=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Origin':origin,'X-CSRF-Token':csrf},body:JSON.stringify(body)});
 try{assert.equal((await fetch(url.replace('/api/admin/shipping/settings','/absent/shipping/settings'))).status,503);signedIn=false;assert.equal((await fetch(url)).status,401);signedIn=true;role='manager';assert.equal((await fetch(url)).status,403);role='admin';const draft={revision:0,enabled:false,rates:[],taxCategories:{},taxConfigurationId:''};assert.equal((await post(draft,'wrong')).status,403);assert.equal((await post(draft,'fixture-csrf-valid-token','https://evil.invalid')).status,403);const r=await post(draft);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await post(draft)).status,409);const regions='AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');const large={...draft,revision:1,rates:Array.from({length:20},(_,i)=>({id:'r'.repeat(35)+i,label:'Rate label '.repeat(7),regions,amountMinor:100}))};assert.ok(JSON.stringify(large).length>8192);assert.equal((await post(large)).status,200);assert.equal(f.calls(),0);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await f.db.close();}
});
