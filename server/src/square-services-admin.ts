import express from 'express';
import type { StaffPrincipal } from './admin-catalog';
import { SquareServiceError, type SquareServices } from './square-services';
import { SquarePreorderError } from './square-preorders';
import { SquareHistoryError } from './square-service-history';
import { SquarePromotionError, type SquarePromotionService } from './square-promotion-preview';

function exactBody(input:unknown, keys:readonly string[]): input is Record<string,unknown> {
  if(!input || typeof input!=='object' || Array.isArray(input) ||
      Object.getPrototypeOf(input)!==Object.prototype) return false;
  const fields=Object.keys(input);
  return fields.length===keys.length && keys.every(field=>Object.hasOwn(input,field));
}
function replyError(res: express.Response,error:unknown) {
  const code = error instanceof SquareServiceError || error instanceof SquarePreorderError || error instanceof SquareHistoryError || error instanceof SquarePromotionError ? error.code : 'UNAVAILABLE';
  const status = ['INVALID_INPUT','INVALID_WINDOW','INVALID_PICKUP_TIME','INVALID_ITEMS'].includes(code)?400:
    ['CATALOG_PRICE_MISMATCH','UNMAPPED_VARIATION'].includes(code)?409:
    code==='RATE_LIMITED'?429:503;
  res.status(status).json({error:{code,message:'Square service unavailable or its input was rejected.'}});
}
/** Exposed only behind existing verified administrator cookie, same-origin and CSRF middleware. */
export function squareServicesAdminRouter(service?:SquareServices,promotion?:SquarePromotionService) {
  const router=express.Router();
  router.use((_req,res,next)=>{
    if((res.locals.staff as StaffPrincipal|undefined)?.role!=='admin') {
      res.status(403).json({error:{code:'ADMIN_REQUIRED',message:'Administrator privileges are required.'}});return;
    }
    if(!service) {
      res.status(503).json({error:{code:'SQUARE_SERVICES_DISABLED',message:'Merchant Square services have not been enabled.'}});return;
    }
    next();
  });
  router.get('/capabilities',(_req,res)=>res.json({...service!.availability,promotionsPreview:Boolean(promotion)}));
  const json=[(req:express.Request,res:express.Response,next:express.NextFunction)=>{
    if(!req.is('application/json')) {res.status(415).json({error:{code:'INVALID_REQUEST',message:'Use application/json.'}});return;}
    next();
  },express.json({strict:true,limit:'2kb'})];
  router.get('/promotions/variations',async(_req,res)=>{
    if(!promotion){res.status(503).json({error:{code:'FEATURE_DISABLED',message:'Square pricing preview is not enabled.'}});return;}
    try{res.json({mode:'sandbox-read-only',variations:await promotion.variations()});}
    catch(error){replyError(res,error);}
  });
  router.post('/promotions/quote',...json,async(req,res)=>{
    if(!promotion){res.status(503).json({error:{code:'FEATURE_DISABLED',message:'Square pricing preview is not enabled.'}});return;}
    if(!exactBody(req.body,['items'])){res.status(400).json({error:{code:'INVALID_ITEMS',message:'Supply only catalog variation IDs and quantities.'}});return;}
    try{res.json(await promotion.quote(req.body));}
    catch(error){replyError(res,error);}
  });
  router.post('/promotions/gift-card-coverage',...json,async(req,res)=>{
    if(!promotion){res.status(503).json({error:{code:'FEATURE_DISABLED',message:'Square pricing preview is not enabled.'}});return;}
    if(!exactBody(req.body,['items','cardId'])){res.status(400).json({error:{code:'INVALID_INPUT',message:'Use only server-known variations and Square gift card ID.'}});return;}
    try{res.json(await promotion.giftCoverage({items:req.body.items},req.body.cardId));}
    catch(error){replyError(res,error);}
  });
  router.get('/preorders/products',(_req,res)=>{
    if(!service!.preorderProducts){res.status(503).json({error:{code:'FEATURE_DISABLED',message:'Product release previews are unavailable.'}});return;}
    try{res.json({products:service!.preorderProducts()});}catch(error){replyError(res,error);}
  });
  router.post('/preorders/product-preview',...json,(req,res)=>{
    if(!exactBody(req.body,['productId','quantity','pickupAt'])){res.status(400).json({error:{code:'INVALID_INPUT',message:'Supply product, quantity, and pickup time.'}});return;}
    if(!service!.preorderProduct){res.status(503).json({error:{code:'FEATURE_DISABLED',message:'Product release previews are unavailable.'}});return;}
    try{res.json(service!.preorderProduct(req.body));}catch(error){replyError(res,error);}
  });
  router.get('/preorders/slots',(req,res)=>{
    if(typeof req.query.date!=='string' || Object.keys(req.query).sort().join(',')!=='date'){
      res.status(400).json({error:{code:'INVALID_INPUT',message:'Provide a valid pickup date.'}});return;
    }
    try{res.json(service!.preorderSlots(req.query.date));}catch(error){replyError(res,error);}
  });
  router.post('/preorders/preview',...json,(req,res)=>{
    if(!exactBody(req.body,['pickupAt','windowMinutes'])) {
      res.status(400).json({error:{code:'INVALID_INPUT',message:'Supply an explicit pickup time and window.'}});return;
    }
    try {res.json(service!.preorder(req.body));} catch(error){replyError(res,error);}
  });
  router.post('/gift-cards/lookup',...json,async(req,res)=>{
    if(!exactBody(req.body,['cardId'])) {
      res.status(400).json({error:{code:'INVALID_INPUT',message:'Supply a Square gift card ID.'}});return;
    }
    try {res.json(await service!.giftCard(req.body.cardId));} catch(error){replyError(res,error);}
  });
  router.post('/gift-cards/coverage',...json,async(req,res)=>{
    if(!exactBody(req.body,['cardId','orderTotalMinor'])){
      res.status(400).json({error:{code:'INVALID_INPUT',message:'Supply a gift card ID and illustrative total.'}});return;
    }
    try{res.json(await service!.giftCardCoverage(req.body.cardId,req.body.orderTotalMinor));}
    catch(error){replyError(res,error);}
  });
  router.get('/loyalty/program',async(_req,res)=>{
    try {res.json(await service!.loyaltyProgram());} catch(error){replyError(res,error);}
  });
  router.post('/loyalty/accounts/lookup',...json,async(req,res)=>{
    if(!exactBody(req.body,['accountId'])) {
      res.status(400).json({error:{code:'INVALID_INPUT',message:'Supply a Square loyalty account ID.'}});return;
    }
    try {res.json(await service!.loyaltyAccount(req.body.accountId));} catch(error){replyError(res,error);}
  });
  router.post('/gift-cards/activities',...json,async(req,res)=>{
    if(!exactBody(req.body,['cardId'])){
      res.status(400).json({error:{code:'INVALID_INPUT',message:'Provide a Square gift card ID.'}});return;
    }
    try{res.json(await service!.giftCardActivities(req.body.cardId));}
    catch(error){replyError(res,error);}
  });
  router.post('/loyalty/rewards/history',...json,async(req,res)=>{
    if(!exactBody(req.body,['accountId'])){
      res.status(400).json({error:{code:'INVALID_INPUT',message:'Provide a Square loyalty account ID.'}});return;
    }
    try{res.json(await service!.loyaltyRewards(req.body.accountId));}
    catch(error){replyError(res,error);}
  });
  router.post('/loyalty/events/history',...json,async(req,res)=>{
    if(!exactBody(req.body,['accountId'])){
      res.status(400).json({error:{code:'INVALID_INPUT',message:'Provide a Square loyalty account ID.'}});return;
    }
    try{res.json(await service!.loyaltyEvents(req.body.accountId));}
    catch(error){replyError(res,error);}
  });
  router.post('/loyalty/rewards/eligibility',...json,async(req,res)=>{
    if(!exactBody(req.body,['accountId'])){res.status(400).json({error:{code:'INVALID_INPUT',message:'Supply only the Square loyalty account ID.'}});return;}
    if(!service!.rewardEligibility){res.status(503).json({error:{code:'FEATURE_DISABLED',message:'Loyalty eligibility is unavailable.'}});return;}
    try{res.json(await service!.rewardEligibility(req.body.accountId));}
    catch(error){replyError(res,error);}
  });
  router.post('/loyalty/points/estimate',...json,async(req,res)=>{
    if(!exactBody(req.body,['orderId'])&&!exactBody(req.body,['orderId','accountId'])){
      res.status(400).json({error:{code:'INVALID_INPUT',message:'Supply a Square order ID and optional loyalty account ID.'}});return;
    }
    try{res.json(await service!.estimateLoyaltyPoints(req.body.orderId,req.body.accountId));}
    catch(error){replyError(res,error);}
  });
  return router;
}
