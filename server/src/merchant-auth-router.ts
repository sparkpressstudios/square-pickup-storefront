import express from 'express';
import type { Request } from 'express';
import { validWriteOrigin } from './origin';
import type { MerchantStaffAuth } from './merchant-staff-auth';
import { MerchantAuthError, merchantSessionCookieName } from './merchant-staff-auth';

function matchesCsrf(actual: string | undefined, expected: string): boolean {
  // Token comparison stays in the original authenticated staff router as well.
  if (!actual || actual.length !== expected.length || !/^[A-Za-z0-9_-]{43}$/.test(actual)) return false;
  return (awaitSafeConstantTime(actual, expected));
}
import { timingSafeEqual } from 'node:crypto';
function awaitSafeConstantTime(a: string, b: string) {
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function loginBody(value: unknown): value is { password: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys=Object.keys(value);
  return keys.length===1 && keys[0]==='password' &&
    typeof (value as { password?: unknown }).password === 'string' &&
    Buffer.byteLength((value as { password: string }).password,'utf8')<=128;
}
function removeCookie(res: express.Response) {
  res.clearCookie(merchantSessionCookieName, { path:'/', secure:true, httpOnly:true, sameSite:'strict' });
}
function reqOrigin(req: Request, auth: MerchantStaffAuth) { return validWriteOrigin(req,auth.origin,true); }
/** No route accepts role headers, token values, or unverified staff IDs. The current pilot never injects auth. */
export function merchantAuthRouter(auth?: MerchantStaffAuth) {
  const router=express.Router();
  router.use((_req,res,next)=>{ res.set('Cache-Control','no-store'); next(); });
  router.get('/status',(_req,res)=>res.json({enabled:Boolean(auth),scope:'merchant-only',session:'server-side',productionCheckoutEnabled:false}));
  router.use((req,res,next)=>{
    if (!auth) { res.status(503).json({error:{code:'AUTH_NOT_CONFIGURED',message:'Merchant staff sign-in is not configured for this store.'}}); return; }
    next();
  });
  router.post('/login',(req,res,next)=>{
    if (!reqOrigin(req,auth!)) {res.status(403).json({error:{code:'INVALID_ORIGIN',message:'Use this store origin.'}});return;}
    if (!req.is('application/json')) {res.status(415).json({error:{code:'INVALID_REQUEST',message:'Send application/json.'}});return;}
    next();
  },express.json({limit:'1kb',strict:true}),async(req,res)=>{
    if (!loginBody(req.body)) {res.status(400).json({error:{code:'INVALID_REQUEST',message:'A single password is required.'}});return;}
    try {
      const session=await auth!.login(req.body.password);
      res.cookie(merchantSessionCookieName,session.token,{path:'/',httpOnly:true,secure:true,sameSite:'strict',maxAge:session.expiresSeconds*1000});
      res.json({signedIn:true,role:'admin',expiresInSeconds:session.expiresSeconds});
    } catch(e) {
      if (e instanceof MerchantAuthError && e.code==='LOGIN_RATE_LIMITED') {
        res.set('Retry-After','900');
        res.status(429).json({error:{code:'LOGIN_RATE_LIMITED',message:'Too many sign-in attempts. Try again later.'}});return;
      }
      res.status(401).json({error:{code:'INVALID_CREDENTIALS',message:'Unable to sign in with these credentials.'}});
    }
  });
  router.post('/logout',async(req,res)=>{
    if (!reqOrigin(req,auth!)) {res.status(403).json({error:{code:'INVALID_ORIGIN',message:'Use this store origin.'}});return;}
    try {
      const staff=await auth!.verifyStaff(req);
      if (!staff) {res.status(401).json({error:{code:'STAFF_AUTH_REQUIRED',message:'Sign-in required.'}});return;}
      if (!matchesCsrf(req.get('X-CSRF-Token'),staff.csrfToken)) {
        res.status(403).json({error:{code:'INVALID_CSRF',message:'Invalid staff session request.'}});return;
      }
      await auth!.logout(req);
      removeCookie(res);
      res.json({signedOut:true});
    }catch {res.status(503).json({error:{code:'SESSION_UNAVAILABLE',message:'Unable to revoke the current session.'}});}
  });
  return router;
}
