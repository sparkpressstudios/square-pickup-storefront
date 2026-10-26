/**
 * Opt-in fresh-merchant onboarding server. NOT the existing Railway starter runtime.
 * Requires a separately initialized merchant database and an already-provisioned admin.
 * No demo checkout, payment, stock synchronization or production payment endpoints.
 */
import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openNativeMerchantDatabase } from '../../db/native-merchant-database';
import { createMerchantStaffAuth } from './merchant-staff-auth';
import { createSquareMerchantImportAdministration } from './merchant-import-service';
import { createSquareServices } from './square-services';
import { createSquarePromotionService } from './square-promotion-preview';
import { createApp } from './app';

if (process.argv.length!==3 || process.argv[2]!=='--built') {
  throw new Error('Merchant setup must start explicitly from the reviewed built-entry command');
}
const directory=resolve('dist/client');
if (!existsSync(resolve(directory,'index.html'))) throw new Error('Build the admin application before starting merchant setup');
const port=Number(process.env.PORT ?? '8080');
if (!Number.isSafeInteger(port) || port<1 || port>65535) throw new Error('Invalid merchant setup port');
const handle=await openNativeMerchantDatabase(process.env);
let app: Awaited<ReturnType<typeof createApp>>;
try {
  const auth=await createMerchantStaffAuth(handle.db,process.env);
  const importAdmin=createSquareMerchantImportAdministration(handle.db,process.env,fetch);
  const squareServices=createSquareServices(process.env,fetch);
  const promotion=process.env.SQUARE_PROMOTIONS_PREVIEW_ENABLED==='true' ? createSquarePromotionService(handle.db,process.env,fetch,squareServices) : undefined;
  app=await createApp({load:async()=>({currency:'USD',products:[]})},{
    origin:auth.origin, storage:'native-postgres', setupOnly:true,
    merchantAuth:auth, admin:{merchantImport:importAdmin,squareServices,promotion},
    healthcheck:async()=>{await handle.db.query('SELECT 1');},
  });
} catch {
  await handle.close();
  throw new Error('Merchant admin setup startup refused: verify separate database, staff key and sandbox identity');
}
const server=createServer(app);
app.get('/',(_req,res)=>res.redirect(302,'/admin/login'));
app.use(express.static(directory));
app.get(['/admin','/admin/login','/admin/import','/admin/square-services','/admin/integration',
  '/admin/preview','/admin/preview/import','/admin/preview/square-services'],(_req,res)=>res.sendFile(resolve(directory,'index.html')));
server.listen(port,'0.0.0.0',()=>console.log('Merchant-only administration listening; payments, checkout, stock writes and schedulers disabled.'));
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;
  server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));
  await handle.close();
}
process.once('SIGINT',()=>{void stop();});
process.once('SIGTERM',()=>{void stop();});
