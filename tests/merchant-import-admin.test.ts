import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/src/app';
import type { StaffPrincipal } from '../server/src/admin-catalog';
import { MerchantImportPanel } from '../client/src/merchant-import-panel';
import { AdminLayout } from '../client/src/admin';
import { MerchantImportSetupError, createSquareMerchantImportAdministration, type MerchantImportAdministration } from '../server/src/merchant-import-service';
import { initializeEmptyMerchantCatalog } from '../server/src/merchant-catalog-import';

const origin = 'https://commerce-starter-test.example.invalid';
const token = 'a-test-only-csrf-token-at-least-16-bytes';
const fingerprint = 'a'.repeat(64);
const status = { mode: 'fresh-merchant-database' as const, checkoutEnabled: false as const,
  inventoryOwner: 'unassigned' as const, productCount: 0, batches: [] };
const review = { fingerprint, state: 'staged' as const, reused: false, reviewHolds: 0, productCount: 1,
  variantCount: 1, inventoryOwner: 'square' as const, checkoutEnabled: false as const,
  products: [{ squareItemId: 'SQUARE1', name: 'Candle', category: 'Retail',
    variations: [{ squareVariationId: 'VAR1', sku: 'TEST-1', priceMinor: 1200, stockQuantity: 0 as const, enabled: false as const }] }],
  note: 'Review only. No checkout or stock activation.' as const };
