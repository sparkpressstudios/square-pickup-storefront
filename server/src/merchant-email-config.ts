import {createHash} from 'node:crypto';
import {merchantPaymentConfiguration} from './merchant-payment-config';
export interface MerchantEmailConfig {
 environment:'sandbox'|'production';merchantId:string;locationId:string;applicationId:string;
 activatedAt:string;from:string;testRecipient?:string;apiKey:string;credentialFingerprint:string;
}
export class MerchantEmailError extends Error {constructor(readonly code:string){super(code);}}
export const emailAddress=(value:unknown):value is string=>typeof value==='string'&&value.length<=254&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);
export function merchantEmailConfiguration(values:Readonly<Record<string,string|undefined>>):MerchantEmailConfig|undefined{
 if(values.MERCHANT_EMAIL_ENABLED!=='true')return undefined;
 try{
  if(values.STARTER_DATASET!=='merchant-catalog-v1'||values.SQUARE_MERCHANT_COMMERCE_ENABLED!=='true'||values.MERCHANT_EMAIL_PROVIDER!=='resend')throw new Error();
  const payment=merchantPaymentConfiguration(values),activatedAt=values.MERCHANT_EMAIL_ACTIVATED_AT;
  if(!activatedAt||new Date(activatedAt).toISOString()!==activatedAt||!emailAddress(values.MERCHANT_EMAIL_FROM)||!/^re_[A-Za-z0-9_-]{12,200}$/.test(values.MERCHANT_EMAIL_RESEND_API_KEY??''))throw new Error();
  if(payment.environment==='sandbox'&&!emailAddress(values.MERCHANT_EMAIL_SANDBOX_RECIPIENT))throw new Error();
  if(payment.environment==='production'&&values.MERCHANT_EMAIL_SANDBOX_RECIPIENT)throw new Error();
  const apiKey=values.MERCHANT_EMAIL_RESEND_API_KEY!;
  return Object.freeze({environment:payment.environment,merchantId:payment.merchantId,locationId:payment.locationId,applicationId:payment.applicationId,activatedAt,from:values.MERCHANT_EMAIL_FROM!,...(payment.environment==='sandbox'?{testRecipient:values.MERCHANT_EMAIL_SANDBOX_RECIPIENT!}:{}),apiKey,credentialFingerprint:createHash('sha256').update('resend-credential-v1\0'+apiKey).digest('hex')});
 }catch{throw new MerchantEmailError('EMAIL_CONFIGURATION_INVALID');}
}
