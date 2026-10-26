/** Explicit owner-run fresh install/upgrade. Never a deploy/startup hook; never seeds staff credentials. */
import pg from 'pg';
import {validateMerchantDatabaseConnection} from '../db/native-merchant-database';
import {NativeSqlDatabase} from '../db/native-database';
import {initializeEmptyMerchantCatalog} from '../server/src/merchant-catalog-import';
import {initializeMerchantCommerce} from '../db/merchant-commerce';
import {merchantPaymentConfiguration} from '../server/src/merchant-payment-config';
async function main(){
 const action=process.argv[2];if(process.argv.length!==3||!['--initialize-empty','--upgrade-reviewed-catalog'].includes(action??''))throw new Error('Choose explicit empty initialization or reviewed merchant catalog upgrade');
 const identity=process.env.SQUARE_ENVIRONMENT==='production'?merchantPaymentConfiguration(process.env):{merchantId:process.env.SQUARE_SANDBOX_MERCHANT_ID??'',locationId:process.env.SQUARE_LOCATION_ID??''};
 const settings=validateMerchantDatabaseConnection(process.env);
 const pool=new pg.Pool({...settings,max:1,connectionTimeoutMillis:5000,application_name:'square-merchant-schema-install'});pool.on('error',()=>{});
 const db=new NativeSqlDatabase(pool);
 try{
  if(action==='--initialize-empty')await initializeEmptyMerchantCatalog(db,{squareMerchantId:identity.merchantId,squareLocationId:identity.locationId});
  await initializeMerchantCommerce(db,process.env);
  process.stdout.write('Merchant schema verified. No staff account, imported catalog, stock or live payments were enabled.\n');
 }finally{await pool.end();}
}
try{await main();}catch{process.stderr.write('Merchant schema setup refused. Verify explicit approval, separate empty/recognized database and configured environment identity. No credentials are printed.\n');process.exitCode=1;}
