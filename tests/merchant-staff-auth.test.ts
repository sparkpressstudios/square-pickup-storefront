import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { initializeEmptyMerchantCatalog } from '../server/src/merchant-catalog-import';
import { createMerchantStaffAuth, MerchantAuthError, provisionInitialMerchantAdmin,
  merchantSessionCookieName } from '../server/src/merchant-staff-auth';
import { createApp } from '../server/src/app';
import { migrateSyntheticDatabase } from '../db/migrate';
import { MerchantLoginPanel } from '../client/src/merchant-login-panel';

const settings = {
  STARTER_DATASET: 'merchant-catalog-v1',
  PUBLIC_ORIGIN: 'https://merchant-commerce.example.invalid',
  SQUARE_SANDBOX_MERCHANT_ID: 'SANDBOXMERCHANT',
  SQUARE_LOCATION_ID: 'SANDBOXLOCATION',
  MERCHANT_ADMIN_SESSION_KEY: Buffer.alloc(32, 11).toString('base64url'),
};
const identity = { squareMerchantId: settings.SQUARE_SANDBOX_MERCHANT_ID, squareLocationId: settings.SQUARE_LOCATION_ID };
const correct = 'A-Very-Long-Fictional-Password-Not-Real-2026';
const errorCode = (value: MerchantAuthError['code']) =>
  (error: unknown) => error instanceof MerchantAuthError && error.code === value;
