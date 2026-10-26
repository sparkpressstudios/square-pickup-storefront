import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { initializeEmptyMerchantCatalog } from '../server/src/merchant-catalog-import';
import { createSquarePromotionService, SquarePromotionError } from '../server/src/square-promotion-preview';
import { createSquareServices } from '../server/src/square-services';
import { createApp } from '../server/src/app';
import type { StaffPrincipal } from '../server/src/admin-catalog';

const settings={
  STARTER_DATASET:'merchant-catalog-v1',
  SQUARE_ENVIRONMENT:'sandbox',SQUARE_SANDBOX_REQUESTS_ENABLED:'true',
  SQUARE_PROMOTIONS_PREVIEW_ENABLED:'true',SQUARE_APPLICATION_ID:'sandbox-sq0idb-testpricing',
  SQUARE_SANDBOX_ACCESS_TOKEN:'fictional-sandbox-token-for-tests',
  SQUARE_SANDBOX_MERCHANT_ID:'TESTMERCHANT',SQUARE_LOCATION_ID:'TESTLOCATION',
};
const items=[{variantId:'variation-1',quantity:2}];
async function freshDatabase(){
  const db=await PGlite.create();
  await initializeEmptyMerchantCatalog(db,{
    squareMerchantId:settings.SQUARE_SANDBOX_MERCHANT_ID,
    squareLocationId:settings.SQUARE_LOCATION_ID,
  });
  await db.query("INSERT INTO catalog_products(id,name,description,category,options) VALUES ('item-1','Fictional tea','Example only','Pantry','[]'::jsonb)");
  await db.query("INSERT INTO catalog_variants(id,product_id,sku,selections,currency,price_minor,stock_quantity,enabled) VALUES ('variation-1','item-1','TEA-BOX','{}'::jsonb,'USD',1500,0,false)");
  await db.query("INSERT INTO merchant_square_item_links(square_item_id,product_id) VALUES ('SQUAREITEM1','item-1')");
  await db.query("INSERT INTO merchant_square_variation_links(square_variation_id,variant_id,square_item_id) VALUES ('SQUAREVAR1','variation-1','SQUAREITEM1')");
  return db;
}
const providerOrder=(overrides:Record<string,unknown>={})=>({
  location_id:'TESTLOCATION',
  line_items:[{catalog_object_id:'SQUAREVAR1',quantity:'2',base_price_money:{amount:1500,currency:'USD'}}],
  gross_sales_money:{amount:3000,currency:'USD'},
  total_discount_money:{amount:300,currency:'USD'},
  total_tax_money:{amount:162,currency:'USD'},
  total_service_charge_money:{amount:0,currency:'USD'},
  total_tip_money:{amount:0,currency:'USD'},
  total_money:{amount:2862,currency:'USD'},
  ...overrides,
});
const reply=(order:unknown,status=200)=>new Response(JSON.stringify({order}),{status});
const denied=(code:SquarePromotionError['code'])=>
  (error:unknown)=>error instanceof SquarePromotionError&&error.code===code;