async function withApp(
  service: MerchantImportAdministration | undefined,
  testRun: (url: string, principal: (next: StaffPrincipal | null) => void) => Promise<void>,
) {
  let identity: StaffPrincipal | null = null;
  const app = await createApp(undefined, { origin, admin: { merchantImport: service, verifyStaff: async () => identity } });
  const server = app.listen(0, '127.0.0.1'); await once(server,'listening');
  const local = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try { await testRun(local, next => { identity = next; }); }
  finally { await new Promise<void>(done => server.close(() => done())); }
}
async function post(url: string, body: unknown, headers: Record<string,string> = {}) {
  return fetch(url,{method:'POST',headers:{Origin:origin,'X-CSRF-Token':token,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
}
const admin: StaffPrincipal = { id:'verified-admin', role:'admin', csrfToken:token };

test('the synthetic admin preview advertises import limitations but renders no import action', () => {
  const html = renderToStaticMarkup(createElement(MerchantImportPanel,{preview:true,role:'',enabled:false,csrfToken:''}));
  assert.match(html,/synthetic admin preview/);
  assert.match(html,/zero stock/);
  assert.doesNotMatch(html,/Commit disabled products|Fetch & stage Square catalog/);
  const layout = renderToStaticMarkup(createElement(AdminLayout,{path:'/admin/preview/import',root:'/admin/preview',navigate:()=>{},preview:true,children:'Import'}));
  assert.match(layout,/Import products/);
  assert.match(layout,/aria-current="page">Import products/);
});
test('default live merchant import routes stay closed without configured verifier and database',async()=>{
  await withApp(undefined,async url=>{
    const denied=await fetch(url+'/api/admin/merchant-import/status',{headers:{'X-Role':'admin',Authorization:'Bearer not-real'}});
    assert.equal(denied.status,401);
    assert.equal(denied.headers.get('cache-control'),'no-store');
  });
  await withApp(undefined,async(url,principal)=>{
    principal(admin);
    assert.equal((await fetch(url+'/api/admin/merchant-import/status')).status,503);
    const session=await (await fetch(url+'/api/admin/session')).json();
    assert.equal(session.merchantImportEnabled,false);
  });
});
test('only verified administrators with same-origin CSRF can stage, inspect and commit one exact fingerprint',async()=>{
  const calls: string[]=[];
  const mock:MerchantImportAdministration={
    status:async()=>{calls.push('status');return status;},
    stage:async(owner)=>{calls.push('stage:'+owner);return review;},
    inspect:async(id)=>{calls.push('inspect:'+id);return review;},
    commit:async(id,actor,approval)=>{calls.push('commit:'+id+':'+actor+':'+approval);return{...review,state:'committed',reused:false};},
  };
  await withApp(mock,async(url,principal)=>{
    let response=await fetch(url+'/api/admin/merchant-import/status',{headers:{'X-Role':'admin'}});
    assert.equal(response.status,401);assert.deepEqual(calls,[]);
    principal({id:'manager',role:'manager',csrfToken:token});
    assert.equal((await fetch(url+'/api/admin/merchant-import/status')).status,403);
    assert.equal((await post(url+'/api/admin/merchant-import/stage',{inventoryOwner:'square'})).status,403);
    principal(admin);
    const session=await (await fetch(url+'/api/admin/session')).json();
    assert.equal(session.merchantImportEnabled,true);
    response=await fetch(url+'/api/admin/merchant-import/status');
    assert.equal(response.status,200);assert.equal((await response.json()).checkoutEnabled,false);
    const deniedHeaders: Record<string, string>[]=[{'X-CSRF-Token':'bad-token'},{Origin:'https://untrusted.invalid'},{Origin:''},{'X-CSRF-Token':''}];
    for(const headers of deniedHeaders)assert.equal((await post(url+'/api/admin/merchant-import/stage',{inventoryOwner:'square'},headers)).status,403);
    for(const payload of [{inventoryOwner:'square',role:'admin'},{inventoryOwner:'other'},null,[],{inventoryOwner:'website',fingerprint}])
      assert.equal((await post(url+'/api/admin/merchant-import/stage',payload)).status,400);
    assert.deepEqual(calls,['status']);
    response=await post(url+'/api/admin/merchant-import/stage',{inventoryOwner:'square'});
    assert.equal(response.status,200);assert.equal((await response.json()).fingerprint,fingerprint);
    response=await fetch(url+'/api/admin/merchant-import/batches/'+fingerprint);
    assert.equal(response.status,200);assert.equal((await response.json()).products[0].variations[0].enabled,false);
    response=await post(url+'/api/admin/merchant-import/batches/'+fingerprint+'/commit',{approval:'yes'});
    assert.equal(response.status,400);
    response=await post(url+'/api/admin/merchant-import/batches/'+fingerprint+'/commit',{approval:'approve-disabled-merchant-import-v1',role:'admin'});
    assert.equal(response.status,400);
    response=await post(url+'/api/admin/merchant-import/batches/'+fingerprint+'/commit',{approval:'approve-disabled-merchant-import-v1'});
    assert.equal(response.status,200);assert.equal((await response.json()).checkoutEnabled,false);
    assert.deepEqual(calls,[
      'status','stage:square','inspect:'+fingerprint,
      'commit:'+fingerprint+':verified-admin:approve-disabled-merchant-import-v1',
    ]);
  });
});
const settings={
  STARTER_DATASET:'merchant-catalog-v1',
  SQUARE_ENVIRONMENT:'sandbox',SQUARE_SANDBOX_REQUESTS_ENABLED:'true',
  SQUARE_APPLICATION_ID:'sandbox-sq0idb-synthetic-app',
  SQUARE_LOCATION_ID:'TESTLOCATION1',
  SQUARE_SANDBOX_MERCHANT_ID:'TEST_MERCHANT_1',
  SQUARE_SANDBOX_ACCESS_TOKEN:'synthetic-sandbox-access-token',
};
test('merchant staging verifies seller and commits a disabled catalog on a separate fresh database with replay safety',async()=>{
  const db=await PGlite.create();
  const identity={squareMerchantId:settings.SQUARE_SANDBOX_MERCHANT_ID,squareLocationId:settings.SQUARE_LOCATION_ID};
  try{
    await initializeEmptyMerchantCatalog(db,identity);
    const urls:string[]=[];
    const provider:typeof fetch=async(url,init)=>{
      const path=new URL(String(url)).pathname;
      urls.push(path);
      assert.equal(new URL(String(url)).origin,'https://connect.squareupsandbox.com');
      assert.equal(init?.method,'GET');
      assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+settings.SQUARE_SANDBOX_ACCESS_TOKEN);
      if(path==='/v2/merchants')return new Response(JSON.stringify({merchant:[{id:identity.squareMerchantId}]}));
      if(path==='/v2/locations')return new Response(JSON.stringify({locations:[{id:identity.squareLocationId,merchant_id:identity.squareMerchantId}]}));
      if(path==='/v2/catalog/list')return new Response(JSON.stringify({objects:[{
        type:'ITEM',id:'SQ_ITEM_1',present_at_all_locations:true,
        item_data:{name:'Imported tea',description:'Synthetic boxed tea',variations:[{
          id:'SQ_VAR_1',type:'ITEM_VARIATION',present_at_all_locations:true,
          item_variation_data:{name:'Regular',sku:'TEST-TEA',pricing_type:'FIXED_PRICING',price_money:{amount:1100,currency:'USD'}},
        }]},
      }]}));
      throw new Error('Unexpected Square URL');
    };
    const service=createSquareMerchantImportAdministration(db,settings,provider);
    await withApp(service,async(url,principal)=>{
      principal(admin);
      let response=await post(url+'/api/admin/merchant-import/stage',{inventoryOwner:'square'});
      assert.equal(response.status,200);
      let staged=await response.json();
      assert.equal(staged.productCount,1);assert.equal(staged.checkoutEnabled,false);
      assert.equal(staged.products[0].variations[0].stockQuantity,0);
      assert.deepEqual(urls,['/v2/merchants','/v2/locations','/v2/catalog/list']);
      response=await post(url+'/api/admin/merchant-import/stage',{inventoryOwner:'square'});
      assert.equal(response.status,200);const retry=await response.json();assert.equal(retry.fingerprint,staged.fingerprint);
      assert.equal((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM merchant_catalog_import_batches')).rows[0]?.count,1);
      response=await post(url+'/api/admin/merchant-import/batches/'+staged.fingerprint+'/commit',
        {approval:'approve-disabled-merchant-import-v1'});
      assert.equal(response.status,200);assert.equal((await response.json()).state,'committed');
      response=await post(url+'/api/admin/merchant-import/batches/'+staged.fingerprint+'/commit',
        {approval:'approve-disabled-merchant-import-v1'});
      assert.equal(response.status,200);assert.equal((await response.json()).reused,true);
      assert.deepEqual((await db.query('SELECT enabled,stock_quantity FROM catalog_variants')).rows,[{enabled:false,stock_quantity:0}]);
      assert.equal((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM catalog_products')).rows[0]?.count,1);
      const after=await (await fetch(url+'/api/admin/merchant-import/status')).json();
      assert.equal(after.productCount,1);assert.equal(after.inventoryOwner,'square');
      assert.equal(after.checkoutEnabled,false);
      assert.equal(after.batches[0].state,'committed');
    });
    assert.equal(urls.filter(x=>x==='/v2/catalog/list').length,2);
  }finally{await db.close();}
});
test('setup and merchant association must fail closed, never importing under a mismatched seller',async()=>{
  const db=await PGlite.create();
  const identity={squareMerchantId:settings.SQUARE_SANDBOX_MERCHANT_ID,squareLocationId:settings.SQUARE_LOCATION_ID};
  try{
    await initializeEmptyMerchantCatalog(db,identity);
    assert.throws(()=>createSquareMerchantImportAdministration(db,{...settings,STARTER_DATASET:'synthetic-retail-v1'},fetch),
      (e:unknown)=>e instanceof MerchantImportSetupError&&e.code==='IMPORT_CONFIGURATION');
    const wrong:typeof fetch=async(url)=>{
      const path=new URL(String(url)).pathname;
      if(path==='/v2/merchants')return new Response(JSON.stringify({merchant:[{id:'ANOTHER_MERCHANT'}]}));
      throw new Error('No location/catalog should be fetched');
    };
    const service=createSquareMerchantImportAdministration(db,settings,wrong);
    await withApp(service,async(url,principal)=>{
      principal(admin);
      const res=await post(url+'/api/admin/merchant-import/stage',{inventoryOwner:'square'});
      assert.equal(res.status,503);
      assert.equal((await res.json()).error.code,'SELLER_UNVERIFIED');
    });
    assert.equal((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM merchant_catalog_import_batches')).rows[0]?.count,0);
  }finally{await db.close();}
});