async function merchant() {
  const db = await PGlite.create();
  await initializeEmptyMerchantCatalog(db, identity);
  return db;
}
async function http(app: Awaited<ReturnType<typeof createApp>>, run: (base: string)=>Promise<void>) {
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  try { await run('http://127.0.0.1:'+(server.address() as AddressInfo).port); }
  finally { await new Promise<void>(done=>server.close(()=>done())); }
}
const post = (url:string, body:unknown, extra:Record<string,string>={}) =>
  fetch(url,{method:'POST',headers:{Origin:settings.PUBLIC_ORIGIN,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
function extractCookie(response: Response) {
  const header = response.headers.get('set-cookie') ?? '';
  assert.match(header,/__Host-merchant_session=/);
  assert.match(header,/HttpOnly/i);assert.match(header,/Secure/i);assert.match(header,/SameSite=Strict/i);
  assert.match(header,/Path=\//i);assert.match(header,/Max-Age=28800/i);
  const value = header.split(';')[0]!;
  assert.match(value,new RegExp('^'+merchantSessionCookieName+'=[A-Za-z0-9_-]{43}$'));
  return value;
}

test('no merchant admin is seeded by fresh schema; explicit provisioning requires strong password and correct dataset',async()=>{
  const db=await merchant();
  try {
    assert.equal((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM merchant_staff_accounts')).rows[0]?.count,0);
    await assert.rejects(provisionInitialMerchantAdmin(db,settings,'too short'),errorCode('INVALID_PASSWORD_POLICY'));
    await assert.rejects(createMerchantStaffAuth(db,{...settings,MERCHANT_ADMIN_SESSION_KEY:'short'}),errorCode('AUTH_NOT_CONFIGURED'));
    await assert.rejects(createMerchantStaffAuth(db,{...settings,PUBLIC_ORIGIN:'http://insecure.example'}),errorCode('AUTH_NOT_CONFIGURED'));
    await assert.rejects(createMerchantStaffAuth(db,{...settings,SQUARE_LOCATION_ID:'WRONGLOCATION'}),errorCode('MERCHANT_SCOPE_REJECTED'));
    await provisionInitialMerchantAdmin(db,settings,correct);
    await assert.rejects(provisionInitialMerchantAdmin(db,settings,correct),errorCode('ALREADY_PROVISIONED'));
    const rows=(await db.query<{id:string;role:string;password_salt:string;password_digest:string}>(
      'SELECT id,role,password_salt,password_digest FROM merchant_staff_accounts')).rows;
    assert.equal(rows.length,1);assert.equal(rows[0]?.role,'admin');
    assert.equal(rows[0]?.id,'merchant-admin');
    assert.notEqual(rows[0]?.password_digest,correct);
    assert.doesNotMatch(JSON.stringify(rows),/Fictional-Password/);
    assert.equal((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM merchant_staff_sessions')).rows[0]?.count,0);
  } finally { await db.close(); }
  const synthetic=await PGlite.create();
  try {
    await migrateSyntheticDatabase(synthetic);
    await assert.rejects(provisionInitialMerchantAdmin(synthetic,settings,correct),errorCode('MERCHANT_SCOPE_REJECTED'));
    await assert.rejects(createMerchantStaffAuth(synthetic,settings),errorCode('MERCHANT_SCOPE_REJECTED'));
    const original=(await synthetic.query<{dataset:string}>('SELECT dataset FROM demo_database_state')).rows;
    assert.deepEqual(original,[{dataset:'synthetic-retail-v1'}]);
  }finally{await synthetic.close();}
});

test('secure cookie sign-in, staff verifier, CSRF logout and session revocation work without ever writing checkout data',async()=>{
  const db=await merchant();
  try {
    await provisionInitialMerchantAdmin(db,settings,correct);
    const auth=await createMerchantStaffAuth(db,settings);
    const app=await createApp(undefined,{origin:settings.PUBLIC_ORIGIN,setupOnly:true,merchantAuth:auth});
    await http(app,async base=>{
      const status=await (await fetch(base+'/api/merchant-auth/status')).json();
      assert.equal(status.enabled,true);assert.equal(status.productionCheckoutEnabled,false);
      assert.equal((await fetch(base+'/api/storefront')).status,404);
      assert.equal((await post(base+'/api/demo/quote',{items:[]})).status,404);
      assert.equal((await fetch(base+'/api/admin/session',{headers:{'X-Role':'admin'}})).status,401);
      assert.equal((await post(base+'/api/merchant-auth/login',{password:correct},{Origin:'https://wrong.example'})).status,403);
      assert.equal((await post(base+'/api/merchant-auth/login',{password:correct,role:'admin'})).status,400);
      assert.equal((await post(base+'/api/merchant-auth/login',{password:'short'})).status,401);
      const login=await post(base+'/api/merchant-auth/login',{password:correct});
      assert.equal(login.status,200);
      const cookie=extractCookie(login);
      const body=await login.json();
      assert.equal(body.role,'admin');assert.equal(body.expiresInSeconds,8*3600);
      assert.equal(JSON.stringify(body).includes(correct),false);
      const session=await fetch(base+'/api/admin/session',{headers:{Cookie:cookie,'X-Role':'staff'}});
      assert.equal(session.status,200);
      const staff=await session.json();
      assert.equal(staff.role,'admin');assert.match(staff.csrfToken,/^[A-Za-z0-9_-]{43}$/);
      assert.equal(staff.merchantImportEnabled,false);
      assert.equal((await fetch(base+'/api/admin/merchant-import/status',{headers:{Cookie:cookie}})).status,503);
      assert.equal((await post(base+'/api/merchant-auth/logout',{}, {Cookie:cookie,'X-CSRF-Token':'bad'})).status,403);
      assert.equal((await post(base+'/api/merchant-auth/logout',{}, {Cookie:cookie,'X-CSRF-Token':staff.csrfToken,Origin:'https://foreign.invalid'})).status,403);
      const logout=await post(base+'/api/merchant-auth/logout',{}, {Cookie:cookie,'X-CSRF-Token':staff.csrfToken});
      assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie')||'',/Expires=Thu, 01 Jan 1970/i);
      assert.equal((await fetch(base+'/api/admin/session',{headers:{Cookie:cookie}})).status,401);
      assert.equal((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM merchant_staff_sessions')).rows[0]?.count,0);
      const catalog=(await db.query<{count:number}>("SELECT count(*)::integer AS count FROM catalog_products")).rows[0]?.count;
      assert.equal(catalog,0);
    });
    await assert.rejects(createApp(undefined,{origin:settings.PUBLIC_ORIGIN,setupOnly:true,merchantAuth:auth,admin:{verifyStaff:async()=>null}}),/unambiguous staff verifier/);
  }finally{await db.close();}
});

test('repeated incorrect passwords lock out authentication and expire rather than making sessions',async()=>{
  const db=await merchant();
  try{
    await provisionInitialMerchantAdmin(db,settings,correct);
    const auth=await createMerchantStaffAuth(db,settings);
    const app=await createApp(undefined,{origin:settings.PUBLIC_ORIGIN,setupOnly:true,merchantAuth:auth});
    await http(app,async base=>{
      for (let i=0;i<5;i++){
        const response=await post(base+'/api/merchant-auth/login',{password:'Other-Fictional-Incorrect-Password'});
        assert.equal(response.status,401);
        assert.equal((await response.json()).error.code,'INVALID_CREDENTIALS');
      }
      const limited=await post(base+'/api/merchant-auth/login',{password:correct});
      assert.equal(limited.status,429);
      assert.equal(limited.headers.get('retry-after'),'900');
      assert.equal((await db.query<{failed_attempts:number}>('SELECT failed_attempts FROM merchant_staff_accounts')).rows[0]?.failed_attempts,5);
      assert.equal((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM merchant_staff_sessions')).rows[0]?.count,0);
      await db.query("UPDATE merchant_staff_accounts SET failed_attempts=0, locked_until=now()-interval '1 second'");
      const allowed=await post(base+'/api/merchant-auth/login',{password:correct});
      assert.equal(allowed.status,200);
      const cookie=extractCookie(allowed);
      assert.equal((await fetch(base+'/api/admin/session',{headers:{Cookie:cookie+'; '+cookie}})).status,401);
      assert.equal((await fetch(base+'/api/admin/session',{headers:{Cookie:cookie.replace(/=(.)/,'=!')}})).status,401);
      await db.query("UPDATE merchant_staff_sessions SET created_at=now()-interval '9 hours', expires_at=now()-interval '1 second'");
      assert.equal((await fetch(base+'/api/admin/session',{headers:{Cookie:cookie}})).status,401);
      assert.equal((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM merchant_staff_sessions')).rows[0]?.count,1);
    });
  }finally{await db.close();}
});

test('pilot has no self-provisioning login and sign-in form is not offered until auth is connected',async()=>{
  const app=await createApp();
  await http(app,async base=>{
    const status=await (await fetch(base+'/api/merchant-auth/status')).json();
    assert.equal(status.enabled,false);
    assert.equal((await post(base+'/api/merchant-auth/login',{password:correct})).status,503);
    assert.equal((await fetch(base+'/api/admin/session',{headers:{'X-Role':'admin'}})).status,401);
  });
  const markup=renderToStaticMarkup(createElement(MerchantLoginPanel,{onSignedIn:()=>{}}));
  assert.match(markup,/Checking merchant sign-in configuration/);
  assert.doesNotMatch(markup,/type="password"/);
});
