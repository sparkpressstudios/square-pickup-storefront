import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {SqlDatabase,SqlExecutor} from './sql-database';
import {sandboxConfiguration} from '../server/src/square-sandbox';
import {merchantPaymentConfiguration} from '../server/src/merchant-payment-config';
import {merchantEmailConfiguration,MerchantEmailError} from '../server/src/merchant-email-config';
export const merchantEmailTables=['merchant_email_schema','merchant_email_outbox'] as const;
async function migration(){const sql=await readFile(new URL('merchant-email.sql',import.meta.url),'utf8');return {sql,checksum:createHash('sha256').update(sql).digest('hex')};}
export async function assertMerchantEmailSchema(db:SqlExecutor,values:Readonly<Record<string,string|undefined>>){
 const payment=values.SQUARE_ENVIRONMENT==='production'?merchantPaymentConfiguration(values):{...sandboxConfiguration(values),merchantId:values.SQUARE_SANDBOX_MERCHANT_ID};
 const row=(await db.query<{version:number;checksum:string;environment:string;merchant_id:string;location_id:string;application_id:string;activated_at:Date|string}>('SELECT * FROM merchant_email_schema WHERE singleton=true')).rows[0];
 if(!row||row.version!==1||row.checksum!==(await migration()).checksum||row.environment!==payment.environment||row.merchant_id!==payment.merchantId||row.location_id!==payment.locationId||row.application_id!==payment.applicationId)throw new MerchantEmailError('EMAIL_SCHEMA_INVALID');
 const config=merchantEmailConfiguration(values);
 if(config&&new Date(row.activated_at).toISOString()!==config.activatedAt)throw new MerchantEmailError('EMAIL_ACTIVATION_CHANGED');
}
export async function initializeMerchantEmail(db:SqlDatabase,values:Readonly<Record<string,string|undefined>>){
 const config=merchantEmailConfiguration(values);if(!config)throw new MerchantEmailError('EMAIL_DISABLED');
 const {assertMerchantDatabaseSchema}=await import('./native-merchant-database'),{assertMerchantCommerce}=await import('./merchant-commerce');
 const change=await migration();
 await db.transaction(async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('merchant-email-schema',0))");
  await assertMerchantDatabaseSchema(tx as SqlDatabase,{...values,MERCHANT_EMAIL_ENABLED:'false'},true);await assertMerchantCommerce(tx as SqlDatabase,values);
  const existing=(await tx.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='merchant_email_schema'")).rows.length;
  if(existing){await assertMerchantEmailSchema(tx,values);return;}
  // A newly enabled integration must not send any pre-existing checkout, even if paid later.
  const safe=(await tx.query<{ok:boolean}>("SELECT $1::timestamptz<=clock_timestamp()+interval '1 minute' AND $1::timestamptz>=clock_timestamp()-interval '15 minutes' AND NOT EXISTS(SELECT 1 FROM merchant_commerce_attempts WHERE created_at>=$1::timestamptz) AS ok",[config.activatedAt])).rows[0]?.ok;
  if(!safe)throw new MerchantEmailError('EMAIL_ACTIVATION_REQUIRES_FRESH_CUTOFF');
  await tx.exec(change.sql);
  await tx.query('INSERT INTO merchant_email_schema(singleton,version,checksum,environment,merchant_id,location_id,application_id,activated_at) VALUES(true,1,$1,$2,$3,$4,$5,$6)',[change.checksum,config.environment,config.merchantId,config.locationId,config.applicationId,config.activatedAt]);
 });
}
