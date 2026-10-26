import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/src/app';
import { initializeEmptyMerchantCatalog } from '../server/src/merchant-catalog-import';
import { createMerchantStaffAuth, provisionInitialMerchantAdmin } from '../server/src/merchant-staff-auth';
import { createSquareMerchantImportAdministration } from '../server/src/merchant-import-service';

test('merchant-only setup runs real staff cookie, Square import review and disabled commit without checkout routes',async()=>{
  const values={
    STARTER_DATASET:'merchant-catalog-v1',PUBLIC_ORIGIN:'https://merchant-setup.example.invalid',
    SQUARE_SANDBOX_MERCHANT_ID:'SANDBOXMERCHANT',SQUARE_LOCATION_ID:'SANDBOXLOCATION',
    MERCHANT_ADMIN_SESSION_KEY:Buffer.alloc(32,13).toString('base64url'),
    SQUARE_ENVIRONMENT:'sandbox',SQUARE_SANDBOX_REQUESTS_ENABLED:'true',
    SQUARE_APPLICATION_ID:'sandbox-sq0idb-unit-fixture',
    SQUARE_SANDBOX_ACCESS_TOKEN:'synthetic-unit-fixture-access-token',
  };
  const db=await PGlite.create();
  try {
    await initializeEmptyMerchantCatalog(db,{
      squareMerchantId:values.SQUARE_SANDBOX_MERCHANT_ID,squareLocationId:values.SQUARE_LOCATION_ID,
    });
    await provisionInitialMerchantAdmin(db,values,'Long-Fictional-Password-For-Isolated-Tests');
    const auth=await createMerchantStaffAuth(db,values);
    const requested:string[]=[];
    const provider:typeof fetch=async(url)=>{
      const path=new URL(String(url)).pathname;
      requested.push(path);
      if(path==='/v2/merchants')return new Response(JSON.stringify({merchant:[{id:values.SQUARE_SANDBOX_MERCHANT_ID}]}));
      if(path==='/v2/locations')return new Response(JSON.stringify({locations:[{
        id:values.SQUARE_LOCATION_ID,merchant_id:values.SQUARE_SANDBOX_MERCHANT_ID,
      }]}));
      if(path==='/v2/catalog/list')return new Response(JSON.stringify({objects:[{
        type:'ITEM',id:'TEST_ITEM',present_at_all_locations:true,
        item_data:{name:'Boxed tea',description:'Synthetic test item',variations:[{
          type:'ITEM_VARIATION',id:'TEST_VARIANT',present_at_all_locations:true,
          item_variation_data:{name:'Regular',sku:'TEST-TEA',pricing_type:'FIXED_PRICING',price_money:{
            amount:1234,currency:'USD',
          }},
        }]},
      }]}));
      throw new Error('Unexpected Square path');
    };
    const importer=createSquareMerchantImportAdministration(db,values,provider);
    const app=await createApp({load:async()=>({currency:'USD',products:[]})},{
      origin:values.PUBLIC_ORIGIN,setupOnly:true,merchantAuth:auth,
      admin:{merchantImport:importer},
    });
    const server=app.listen(0,'127.0.0.1');
    await once(server,'listening');
    try {
      const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
      assert.equal((await fetch(base+'/api/storefront')).status,404);
      const before=await fetch(base+'/api/admin/merchant-import/status');
      assert.equal(before.status,401);
      const login=await fetch(base+'/api/merchant-auth/login',{
        method:'POST',headers:{Origin:values.PUBLIC_ORIGIN,'Content-Type':'application/json'},
        body:JSON.stringify({password:'Long-Fictional-Password-For-Isolated-Tests'}),
      });
      assert.equal(login.status,200);
      const cookie=(login.headers.get('set-cookie')||'').split(';')[0]!;
      const staff=await (await fetch(base+'/api/admin/session',{headers:{Cookie:cookie}})).json();
      assert.equal(staff.role,'admin');assert.equal(staff.merchantImportEnabled,true);
      const route=(path:string, body:unknown)=>fetch(base+path,{
        method:'POST',headers:{Origin:values.PUBLIC_ORIGIN,'Content-Type':'application/json',
          'X-CSRF-Token':staff.csrfToken,Cookie:cookie},
        body:JSON.stringify(body),
      });
      const staged=await route('/api/admin/merchant-import/stage',{inventoryOwner:'square'});
      assert.equal(staged.status,200);const draft=await staged.json();
      assert.equal(draft.productCount,1);assert.equal(draft.checkoutEnabled,false);
      const commitPath='/api/admin/merchant-import/batches/'+draft.fingerprint+'/commit';
      const receipt=await route(commitPath,{approval:'approve-disabled-merchant-import-v1'});
      assert.equal(receipt.status,200);assert.equal((await receipt.json()).checkoutEnabled,false);
      const replay=await route(commitPath,{approval:'approve-disabled-merchant-import-v1'});
      assert.equal(replay.status,200);assert.equal((await replay.json()).reused,true);
      assert.deepEqual((await db.query('SELECT enabled,stock_quantity FROM catalog_variants')).rows,
        [{enabled:false,stock_quantity:0}]);
      assert.equal((await fetch(base+'/api/demo/quote')).status,404);
      assert.equal((await fetch(base+'/api/sandbox/checkout')).status,404);
    }finally{await new Promise<void>(done=>server.close(()=>done()));}
    assert.deepEqual(requested,['/v2/merchants','/v2/locations','/v2/catalog/list']);
  }finally{await db.close();}
});