test('merchant Square variation and catalog pricing rules produce a read-only discounted, taxed quote',async()=>{
  const db=await freshDatabase();
  try{
    let requests=0;
    const fetcher:typeof fetch=async(input,init)=>{
      requests++;
      assert.equal(String(input),'https://connect.squareupsandbox.com/v2/orders/calculate');
      assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
      assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+settings.SQUARE_SANDBOX_ACCESS_TOKEN);
      const payload=JSON.parse(String(init?.body));
      assert.deepEqual(payload,{
        order:{
          location_id:'TESTLOCATION',
          line_items:[{catalog_object_id:'SQUAREVAR1',quantity:'2'}],
          pricing_options:{auto_apply_discounts:true,auto_apply_taxes:true},
        },
      });
      return reply(providerOrder());
    };
    const service=createSquarePromotionService(db,settings,fetcher);
    const choices=await service.variations();
    assert.deepEqual(choices,[{
      variantId:'variation-1',sku:'TEA-BOX',productName:'Fictional tea',unitPriceMinor:1500,
      enabled:false,stockQuantity:0,squareVariationSuffix:'REVAR1',
    }]);
    const quote=await service.quote({items});
    assert.equal(quote.subtotalMinor,3000);
    assert.equal(quote.discountMinor,300);
    assert.equal(quote.taxMinor,162);
    assert.equal(quote.totalMinor,2862);
    assert.equal(quote.checkoutAuthorized,false);
    assert.equal(quote.orderCreated,false);
    assert.equal(quote.inventoryVerified,false);
    assert.equal(quote.paymentDispatched,false);
    assert.match(quote.fingerprint,/^[a-f0-9]{64}$/);
    assert.deepEqual(await service.quote({items}),quote);
    assert.equal(requests,2);
    assert.doesNotMatch(JSON.stringify(quote),/SQUAREVAR1|fictional-sandbox-token/);
    assert.deepEqual((await db.query('SELECT enabled,stock_quantity,price_minor FROM catalog_variants')).rows,[
      {enabled:false,stock_quantity:0,price_minor:1500},
    ]);
  }finally{await db.close();}
});
test('gift-card coverage always reprices against Square and never consumes a card balance',async()=>{
  const db=await freshDatabase();
  try{
    let cardReads=0,priceReads=0;
    const service=createSquarePromotionService(db,{...settings,SQUARE_GIFT_CARDS_READ_ENABLED:'true'},
      async()=>{priceReads++;return reply(providerOrder());},{
        async giftCard(cardId) {
          assert.equal(cardId,'gftc:TESTGIFTCARD1');
          cardReads++;
          return {cardSuffix:'ARD1',state:'ACTIVE',balanceMinor:2000,currency:'USD',redemptionAuthorized:false};
        },
      });
    const coverage=await service.giftCoverage({items},'gftc:TESTGIFTCARD1');
    assert.equal(coverage.totalMinor,2862);
    assert.equal(coverage.giftCardMinor,2000);
    assert.equal(coverage.remainingMinor,862);
    assert.equal(coverage.giftCardRedeemed,false);
    assert.equal(coverage.checkoutAuthorized,false);
    assert.equal(coverage.paymentDispatched,false);
    assert.equal(cardReads,1);assert.equal(priceReads,1);
    await assert.rejects(service.giftCoverage({items,orderTotalMinor:1},'gftc:TESTGIFTCARD1'),denied('INVALID_ITEMS'));
    assert.equal(cardReads,1);assert.equal(priceReads,1);
    const blocked=createSquarePromotionService(db,settings,async()=>reply(providerOrder()),{
      async giftCard(){throw Error('Must not reach provider');},
    });
    await assert.rejects(blocked.giftCoverage({items},'gftc:TESTGIFTCARD1'),denied('FEATURE_DISABLED'));
  }finally{await db.close();}
});

