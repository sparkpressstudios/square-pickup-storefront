import pg from 'pg';
import { NativeSqlDatabase } from './native-database';
import type { SqlDatabase } from './sql-database';
import {merchantPaymentConfiguration} from '../server/src/merchant-payment-config';

export interface MerchantDbConnection {
  readonly connectionString: string;
  readonly ssl?: { rejectUnauthorized: true };
}
/** Never borrow the current synthetic starter DATABASE_URL. A merchant uses a separately
 * initialized and recognized database with its own dedicated secret variable.
 */
export function validateMerchantDatabaseConnection(values: Readonly<Record<string,string|undefined>>): MerchantDbConnection {
  if (values.STARTER_DATASET !== 'merchant-catalog-v1' || !values.MERCHANT_DATABASE_URL ||
      values.MERCHANT_DATABASE_URL === values.DATABASE_URL)
    throw new Error('A separate merchant-only database URL is required');
  let url: URL;
  try {url=new URL(values.MERCHANT_DATABASE_URL);}
  catch {throw new Error('Invalid merchant PostgreSQL configuration');}
  if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length<2 ||
      url.hash || /urban|churn|synthetic/i.test(url.hostname+url.pathname))
    throw new Error('Refusing invalid merchant database target');
  const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.hostname.endsWith('.railway.internal');
  if (url.search && !['?sslmode=require','?sslmode=verify-full'].includes(url.search))
    throw new Error('Unsupported merchant database connection options');
  if (!local && url.search!=='?sslmode=verify-full')
    throw new Error('Remote merchant database requires verified TLS');
  return {connectionString:values.MERCHANT_DATABASE_URL,ssl:!local?{rejectUnauthorized:true}:undefined};
}
const allowed = new Set([
  'merchant_catalog_identity','catalog_products','catalog_variants',
  'merchant_square_item_links','merchant_square_variation_links',
  'merchant_catalog_import_batches','merchant_staff_accounts','merchant_staff_sessions',
]);
export async function assertMerchantDatabaseSchema(db: SqlDatabase,
  values: Readonly<Record<string,string|undefined>>, commerce = false) {
  const version=commerce?(await db.query<{version:number}>('SELECT version FROM merchant_commerce_config WHERE singleton=true')).rows[0]?.version:undefined;
  const expected = commerce ? new Set([...allowed, 'merchant_commerce_config','merchant_commerce_inventory','merchant_commerce_quotes','merchant_commerce_attempts','merchant_commerce_reservations','merchant_commerce_refund_requests','sandbox_payment_projections','sandbox_refund_projections','sandbox_webhook_events','sandbox_reconciliation_jobs',...(version===2?['merchant_commerce_fulfillment_requests']:[])]) : allowed;
  const identity=values.SQUARE_ENVIRONMENT==='production'?merchantPaymentConfiguration(values):{merchantId:values.SQUARE_SANDBOX_MERCHANT_ID,locationId:values.SQUARE_LOCATION_ID};
  if (values.STARTER_DATASET!=='merchant-catalog-v1' ||
      !/^[A-Za-z0-9_-]{1,192}$/.test(identity.merchantId||'') ||
      !/^[A-Za-z0-9]{1,64}$/.test(identity.locationId||''))
    throw new Error('Merchant identity is not configured');
  const otherSchemas=await db.query<{schema_name:string}>(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('public','information_schema') AND left(schema_name,3)<>'pg_'");
  const relations=await db.query<{table_name:string;table_type:string}>(
    "SELECT table_name,table_type FROM information_schema.tables WHERE table_schema='public'");
  const emailTables=['merchant_email_schema','merchant_email_outbox'];
  const emailPresent=emailTables.filter(name=>relations.rows.some(row=>row.table_name===name));
  if(emailPresent.length){
    if(!commerce||emailPresent.length!==emailTables.length)throw new Error('Refusing partial optional email schema');
    for(const name of emailTables)expected.add(name);
    await (await import('./merchant-email')).assertMerchantEmailSchema(db,values);
  }else if(values.MERCHANT_EMAIL_ENABLED==='true')throw new Error('Explicit optional email migration required');
  if (otherSchemas.rows.length || relations.rows.length!==expected.size ||
      relations.rows.some(row=>row.table_type!=='BASE TABLE'||!expected.has(row.table_name)))
    throw new Error('Refusing unrecognized merchant schema');
  const marker=await db.query<{
    dataset:string;square_merchant_id:string;square_location_id:string;checkout_enabled:boolean;
  }>('SELECT dataset,square_merchant_id,square_location_id,checkout_enabled FROM merchant_catalog_identity WHERE singleton=true');
  if (marker.rows.length!==1 || marker.rows[0]?.dataset!=='merchant-catalog-v1' ||
      marker.rows[0]?.square_merchant_id!==identity.merchantId ||
      marker.rows[0]?.square_location_id!==identity.locationId ||
      marker.rows[0]?.checkout_enabled!==false)
    throw new Error('Merchant database marker or Square identity mismatch');
}
/** This is never called by start.ts. No database is opened without an explicit merchant action. */
export async function openNativeMerchantDatabase(values: Readonly<Record<string,string|undefined>>, commerce = false) {
  const settings=validateMerchantDatabaseConnection(values);
  const pool=new pg.Pool({connectionString:settings.connectionString,ssl:settings.ssl,max:3,
    connectionTimeoutMillis:5000,idleTimeoutMillis:30000,application_name:'square-merchant-admin-setup'});
  pool.on('error',()=>{});
  const db=new NativeSqlDatabase(pool);
  try {await assertMerchantDatabaseSchema(db,values,commerce); if(commerce) await (await import('./merchant-commerce')).assertMerchantCommerce(db,values);}
  catch {await pool.end();throw new Error('Merchant database is not an authorized fresh merchant schema');}
  return {db,close:()=>pool.end()};
}

