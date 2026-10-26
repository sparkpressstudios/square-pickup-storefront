/** Buyer-run optional migration or explicit bounded outbox operations; no import side effects. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openNativeMerchantDatabase} from '../db/native-merchant-database';
import {initializeMerchantEmail} from '../db/merchant-email';
import {createMerchantEmailService} from '../server/src/merchant-email';
import {merchantEmailConfiguration} from '../server/src/merchant-email-config';
async function main(){
 const action=process.argv[2];if(process.argv.length!==3||!['--migrate-reviewed','--status','--drain'].includes(action??''))throw new Error();
 const values={...process.env};if(!merchantEmailConfiguration(values))throw new Error();
 // Migration alone opens recognized base schema without requiring optional tables beforehand.
 const handle=await openNativeMerchantDatabase(action==='--migrate-reviewed'?{...values,MERCHANT_EMAIL_ENABLED:'false'}:values,true);
 try{
  if(action==='--migrate-reviewed'){await initializeMerchantEmail(handle.db,values);console.log('MERCHANT_EMAIL_SCHEMA_READY: existing payment records preserved; no email sent.');}
  else {const service=createMerchantEmailService(handle.db,values)!;const result=action==='--drain'?await service.drain():await service.status();console.log(JSON.stringify({enabled:result.enabled,acceptedIsNotDelivered:true,counts:result.counts}));}
 }finally{await handle.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{await main();}catch{console.error('MERCHANT_EMAIL_REFUSED: verify explicit configuration, optional schema and outbox status.');process.exitCode=1;}}