test('no customer-controlled price or unknown merchant variation reaches provider',async()=>{
  const db=await freshDatabase();
  try{
    let called=0;
    const service=createSquarePromotionService(db,settings,async()=>{called++;return reply(providerOrder());});
    for(const invalid of [
      null,{},[],{items:[]},{items:[{variantId:'variation-1',quantity:1,priceMinor:1}]},
      {items:[{variantId:'variation-1',quantity:0}]},{items:[{variantId:'variation-1',quantity:1.1}]},
      {items:[{variantId:'variation-1',quantity:51}]},
      {items:[{variantId:'variation-1',quantity:1},{variantId:'variation-1',quantity:1}]},
      {items:[{variantId:'variation-1',quantity:1}],customer_id:'BAD'},
    ]) await assert.rejects(service.quote(invalid),denied('INVALID_ITEMS'));
    await assert.rejects(service.quote({items:[{variantId:'unregistered',quantity:1}]}),denied('UNMAPPED_VARIATION'));
    assert.equal(called,0);
  }finally{await db.close();}
});
test('seller mismatch and service gate cannot adopt the synthetic or a different merchant database',async()=>{
  const db=await freshDatabase();
  try{
    assert.throws(()=>createSquarePromotionService(db,{...settings,STARTER_DATASET:'synthetic-retail-v1'},fetch),denied('FEATURE_DISABLED'));
    assert.throws(()=>createSquarePromotionService(db,{...settings,SQUARE_ENVIRONMENT:'production'},fetch),denied('FEATURE_DISABLED'));
    assert.throws(()=>createSquarePromotionService(db,{...settings,SQUARE_PROMOTIONS_PREVIEW_ENABLED:'false'},fetch),denied('FEATURE_DISABLED'));
    const different=createSquarePromotionService(db,{...settings,SQUARE_SANDBOX_MERCHANT_ID:'OTHERSELLER'},fetch);
    await assert.rejects(different.variations(),denied('WRONG_MERCHANT'));
    await assert.rejects(different.quote({items}),denied('WRONG_MERCHANT'));
  }finally{await db.close();}
});
test('Square price drift, bad arithmetic, inclusive tax uncertainty and mismatched fulfillment context fail closed',async()=>{
  const db=await freshDatabase();
  try{
    const bad=[
      [providerOrder({location_id:'OTHER'}),'UNVERIFIED_AMOUNT'],
      [providerOrder({line_items:[{catalog_object_id:'SQUAREVAR1',quantity:'2',base_price_money:{amount:1501,currency:'USD'}}]}),'CATALOG_PRICE_MISMATCH'],
      [providerOrder({line_items:[{catalog_object_id:'SQUAREVAR1',quantity:'1',base_price_money:{amount:1500,currency:'USD'}}]}),'CATALOG_PRICE_MISMATCH'],
      [providerOrder({gross_sales_money:{amount:3001,currency:'USD'}}),'UNVERIFIED_AMOUNT'],
      [providerOrder({total_money:{amount:2863,currency:'USD'}}),'UNVERIFIED_AMOUNT'],
      [providerOrder({total_tax_money:{amount:-2,currency:'USD'}}),'UNVERIFIED_AMOUNT'],
      [providerOrder({total_service_charge_money:{amount:50,currency:'USD'}}),'UNVERIFIED_AMOUNT'],
      [providerOrder({total_discount_money:{amount:3000,currency:'USD'}}),'UNVERIFIED_AMOUNT'],
    ] as const;
    for(const [result,code] of bad){
      const service=createSquarePromotionService(db,settings,async()=>reply(result));
      await assert.rejects(service.quote({items}),denied(code));
    }
    await assert.rejects(createSquarePromotionService(db,settings,async()=>reply({},403)).quote({items}),denied('PROVIDER_UNAVAILABLE'));
    await assert.rejects(createSquarePromotionService(db,settings,async()=>{
      throw Error(settings.SQUARE_SANDBOX_ACCESS_TOKEN);
    }).quote({items}),e=>e instanceof SquarePromotionError&&e.code==='PROVIDER_UNAVAILABLE'&&!e.message.includes(settings.SQUARE_SANDBOX_ACCESS_TOKEN));
  }finally{await db.close();}
});
test('existing staff-session origin and CSRF guard restrict all pricing endpoints; no synthetic runtime enables them',async()=>{
  const db=await freshDatabase();
  try{
    const promotion=createSquarePromotionService(db,settings,async()=>reply(providerOrder()));
    const mainServices=createSquareServices(settings,async()=>new Response('{}'));
    let staff:StaffPrincipal|null=null;
    const authOrigin='https://merchant-setup.example.invalid';
    const app=await createApp(undefined,{origin:authOrigin,admin:{verifyStaff:async()=>staff,promotion,squareServices:mainServices}});
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');
    try{
      const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
      assert.equal((await fetch(base+'/api/admin/square-services/promotions/variations')).status,401);
      staff={id:'staff1',role:'manager',csrfToken:'a'.repeat(32)};
      assert.equal((await fetch(base+'/api/admin/square-services/promotions/variations')).status,403);
      staff={id:'admin1',role:'admin',csrfToken:'a'.repeat(32)};
      const caps=await (await fetch(base+'/api/admin/square-services/capabilities')).json();
      assert.equal(caps.promotionsPreview,true);
      const choices=await (await fetch(base+'/api/admin/square-services/promotions/variations')).json();
      assert.equal(choices.variations.length,1);
      const post=(headers:Record<string,string>,body:unknown)=>fetch(base+'/api/admin/square-services/promotions/quote',{
        method:'POST',headers:{'Content-Type':'application/json',Origin:authOrigin,...headers},
        body:JSON.stringify(body),
      });
      assert.equal((await post({}, {items})).status,403);
      assert.equal((await post({'X-CSRF-Token':'a'.repeat(32),Origin:'https://wrong.example'}, {items})).status,403);
      assert.equal((await post({'X-CSRF-Token':'a'.repeat(32)}, {items,customer:'forged'})).status,400);
      const approved=await post({'X-CSRF-Token':'a'.repeat(32)},{items});
      assert.equal(approved.status,200);
      assert.equal((await approved.json()).checkoutAuthorized,false);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }finally{await db.close();}
});
