import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {initializeEmptyMerchantCatalog} from '../server/src/merchant-catalog-import';
import {initializeMerchantCommerce} from '../db/merchant-commerce';
import {assertMerchantDatabaseSchema} from '../db/native-merchant-database';
import {initializeMerchantEmail,assertMerchantEmailSchema} from '../db/merchant-email';
import {createMerchantEmailService} from '../server/src/merchant-email';
import {merchantEmailConfiguration} from '../server/src/merchant-email-config';
const base={STARTER_DATASET:'merchant-catalog-v1',SQUARE_MERCHANT_COMMERCE_ENABLED:'true',SQUARE_ENVIRONMENT:'sandbox',SQUARE_SANDBOX_REQUESTS_ENABLED:'true',SQUARE_APPLICATION_ID:'sandbox-sq0idb-email-fixture',SQUARE_LOCATION_ID:'EMAILLOCATION',SQUARE_SANDBOX_MERCHANT_ID:'EMAILMERCHANT',SQUARE_SANDBOX_ACCESS_TOKEN:'injected-square-private-token',SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY:'injected-square-signature',MERCHANT_EMAIL_ENABLED:'true',MERCHANT_EMAIL_PROVIDER:'resend',MERCHANT_EMAIL_FROM:'orders@example.com',MERCHANT_EMAIL_RESEND_API_KEY:'re_injected_private_email_key',MERCHANT_EMAIL_SANDBOX_RECIPIENT:'sandbox-qa@example.com'};
const acceptedId='123e4567-e89b-42d3-a456-426614174000';
async function fixture(t:test.TestContext){
 const db=await PGlite.create();t.after(()=>db.close());const values={...base,MERCHANT_EMAIL_ACTIVATED_AT:new Date(Date.now()-1000).toISOString()};
 await initializeEmptyMerchantCatalog(db,{squareMerchantId:base.SQUARE_SANDBOX_MERCHANT_ID,squareLocationId:base.SQUARE_LOCATION_ID});await initializeMerchantCommerce(db,{...values,MERCHANT_EMAIL_ENABLED:'false'});
 await initializeMerchantEmail(db,values);return {db,values};
}
async function order(db:PGlite,state='completed',createdAt?:string){
 const id=randomUUID();
 await db.query("INSERT INTO merchant_commerce_quotes(id,pricing,cart,expires_at,line_snapshot) VALUES($1,$2::jsonb,'{}',now()+interval '10 minutes',$3::jsonb)",[id,JSON.stringify({currency:'USD',totalMinor:191}),JSON.stringify([{name:'Test <item>',variation:'One',quantity:1}])]);
 const needsOrder=['order_ready','payment_sending','pending','completed'].includes(state),needsPayment=['pending','completed'].includes(state);
 await db.query("INSERT INTO merchant_commerce_attempts(id,pickup,state,order_id,order_evidence,payment_id,payment_evidence,created_at) VALUES($1,$2::jsonb,$3,$4,$5::jsonb,$6,$7::jsonb,COALESCE($8::timestamptz,now()))",[id,JSON.stringify({name:'PRIVATE_NAME_CANARY',email:'real-customer@example.com',phone:'+12025550100'}),state,needsOrder?'ORDER_'+id:null,needsOrder?'{}':null,needsPayment?'PAYMENT_'+id:null,needsPayment?'{}':null,createdAt??null]);return id;
}
test('disabled email has no DB/provider/credential dependency and malformed enabled configuration fails closed',()=>{
 const db={query(){throw new Error('must not touch db');}} as any;assert.equal(createMerchantEmailService(db,{}),undefined);assert.equal(merchantEmailConfiguration({MERCHANT_EMAIL_ENABLED:'false'}),undefined);
 const values={...base,MERCHANT_EMAIL_ACTIVATED_AT:new Date().toISOString()};
 for(const change of [{MERCHANT_EMAIL_PROVIDER:'smtp'},{MERCHANT_EMAIL_SANDBOX_RECIPIENT:undefined},{MERCHANT_EMAIL_FROM:'bad\nheader@example.com'},{MERCHANT_EMAIL_ACTIVATED_AT:'invalid'},{MERCHANT_EMAIL_RESEND_API_KEY:'bad'},{SQUARE_ENVIRONMENT:'production'}])assert.throws(()=>merchantEmailConfiguration({...values,...change}));
});
test('optional migration is explicit, repeat-safe, preserves commerce2 and immutable activation, accepts disabled restart and refuses foreign partial schema',async t=>{
 const {db,values}=await fixture(t);await initializeMerchantEmail(db,values);await assertMerchantDatabaseSchema(db,{...values,MERCHANT_EMAIL_ENABLED:'false'},true);
 assert.equal((await db.query<{version:number}>('SELECT version FROM merchant_commerce_config')).rows[0]!.version,2);
 await assert.rejects(assertMerchantEmailSchema(db,{...values,MERCHANT_EMAIL_ACTIVATED_AT:new Date(Date.now()+1000).toISOString()}));
 await db.exec('DROP TABLE merchant_email_outbox');await assert.rejects(assertMerchantDatabaseSchema(db,{...values,MERCHANT_EMAIL_ENABLED:'false'},true));
});
test('only new completed checkouts enqueue once, immutable sandbox payload has no private bearer/contact extras and accepted is not delivered',async t=>{
 const {db,values}=await fixture(t);const id=await order(db);await order(db,'pending');await order(db,'review');await order(db,'completed',new Date(Date.now()-3600000).toISOString());
 const calls:{body:string;key:string}[]=[];const service=createMerchantEmailService(db,values,async(url,init)=>{
  assert.equal(String(url),'https://api.resend.com/emails');assert.equal(init?.redirect,'error');const body=JSON.parse(String(init?.body));
  assert.deepEqual(body.to,['sandbox-qa@example.com']);assert.ok(body.subject.startsWith('[SANDBOX]'));assert.match(body.text,/USD 1.91/);assert.doesNotMatch(JSON.stringify(body),/PRIVATE_NAME_CANARY|real-customer|12025550100|checkoutToken|lookupToken|injected_private/);
  calls.push({body:String(init!.body),key:(init!.headers as Record<string,string>)['Idempotency-Key']!});return Response.json({id:acceptedId});
 })!;
 await Promise.all([service.reconcile(),service.reconcile()]);assert.equal((await db.query('SELECT * FROM merchant_email_outbox')).rows.length,1);
 const status=await service.drain();assert.equal(status.counts.accepted,1);assert.equal(status.acceptedIsNotDelivered,true);assert.equal(status.items[0]!.attemptId,id);
 await service.drain();assert.equal(calls.length,1);assert.doesNotMatch(JSON.stringify(await service.status()),/sandbox-qa@example|real-customer|injected_private|Test <item>/);
});
test('unknown send retries exact body/key across restart, stops on retention boundary or credential rotation',async t=>{
 const {db,values}=await fixture(t);await order(db);const calls:{body:string;key:string}[]=[];
 const transport:typeof fetch=async(_url,init)=>{calls.push({body:String(init!.body),key:(init!.headers as Record<string,string>)['Idempotency-Key']!});if(calls.length===1)throw new Error('PRIVATE PROVIDER TOKEN ERROR');return Response.json({id:acceptedId});};
 let service=createMerchantEmailService(db,values,transport)!;assert.equal((await service.drain()).counts.retry,1);
 await db.exec("UPDATE merchant_email_outbox SET next_attempt_at=now()");await db.exec("UPDATE merchant_commerce_config SET operating_settings='{}'");
 service=createMerchantEmailService(db,values,transport)!;assert.equal((await service.drain()).counts.accepted,1);assert.deepEqual(calls[0],calls[1]);
 await order(db);const unknown=createMerchantEmailService(db,values,async()=>{throw new Error('unknown');})!;await unknown.drain();
 await db.exec("UPDATE merchant_email_outbox SET first_dispatch_at=now()-interval '24 hours',next_attempt_at=now() WHERE state='retry'");
 let sent=0;const bounded=createMerchantEmailService(db,values,async()=>{sent++;return Response.json({id:acceptedId});})!;assert.equal((await bounded.drain()).counts.needs_review,1);assert.equal(sent,0);
 await order(db);await unknown.drain();await db.exec("UPDATE merchant_email_outbox SET next_attempt_at=now() WHERE state='retry'");
 const rotated=createMerchantEmailService(db,{...values,MERCHANT_EMAIL_RESEND_API_KEY:'re_injected_rotated_private_key'},async()=>{sent++;return Response.json({id:acceptedId});})!;
 assert.equal((await rotated.drain()).counts.needs_review,2);assert.equal(sent,0);
});
test('parallel workers claim one delivery; stale failure cannot overwrite recovery acceptance',async t=>{
 const {db,values}=await fixture(t);await order(db);let entered!:()=>void,rejectOld!:(e:Error)=>void;const enteredPromise=new Promise<void>(r=>{entered=r;});let calls=0;
 const transport:typeof fetch=async()=>{calls++;if(calls===1){entered();return new Promise((_resolve,reject)=>{rejectOld=reject;});}return Response.json({id:acceptedId});};
 const a=createMerchantEmailService(db,values,transport)!,b=createMerchantEmailService(db,values,transport)!;
 const first=a.drain();await enteredPromise;await b.drain();assert.equal(calls,1);
 await db.exec("UPDATE merchant_email_outbox SET lease_until=now()-interval '1 second'");
 assert.equal((await b.drain()).counts.accepted,1);rejectOld(new Error('late failure'));assert.equal((await first).counts.accepted,1);assert.equal(calls,2);
});
test('known rejection fails without raw errors; rejection after unknown remains review and changed payload never dispatches',async t=>{
 const {db,values}=await fixture(t);await order(db);const rejected=createMerchantEmailService(db,values,async()=>new Response('PRIVATE PROVIDER BODY',{status:401}))!;
 assert.equal((await rejected.drain()).counts.failed,1);
 await order(db);const unknown=createMerchantEmailService(db,values,async()=>{throw new Error('secret');})!;await unknown.drain();await db.exec("UPDATE merchant_email_outbox SET next_attempt_at=now() WHERE state='retry'");
 assert.equal((await rejected.drain()).counts.needs_review,1);
 await order(db);await rejected.reconcile();await db.exec("UPDATE merchant_email_outbox SET payload='{}' WHERE state='queued'");
 let sent=0;const changed=createMerchantEmailService(db,values,async()=>{sent++;return Response.json({id:acceptedId});})!;assert.equal((await changed.drain()).counts.needs_review,2);assert.equal(sent,0);
 assert.doesNotMatch(JSON.stringify(await changed.status()),/PRIVATE PROVIDER BODY|secret|injected/);
});

