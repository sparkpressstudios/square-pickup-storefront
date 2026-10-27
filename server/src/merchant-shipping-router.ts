import {ShippingBuyerError,type MerchantShippingBuyer} from './merchant-shipping-buyer';
import express from 'express';
import {ShippingCheckoutError,type ShippingCheckoutRehearsal} from './merchant-shipping-checkout';
import {ShippingQuoteError} from './merchant-shipping-quote';
import {ShippingError} from './merchant-shipping';
/** Mount only behind the existing verified staff + CSRF guard. No buyer endpoint. */
export function shippingRehearsalRouter(service?:ShippingCheckoutRehearsal,buyer?:MerchantShippingBuyer){
 const router=express.Router();
 router.use((req,res,next)=>{res.set('Cache-Control','no-store');if(res.locals.staff?.role!=='admin'){res.status(403).json({error:{code:'ADMIN_REQUIRED'}});return;}if(req.method!=='GET'&&!req.is('application/json')){res.status(415).json({error:{code:'INVALID_SHIPPING_REQUEST'}});return;}next();});
 router.use('/settings',express.json({limit:'256kb',strict:true}));
 router.use(express.json({limit:'8kb',strict:true}));
 router.route('/settings').get(async(_req,res)=>{if(!buyer){res.status(503).json({error:{code:'SHIPPING_SETTINGS_UNAVAILABLE'}});return;}try{res.json(await buyer.settings());}catch{res.status(503).json({error:{code:'SHIPPING_SETTINGS_UNAVAILABLE'}});}}).post(async(req,res)=>{if(!buyer){res.status(503).json({error:{code:'SHIPPING_SETTINGS_UNAVAILABLE'}});return;}try{res.json(await buyer.saveSettings(req.body));}catch(error){const code=error instanceof ShippingBuyerError||error instanceof ShippingError?error.code:'SHIPPING_SETTINGS_UNAVAILABLE';res.status(code==='SHIPPING_SETTINGS_CHANGED'?409:code.startsWith('INVALID_')?400:503).json({error:{code}});}});
 router.get('/status',(_req,res)=>res.json({configured:Boolean(service),rehearsalOnly:true,paymentExecutionEnabled:false,shippingCheckoutEnabled:false}));
 router.post('/execute',(_req,res)=>res.status(423).json({error:{code:'SHIPPING_EXECUTION_DISABLED'}}));
 router.post(['/quote','/prepare'],async(req,res)=>{
  if(!service){res.status(503).json({error:{code:'SHIPPING_UNCONFIGURED'}});return;}
  try {res.json(req.path==='/quote'?await service.quote(req.body):await service.prepare(req.body));}
  catch(error){const code=error instanceof ShippingCheckoutError||error instanceof ShippingQuoteError||error instanceof ShippingError?error.code:'SHIPPING_PREVIEW_FAILED';res.status(code==='SHIPPING_UNCONFIGURED'?503:code.startsWith('INVALID_')?400:409).json({error:{code}});}
 });
 return router;
}
