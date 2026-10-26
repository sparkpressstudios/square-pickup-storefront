import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SqlDatabase } from './sql-database';
import { assertMerchantDatabaseSchema } from './native-merchant-database';
import { sandboxConfiguration } from '../server/src/square-sandbox';
import {merchantPaymentConfiguration} from '../server/src/merchant-payment-config';
const paymentConfig=(values:Readonly<Record<string,string|undefined>>)=>values.SQUARE_ENVIRONMENT==='production'?merchantPaymentConfiguration(values):sandboxConfiguration(values);

export const merchantCommerceTables = [
 'merchant_commerce_config','merchant_commerce_inventory','merchant_commerce_quotes',
 'merchant_commerce_attempts','merchant_commerce_reservations','merchant_commerce_refund_requests','merchant_commerce_fulfillment_requests',
 'sandbox_payment_projections','sandbox_refund_projections','sandbox_webhook_events','sandbox_reconciliation_jobs',
] as const;
async function migration() {
 // Reuse the reviewed provider projection and reconciliation schemas, not synthetic checkout.
 const files = ['merchant-commerce.sql','migrations/0002_sandbox_events.sql','migrations/0003_sandbox_reconciliation_jobs.sql'];
 const sql = await Promise.all(files.map(file=>readFile(new URL(file,import.meta.url),'utf8')));
 return {sql:sql.join('\n'),checksum:createHash('sha256').update(sql.join('\n')).digest('hex')};
}
async function v2Migration(){const base=await migration(),sql=await readFile(new URL('merchant-commerce-v2.sql',import.meta.url),'utf8');return {sql,checksum:createHash('sha256').update(base.sql+'\n'+sql).digest('hex')};}
export async function assertMerchantCommerce(db:SqlDatabase, values:Readonly<Record<string,string|undefined>>) {
 const configuration=paymentConfig(values);
 const expected=await v2Migration();
 const row=(await db.query<{version:number;checksum:string;application_id:string;environment:string}>('SELECT version,checksum,application_id,environment FROM merchant_commerce_config WHERE singleton=true')).rows[0];
 if(!row||row.version!==2||row.checksum!==expected.checksum||row.application_id!==configuration.applicationId||row.environment!==configuration.environment)
  throw new Error('Merchant commerce schema or application identity mismatch');
}
/** Explicit migration command only; never startup or the synthetic Railway database. */
export async function initializeMerchantCommerce(db:SqlDatabase, values:Readonly<Record<string,string|undefined>>) {
 if(values.SQUARE_MERCHANT_COMMERCE_ENABLED!=='true'||(values.SQUARE_ENVIRONMENT!=='production'&&values.SQUARE_SANDBOX_REQUESTS_ENABLED!=='true'))
  throw new Error('Explicit merchant sandbox commerce configuration is required');
 const config=paymentConfig(values); const change=await migration(),upgrade=await v2Migration();
 await db.transaction(async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('merchant-commerce-schema',0))");
  const existing=(await tx.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='merchant_commerce_config'")).rows.length;
  // Full known-schema assertion before any DDL; it rejects synthetic or foreign databases.
  await assertMerchantDatabaseSchema(tx as SqlDatabase,values,Boolean(existing));
  if(existing){
   const row=(await tx.query<{version:number;checksum:string;application_id:string}>('SELECT version,checksum,application_id FROM merchant_commerce_config WHERE singleton=true FOR UPDATE')).rows[0];
   if(row?.version===2){await assertMerchantCommerce(tx as SqlDatabase,values);return;}
   if(!row||row.version!==1||row.checksum!==change.checksum||row.application_id!==config.applicationId)throw new Error('Refusing unrecognized commerce upgrade');
   await tx.exec(upgrade.sql);await tx.query('UPDATE merchant_commerce_config SET version=2,checksum=$1 WHERE singleton=true',[upgrade.checksum]);return;
  }
  await tx.exec(change.sql);await tx.exec(upgrade.sql);
  await tx.query('INSERT INTO merchant_commerce_config(singleton,version,checksum,application_id,environment) VALUES(true,2,$1,$2,$3)',[upgrade.checksum,config.applicationId,config.environment]);
 });
}
