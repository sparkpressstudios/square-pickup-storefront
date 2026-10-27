import {shippingBuyerRouter} from './merchant-shipping-buyer-router';
import type {MerchantShippingBuyer} from './merchant-shipping-buyer';
import type {ShippingCheckoutRehearsal} from './merchant-shipping-checkout';
import express, {type ErrorRequestHandler} from 'express';
import type {SqlDatabase} from '../../db/sql-database';
import type {MerchantConfig} from '../../shared/storefront';
import {CheckoutError} from '../../shared/checkout';
import {MerchantCommerce,CommerceError,merchantCommerceBridge} from './merchant-commerce';
import {MerchantSquareProvider,MerchantProviderError} from './merchant-square-provider';
import {sandboxConfiguration,publicSandboxConfiguration} from './square-sandbox';
import {MerchantWebhookProjector,merchantWebhookRouter} from './square-webhooks';
import {merchantPaymentConfiguration,merchantWebhookConfiguration,publicMerchantPaymentConfiguration} from './merchant-payment-config';
import {evaluatePickupAvailability} from './merchant-readiness';
import {adminCatalogRouter,type StaffPrincipal} from './admin-catalog';
import {merchantAuthRouter} from './merchant-auth-router';
import type {MerchantStaffAuth} from './merchant-staff-auth';
import {createSquareMerchantImportAdministration} from './merchant-import-service';
import {createMerchantEmailService,merchantEmailDisabledStatus} from './merchant-email';
import {assertMerchantEmailSchema} from '../../db/merchant-email';
import {publicOrigin,validWriteOrigin,sandboxCsp} from './origin';