test('suspended claimant rechecks lease and retention immediately before transport; no stale network dispatch',async t=>{
 const {db,values}=await fixture(t);
 for(const change of ["lease_until=clock_timestamp()-interval '1 second'","first_dispatch_at=clock_timestamp()-interval '24 hours'"]){
  await order(db);let intercepted=false,sent=0;
  const wrapper={exec:(sql:string)=>db.exec(sql),transaction:db.transaction.bind(db),query:async<T>(sql:string,args?:unknown[])=>{
   if(sql.startsWith('SELECT id FROM merchant_email_outbox WHERE id=')){intercepted=true;await db.query('UPDATE merchant_email_outbox SET '+change+' WHERE id=$1',[args![0]]);}
   return db.query<T>(sql,args);
  }};
  const service=createMerchantEmailService(wrapper,values,async()=>{sent++;return Response.json({id:acceptedId});})!;
  await service.drain();assert.equal(intercepted,true);assert.equal(sent,0);
  await db.exec("UPDATE merchant_email_outbox SET state='needs_review',claim_token=NULL,lease_until=NULL WHERE state='sending'");
 }
});

test('HTTP408 and aborted requests retain unknown liability; postclaim payload tampering prevents dispatch',async t=>{
 const {db,values}=await fixture(t);
 for(const transport of [async()=>new Response('timeout with private payload',{status:408}),async()=>{throw new DOMException('private aborted request','AbortError');}]){
  await order(db);const service=createMerchantEmailService(db,values,transport)!;await service.drain();
 }
 assert.equal((await createMerchantEmailService(db,values,async()=>{throw new Error();})!.status()).counts.retry,2);
 await order(db);let sent=0,tampered=false;
 const wrapper={exec:(sql:string)=>db.exec(sql),transaction:db.transaction.bind(db),query:async<T>(sql:string,args?:unknown[])=>{
  if(sql.startsWith('SELECT id FROM merchant_email_outbox WHERE id=')&&!tampered){tampered=true;await db.query("UPDATE merchant_email_outbox SET payload='{}' WHERE id=$1",[args![0]]);}
  return db.query<T>(sql,args);
 }};
 await createMerchantEmailService(wrapper,values,async()=>{sent++;return Response.json({id:acceptedId});})!.drain();
 assert.equal(tampered,true);assert.equal(sent,0);
});
