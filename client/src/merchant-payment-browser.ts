import type {MerchantPaymentPublicConfig} from '../../shared/merchant-payment-config';
import type {SandboxBillingContact, SandboxSdk} from './square-tokenization';
const urls={sandbox:'https://sandbox.web.squarecdn.com/v1/square.js',production:'https://web.squarecdn.com/v1/square.js'} as const;
export function assertMerchantPaymentPublicConfig(config:MerchantPaymentPublicConfig):void {
 if(!config||!['sandbox','production'].includes(config.environment)||config.sdkUrl!==urls[config.environment]||typeof config.applicationId!=='string'||!(config.environment==='sandbox'?/^sandbox-sq0idb-[A-Za-z0-9_-]+$/:/^sq0id[bp]-[A-Za-z0-9_-]+$/).test(config.applicationId)||typeof config.locationId!=='string'||!/^[A-Za-z0-9]{1,64}$/.test(config.locationId))throw new Error('Merchant payment environment is not configured');
}
let loading:Promise<SandboxSdk>|undefined,loadedUrl:MerchantPaymentPublicConfig['sdkUrl']|undefined;
export function loadMerchantPaymentSdk(url:MerchantPaymentPublicConfig['sdkUrl']):Promise<SandboxSdk>{
 if(!Object.values(urls).includes(url)||!window.isSecureContext||window.location.protocol!=='https:')return Promise.reject(new Error('Secure merchant payment context required'));
 if(loading)return loadedUrl===url?loading:Promise.reject(new Error('Square payment environment changed; reload the page'));
 if(window.Square||[...document.scripts].some(script=>Object.values(urls).includes(script.src as typeof url)))return Promise.reject(new Error('An unverified Square SDK is already present; reload the page'));
 loadedUrl=url;loading=new Promise<SandboxSdk>((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.async=true;script.referrerPolicy='no-referrer';const timeout=window.setTimeout(()=>{script.remove();reject(new Error('Square payment fields timed out'));},15000);script.onload=()=>{window.clearTimeout(timeout);if(window.Square)resolve(window.Square);else reject(new Error('Square payment fields unavailable'));};script.onerror=()=>{window.clearTimeout(timeout);script.remove();reject(new Error('Square payment fields could not load'));};document.head.appendChild(script);}).catch(error=>{loading=undefined;loadedUrl=undefined;throw error;});return loading;
}
export async function attachMerchantCard(config:MerchantPaymentPublicConfig,target:string,dependencies:{isSecureContext:boolean;loadSdk:(url:MerchantPaymentPublicConfig['sdkUrl'])=>Promise<SandboxSdk>}){
 assertMerchantPaymentPublicConfig(config);if(!dependencies.isSecureContext||!/^#[A-Za-z][A-Za-z0-9_-]*$/.test(target))throw new Error('Secure card fields are required');
 const sdk=await dependencies.loadSdk(config.sdkUrl),card=await sdk.payments(config.applicationId,config.locationId).card();
 try{await card.attach(target);}catch{try{await card.destroy();}catch{}throw new Error('Square card fields could not attach');}
 let destroyed=false,inFlight:Promise<string>|undefined,identity:string|undefined;
 return {async tokenize(amountMinor:number,billingContact:SandboxBillingContact):Promise<string>{
  if(destroyed||!Number.isSafeInteger(amountMinor)||amountMinor<1||amountMinor>2_147_483_647||billingContact.countryCode!=='US'||Object.keys(billingContact).some(key=>!['givenName','familyName','email','phone','addressLines','city','state','countryCode'].includes(key)))throw new Error('Valid server-quoted USD total and billing contact required');
  const next=JSON.stringify([amountMinor,billingContact]);if(inFlight){if(next!==identity)throw new Error('Another card verification is in progress');return inFlight;}identity=next;
  inFlight=(async()=>{try{const result=await card.tokenize({amount:(amountMinor/100).toFixed(2),currencyCode:'USD',intent:'CHARGE',customerInitiated:true,sellerKeyedIn:false,billingContact:structuredClone(billingContact)});if(destroyed||result.status!=='OK'||!result.token||!/^\S{1,512}$/.test(result.token))throw new Error();return result.token;}catch{throw new Error('Card verification did not finish. No payment request was sent');}})();try{return await inFlight;}finally{inFlight=undefined;identity=undefined;}
 },async destroy(){if(!destroyed){destroyed=true;await card.destroy();}}};
}