function exact(input:unknown,keys:string[]):input is Record<string,unknown>{return !!input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).sort().join(',')===keys.sort().join(',');}
export function merchantPresentation(values:Readonly<Record<string,string|undefined>>):MerchantConfig {
 const value=(key:string,max:number)=>{const raw=values[key];if(!raw||!raw.trim()||raw.length>max||/[\x00-\x1f\x7f]/.test(raw))throw new Error('Merchant presentation is incomplete');return raw.trim();};
 return {name:value('MERCHANT_NAME',100),descriptor:'Thoughtfully chosen, ready for pickup',tagline:'Shop the collection',introduction:'Choose your favorites and collect your order in store.',currency:'USD',fulfillment:'pickup',pickup:{label:value('MERCHANT_PICKUP_LABEL',100),instructions:value('MERCHANT_PICKUP_INSTRUCTIONS',500)},theme:{accent:'#A1AB74',background:'#f9f8f4'}};
}
export function merchantWebhookPath(values:Readonly<Record<string,string|undefined>>){const path=values.SQUARE_MERCHANT_WEBHOOK_PATH??'/api/commerce/webhooks';if(!['/api/commerce/webhooks','/api/sandbox/webhooks'].includes(path))throw new Error('Unsupported merchant webhook path');return path;}
/** Separate opt-in merchant runtime. Default synthetic and setup-only applications are unchanged. */
export function createMerchantCommerceApp(db:SqlDatabase,values:Readonly<Record<string,string|undefined>>,auth:MerchantStaffAuth,merchant:MerchantConfig,fetcher:typeof fetch=fetch,emailFetcher:typeof fetch=fetch,development: {shippingRehearsal?:ShippingCheckoutRehearsal;shippingBuyer?:MerchantShippingBuyer} = {}){
 if(values.STARTER_DATASET!=='merchant-catalog-v1'||values.SQUARE_MERCHANT_COMMERCE_ENABLED!=='true')throw new Error('Merchant commerce requires explicit sandbox configuration');
 const origin=publicOrigin(values.PUBLIC_ORIGIN??'',true);if(auth.origin!==origin)throw new Error('Merchant staff origin mismatch');
 const config=merchantPaymentConfiguration(values),merchantId=config.merchantId;
 const context={merchantId,locationId:config.locationId,environment:config.environment,applicationId:config.applicationId};
 development.shippingBuyer?.assertContext(context);
 if(config.environment==='production'&&development.shippingBuyer)throw new Error('Development shipping is not available in production');
 const email=createMerchantEmailService(db,values,emailFetcher);
 const commerce=new MerchantCommerce(db,new MerchantSquareProvider(config,fetcher),context);
 const projector=new MerchantWebhookProjector(db,merchantWebhookConfiguration(config,origin+merchantWebhookPath(values)),merchantCommerceBridge(context));
 const mode=config.environment==='production'?'merchant-production':'merchant-sandbox';
 const csp=(config.environment==='production'?sandboxCsp.replaceAll('sandbox.web.squarecdn.com','web.squarecdn.com').replaceAll('pci-connect.squareupsandbox.com','pci-connect.squareup.com'):sandboxCsp).replace("img-src 'self' data:","img-src 'self' data: https:");
 const app=express();app.disable('x-powered-by');
 app.use((_req,res,next)=>{res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Content-Security-Policy',csp);next();});
 app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 // Post-response work is independent of payment commits. Disabled mode installs no worker or timer.
 if(email){
  app.use((req,res,next)=>{res.once('finish',()=>{if(res.statusCode<300&&req.method==='POST'&&(req.path===merchantWebhookPath(values)||req.path==='/api/commerce/submit'||/^\/api\/admin\/commerce\/orders\/[^/]+\/recover$/.test(req.path)))email.kick();});next();});
  queueMicrotask(()=>email.kick());
 }

 app.get('/api/health',async(_req,res)=>{try{await db.query('SELECT 1');res.json({status:'ok',mode,productionPayments:config.environment==='production'});}catch{res.status(503).json({status:'unavailable'});}});
 async function presentationStatus(){
  const readiness=await commerce.readiness(),configuration=readiness.configuration;
  const presentation=configuration?{...merchant,name:configuration.branding.name,tagline:configuration.branding.tagline,theme:{accent:configuration.branding.accentColor,background:configuration.branding.backgroundColor}}:merchant;
  const row=(await db.query<{enabled:boolean}>('SELECT enabled FROM merchant_commerce_config WHERE singleton=true')).rows[0];
  return {readiness,configuration,presentation,checkoutEnabled:row?.enabled===true};
 }
 app.get('/api/storefront',async(_req,res)=>{
  const {readiness,configuration,presentation,checkoutEnabled}=await presentationStatus();
  if(email)await assertMerchantEmailSchema(db,values);
  res.json({mode,merchant:presentation,shippingDevelopment:Boolean(development.shippingBuyer),checkoutEnabled,confirmationEmailEnabled:Boolean(email&&config.environment==='production'),catalog:await commerce.catalog(),payment:publicMerchantPaymentConfiguration(config),...(config.environment==='sandbox'?{sandbox:publicSandboxConfiguration(sandboxConfiguration(values))}:{}),configuration,pickupAvailability:configuration?evaluatePickupAvailability(configuration.pickup,{now:new Date(Date.now()+11*60_000)}):undefined,capabilities:{checkout:checkoutEnabled&&config.environment==='production'&&readiness.ready,sandboxCheckout:checkoutEnabled&&config.environment==='sandbox',outboundMail:Boolean(email&&config.environment==='production'),schedulers:false,databaseConnected:true}});
 });
 // Must precede JSON middleware: signatures cover the original raw request bytes.
 app.use(merchantWebhookPath(values),merchantWebhookRouter(projector));
 const writes=express.Router();
 writes.use((req,res,next)=>{if(!validWriteOrigin(req,origin,true)){res.status(403).json({error:{code:'INVALID_ORIGIN'}});return;}if(!req.is('application/json')){res.status(415).json({error:{code:'INVALID_REQUEST'}});return;}next();},express.json({limit:'16kb',strict:true}));
 writes.post('/quote',async(req,res)=>res.json(await commerce.quote(req.body)));
 writes.post('/prepare',async(req,res)=>{if(!exact(req.body,['quoteId','pickup','checkoutToken']))throw new CommerceError('INVALID_REQUEST',400);await commerce.authorizeCheckout(req.body.quoteId,req.body.checkoutToken);res.json(await commerce.prepare(req.body.quoteId,req.body.pickup));});
 writes.post('/submit',async(req,res)=>{if(!exact(req.body,['attemptId','cardToken','checkoutToken']))throw new CommerceError('INVALID_REQUEST',400);await commerce.authorizeCheckout(req.body.attemptId,req.body.checkoutToken);const result=await commerce.submit(req.body.attemptId,req.body.cardToken);if(result.paymentId)await projector.reconcilePending(result.paymentId);res.json(await commerce.status(req.body.attemptId));});
 writes.post('/status',async(req,res)=>{if(!exact(req.body,['attemptId','checkoutToken']))throw new CommerceError('INVALID_REQUEST',400);await commerce.authorizeCheckout(req.body.attemptId,req.body.checkoutToken);const state=await commerce.status(req.body.attemptId);if(state.paymentId)await projector.reconcilePending(state.paymentId);res.json(await commerce.status(req.body.attemptId));});
 writes.post('/cancel',async(req,res)=>{if(!exact(req.body,['attemptId','checkoutToken']))throw new CommerceError('INVALID_REQUEST',400);await commerce.authorizeCheckout(req.body.attemptId,req.body.checkoutToken);res.json(await commerce.cancel(req.body.attemptId));});
 writes.post('/lookup',async(req,res)=>{if(!exact(req.body,['token']))throw new CommerceError('INVALID_REQUEST',400);res.json(await commerce.lookup(req.body.token));});
 writes.use('/shipping',shippingBuyerRouter(development.shippingBuyer));
 app.use('/api/commerce',writes);
 app.use('/api/merchant-auth',merchantAuthRouter(auth));
 const admin=express.Router();
 admin.use((req,res,next)=>{if(req.method!=='GET'&&!req.is('application/json')){res.status(415).json({error:{code:'INVALID_REQUEST'}});return;}next();},express.json({limit:'8kb',strict:true}));
 admin.get('/status',async(_req,res)=>{const {presentation,checkoutEnabled}=await presentationStatus();res.json({checkoutEnabled,merchant:presentation});});
 admin.get('/email',async(_req,res)=>res.json(email?await email.status():merchantEmailDisabledStatus()));
 admin.post('/email/drain',async(req,res)=>{if(!exact(req.body,[]))throw new CommerceError('INVALID_REQUEST',400);if(!email)throw new CommerceError('EMAIL_DISABLED');res.json(await email.drain());});
 admin.get('/readiness',async(_req,res)=>res.json(await commerce.readiness()));
 admin.put('/settings',async(req,res)=>res.json(await commerce.configure(req.body)));
 admin.get('/inventory',async(_req,res)=>res.json(await commerce.inventory()));
 admin.put('/inventory',async(req,res)=>res.json(await commerce.updateInventory(req.body)));
 admin.post('/activation',async(req,res)=>{if(!exact(req.body,['enabled']))throw new CommerceError('INVALID_REQUEST',400);res.json(await commerce.activate(req.body.enabled as boolean));});
 admin.get('/orders',async(req,res)=>res.json(await commerce.orders({q:req.query.q,cursor:req.query.cursor})));
 admin.post('/orders/:id/recover',async(req,res)=>{if(!exact(req.body,[]))throw new CommerceError('INVALID_REQUEST',400);const state=await commerce.recover(req.params.id);if(state.paymentId)await projector.reconcilePending(state.paymentId);res.json(await commerce.status(req.params.id));});
 admin.get('/orders/:id/refunds',async(req,res)=>res.json(await commerce.refundHistory(req.params.id)));
 admin.post('/refunds/:id/recover',async(req,res)=>{if(!exact(req.body,[]))throw new CommerceError('INVALID_REQUEST',400);res.json(await commerce.recoverRefund(req.params.id,(res.locals.staff as StaffPrincipal).id));});
 admin.post('/orders/:id/fulfillment/recover',async(req,res)=>{if(!exact(req.body,[]))throw new CommerceError('INVALID_REQUEST',400);res.json(await commerce.recoverFulfillment(req.params.id,(res.locals.staff as StaffPrincipal).id));});
 admin.post('/orders/:id/fulfillment',async(req,res)=>{if(!exact(req.body,['state']))throw new CommerceError('INVALID_REQUEST',400);res.json(await commerce.fulfill(req.params.id,req.body.state,(res.locals.staff as StaffPrincipal).id));});
 admin.post('/orders/:id/refunds',async(req,res)=>{if(!exact(req.body,['refundId','amountMinor']))throw new CommerceError('INVALID_REQUEST',400);res.json(await commerce.refund(req.params.id,req.body.refundId,req.body.amountMinor,(res.locals.staff as StaffPrincipal).id));});
 app.use('/api/admin',adminCatalogRouter({shippingRehearsal:development.shippingRehearsal,paymentEnvironment:config.environment,verifyStaff:auth.verifyStaff,origin,commerce:admin,merchantImport:createSquareMerchantImportAdministration(db,values,fetcher),runtime:{native:true,sandbox:config.environment==='sandbox'}}));
 app.use('/api',(_req,res)=>res.status(404).json({error:{code:'NOT_FOUND'}}));
 const errors:ErrorRequestHandler=(error:unknown,_req,res,_next)=>{
  if(error instanceof CommerceError||error instanceof CheckoutError){res.status(error.status).json({error:{code:error.code,message:error.message}});return;}
  if(error instanceof MerchantProviderError){res.status(503).json({error:{code:error.code,message:'Square could not verify this request. Keep the existing attempt identity.'}});return;}
  const status=(error as {status?:number})?.status;res.status(status===400||status===413?status:503).json({error:{code:'COMMERCE_UNAVAILABLE',message:'Request unavailable. Preserve any existing checkout identity and check its status.'}});
 };app.use(errors);return app;
}
