import express from 'express';
import {MerchantShippingBuyer,ShippingBuyerError} from './merchant-shipping-buyer';
import {ShippingError} from './merchant-shipping';
import {ShippingQuoteError} from './merchant-shipping-quote';
import {CheckoutError} from '../../shared/checkout';
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
/** Mount behind existing same-origin JSON buyer-write guard. Capability tokens never enter URLs. */
export function shippingBuyerRouter(service?:MerchantShippingBuyer){
 const router=express.Router();router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 router.post(['/options','/quote','/prepare','/status','/cancel','/submit'],async(req,res)=>{
  if(!service){res.status(503).json({error:{code:'SHIPPING_UNCONFIGURED'}});return;}
  try{if(req.path==='/options'){if(!exact(req.body,[]))throw new ShippingBuyerError('INVALID_SHIPPING_REQUEST');res.json(await service.options());return;}
   if(req.path==='/quote'){res.json(await service.quote(req.body));return;}
   if(!exact(req.body,req.path==='/prepare'?['quoteId','checkoutToken','contact']:['quoteId','checkoutToken']))throw new ShippingBuyerError('INVALID_SHIPPING_REQUEST');
   const {quoteId,checkoutToken}=req.body;
   res.json(req.path==='/prepare'?await service.prepare(quoteId,checkoutToken,req.body.contact):req.path==='/cancel'?await service.cancel(quoteId,checkoutToken):req.path==='/submit'?await service.submit(quoteId,checkoutToken):await service.status(quoteId,checkoutToken));
  }catch(e){const code=e instanceof ShippingBuyerError||e instanceof ShippingError||e instanceof ShippingQuoteError||e instanceof CheckoutError?e.code:'SHIPPING_UNAVAILABLE';res.status(code==='SHIPPING_EXECUTION_DISABLED'?423:code==='SHIPPING_CHECKOUT_NOT_FOUND'?404:code==='SHIPPING_UNCONFIGURED'?503:code==='SHIPPING_RATE_LIMITED'?429:409).json({error:{code}});}
 });return router;
}
