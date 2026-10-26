import express from 'express';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openNativeMerchantDatabase} from '../../db/native-merchant-database';
import {createMerchantStaffAuth} from './merchant-staff-auth';
import {createMerchantCommerceApp,merchantPresentation} from './merchant-commerce-app';
if(process.argv.length!==3||process.argv[2]!=='--built')throw new Error('Use the explicit built merchant commerce command');
const directory=resolve('dist/client');if(!existsSync(resolve(directory,'index.html')))throw new Error('Build merchant storefront first');
const port=Number(process.env.PORT??'8080');if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('Invalid merchant port');
const handle=await openNativeMerchantDatabase(process.env,true);
let app:ReturnType<typeof createMerchantCommerceApp>;
try{const auth=await createMerchantStaffAuth(handle.db,process.env);app=createMerchantCommerceApp(handle.db,process.env,auth,merchantPresentation(process.env));}
catch{await handle.close();throw new Error('Merchant commerce startup refused: verify separate migrated merchant database, scoped sandbox and staff configuration');}
app.use(express.static(directory));
app.get(['/', '/admin','/admin/login','/admin/import','/admin/commerce'],(_req,res)=>res.sendFile(resolve(directory,'index.html')));
const server=app.listen(port,'0.0.0.0',()=>console.log('Merchant commerce listening in its explicitly configured payment environment. Customer email follows explicit configuration; no polling scheduler.'));
let stopping=false;async function stop(){if(stopping)return;stopping=true;server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await handle.close();}
process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
