import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {NativeSqlDatabase} from '../db/native-database';
import type {SqlDatabase} from '../db/sql-database';
import {initializeEmptyMerchantCatalog} from '../server/src/merchant-catalog-import';
import {initializeMerchantCommerce} from '../db/merchant-commerce';
import {assertMerchantDatabaseSchema} from '../db/native-merchant-database';
import {initializeMerchantEmail,assertMerchantEmailSchema} from '../db/merchant-email';
import {createMerchantEmailService} from '../server/src/merchant-email';
import {merchantEmailConfiguration} from '../server/src/merchant-email-config';
const base={STARTER_DATASET:'merchant-catalog-v1',SQUARE_MERCHANT_COMMERCE_ENABLED:'true',SQUARE_ENVIRONMENT:'sandbox',SQUARE_SANDBOX_REQUESTS_ENABLED:'true',SQUARE_APPLICATION_ID:'sandbox-sq0idb-email-fixture',SQUARE_LOCATION_ID:'EMAILLOCATION',SQUARE_SANDBOX_MERCHANT_ID:'EMAILMERCHANT',SQUARE_SANDBOX_ACCESS_TOKEN:'injected-square-private-token',SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY:'injected-square-signature',MERCHANT_EMAIL_ENABLED:'true',MERCHANT_EMAIL_PROVIDER:'resend',MERCHANT_EMAIL_FROM:'orders@example.com',MERCHANT_EMAIL_RESEND_API_KEY:'re_injected_private_email_key',MERCHANT_EMAIL_SANDBOX_RECIPIENT:'sandbox-qa@example.com'};
const acceptedId='123e4567-e89b-42d3-a456-426614174000';
const nativeTarget=process.env.MERCHANT_EMAIL_NATIVE_TEST_URL;
async function fixture(t:test.TestContext){
 const url=new URL(nativeTarget!);assert.equal(url.protocol,'postgres:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/postgres');assert.equal(url.search,'');assert.equal(url.hash,'');
 const admin=new pg.Pool({connectionString:url.href,max:1});const name='merchant_email_native_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url);target.pathname='/'+name;
 const pools:pg.Pool[]=[];const open=()=>{const pool=new pg.Pool({connectionString:target.href,max:2});pools.push(pool);return new NativeSqlDatabase(pool);};
 t.after(async()=>{await Promise.all(pools.map(p=>p.end()));await admin.query(`DROP DATABASE "${name}"`);await admin.end();});
 const db=open(),other=open();const versions=await Promise.all([db.query('SELECT version(),pg_backend_pid() AS pid'),other.query('SELECT pg_backend_pid() AS pid')]);assert.notEqual(versions[0].rows[0]!.pid,versions[1].rows[0]!.pid);console.log('Native email evidence:',versions[0].rows[0]!.version,'independent PIDs',versions[0].rows[0]!.pid,versions[1].rows[0]!.pid);
 const values={...base,MERCHANT_EMAIL_ACTIVATED_AT:new Date(Date.now()-1000).toISOString()};
 await initializeEmptyMerchantCatalog(db,{squareMerchantId:base.SQUARE_SANDBOX_MERCHANT_ID,squareLocationId:base.SQUARE_LOCATION_ID});await initializeMerchantCommerce(db,{...values,MERCHANT_EMAIL_ENABLED:'false'});
 assert.equal((await db.query("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'merchant_email_%'")).rows.length,0);
 await initializeMerchantEmail(db,values);await initializeMerchantEmail(other,values);await assertMerchantDatabaseSchema(other,{...values,MERCHANT_EMAIL_ENABLED:'false'},true);
 return {db,other,values,open};
}
async function order(db:SqlDatabase,state='completed',createdAt?:string){
 const id=randomUUID();
 await db.query("INSERT INTO merchant_commerce_quotes(id,pricing,cart,expires_at,line_snapshot) VALUES($1,$2::jsonb,'{}',now()+interval '10 minutes',$3::jsonb)",[id,JSON.stringify({currency:'USD',totalMinor:191}),JSON.stringify([{name:'Test <item>',variation:'One',quantity:1}])]);
 const needsOrder=['order_ready','payment_sending','pending','completed'].includes(state),needsPayment=['pending','completed'].includes(state);
 await db.query("INSERT INTO merchant_commerce_attempts(id,pickup,state,order_id,order_evidence,payment_id,payment_evidence,created_at) VALUES($1,$2::jsonb,$3,$4,$5::jsonb,$6,$7::jsonb,COALESCE($8::timestamptz,now()))",[id,JSON.stringify({name:'PRIVATE_NAME_CANARY',email:'real-customer@example.com',phone:'+12025550100'}),state,needsOrder?'ORDER_'+id:null,needsOrder?'{}':null,needsPayment?'PAYMENT_'+id:null,needsPayment?'{}':null,createdAt??null]);return id;
}
test('native optional email migration and independent claims prevent duplicate and stale projection',{skip:!nativeTarget},async t=>{
 const {db,other,values}=await fixture(t);await order(db);let entered!:()=>void,rejectOld!:(e:Error)=>void;const enteredPromise=new Promise<void>(r=>{entered=r;});let calls=0;
 const transport:typeof fetch=async()=>{calls++;if(calls===1){entered();return new Promise((_resolve,reject)=>{rejectOld=reject;});}return Response.json({id:acceptedId});};
 const a=createMerchantEmailService(db,values,transport)!,b=createMerchantEmailService(other,values,transport)!;
 const first=a.drain();await enteredPromise;await b.drain();assert.equal(calls,1);
 await db.exec("UPDATE merchant_email_outbox SET lease_until=now()-interval '1 second'");
 assert.equal((await b.drain()).counts.accepted,1);rejectOld(new Error('late failure'));assert.equal((await first).counts.accepted,1);assert.equal(calls,2);
});
test('native email reconnect preserves exact unknown key/body and bounds retries',{skip:!nativeTarget},async t=>{
 const {db,values,open}=await fixture(t);await order(db);const calls:{body:string;key:string}[]=[];
 const transport:typeof fetch=async(_url,init)=>{calls.push({body:String(init!.body),key:(init!.headers as Record<string,string>)['Idempotency-Key']!});if(calls.length===1)throw new Error('PRIVATE PROVIDER TOKEN ERROR');return Response.json({id:acceptedId});};
 let service=createMerchantEmailService(open(),values,transport)!;assert.equal((await service.drain()).counts.retry,1);
 await db.exec("UPDATE merchant_email_outbox SET next_attempt_at=now()");await db.exec("UPDATE merchant_commerce_config SET operating_settings='{}'");
 service=createMerchantEmailService(open(),values,transport)!;assert.equal((await service.drain()).counts.accepted,1);assert.deepEqual(calls[0],calls[1]);
 await order(db);const unknown=createMerchantEmailService(db,values,async()=>{throw new Error('unknown');})!;await unknown.drain();
 await db.exec("UPDATE merchant_email_outbox SET first_dispatch_at=now()-interval '24 hours',next_attempt_at=now() WHERE state='retry'");
 let sent=0;const bounded=createMerchantEmailService(db,values,async()=>{sent++;return Response.json({id:acceptedId});})!;assert.equal((await bounded.drain()).counts.needs_review,1);assert.equal(sent,0);
 await order(db);await unknown.drain();await db.exec("UPDATE merchant_email_outbox SET next_attempt_at=now() WHERE state='retry'");
 const rotated=createMerchantEmailService(db,{...values,MERCHANT_EMAIL_RESEND_API_KEY:'re_injected_rotated_private_key'},async()=>{sent++;return Response.json({id:acceptedId});})!;
 assert.equal((await rotated.drain()).counts.needs_review,2);assert.equal(sent,0);
});
