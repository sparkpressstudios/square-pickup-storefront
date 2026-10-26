import {createHash,randomUUID} from 'node:crypto';
import type {SqlDatabase} from '../../db/sql-database';
import {assertMerchantEmailSchema} from '../../db/merchant-email';
import {merchantEmailConfiguration,emailAddress,MerchantEmailError,type MerchantEmailConfig} from './merchant-email-config';
const states=['queued','sending','retry','accepted','needs_review','failed'] as const;
type State=typeof states[number];
type Payload={from:string;to:string[];subject:string;text:string};
type Row={id:string;attempt_id:string;state:State;attempts:number;payload:Payload;payload_hash:string;idempotency_key:string;claim_token:string;first_dispatch_at:Date|string|null;credential_fingerprint:string|null};
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>JSON.stringify(key)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
const fingerprint=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function clean(value:unknown,max=200):string {if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw new MerchantEmailError('EMAIL_CONTENT_INVALID');return value;}
function render(row:any,config:MerchantEmailConfig):Payload{
 const recipient=config.testRecipient??row.pickup?.email;if(!emailAddress(recipient))throw new MerchantEmailError('EMAIL_CONTENT_INVALID');
 const name=clean(row.settings?.branding?.name??'Your store',100);
 const pricing=row.pricing;if(pricing?.currency!=='USD'||!Number.isSafeInteger(pricing.totalMinor)||pricing.totalMinor<1)throw new MerchantEmailError('EMAIL_CONTENT_INVALID');
 if(!Array.isArray(row.lines)||row.lines.length<1||row.lines.length>50)throw new MerchantEmailError('EMAIL_CONTENT_INVALID');
 const lines=row.lines.map((line:any)=>{if(!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>99)throw new MerchantEmailError('EMAIL_CONTENT_INVALID');return line.quantity+' × '+clean(line.name)+' — '+clean(line.variation??'Standard');});
 const pickup=row.pickup_at?new Date(row.pickup_at).toISOString():'Contact the store for pickup details';
 return {from:config.from,to:[recipient],subject:(config.environment==='sandbox'?'[SANDBOX] ':'')+name+' — order confirmation',text:[
  config.environment==='sandbox'?'Sandbox test only. No real pickup or fulfillment.':'This confirms the original completed payment, not current refund or fulfillment status.',
  name,'Order reference: '+row.id,...lines,'Total: USD '+(pricing.totalMinor/100).toFixed(2),
  'Pickup time (UTC): '+pickup,'Keep your private checkout confirmation for order status. Contact the store for changes.',
 ].join('\n')};
}
const disabledStatus=()=>({enabled:false,provider:null,dispatchAllowed:false,deliveryMode:'disabled',acceptedIsNotDelivered:true,counts:Object.fromEntries(states.map(state=>[state,0])),items:[]});
export class MerchantEmailService{
 private busy=false;
 constructor(private readonly db:SqlDatabase,private readonly values:Readonly<Record<string,string|undefined>>,readonly config:MerchantEmailConfig,private readonly transport:typeof fetch){}
 /** Reconciliation is separate from payment transactions. Crash gaps are recovered on next enabled startup/drain. */
 async reconcile(){
  await assertMerchantEmailSchema(this.db,this.values);
  return this.db.transaction(async tx=>{
   const rows=(await tx.query<any>("SELECT a.id,a.pickup,a.pickup_at,q.pricing,q.line_snapshot AS lines,c.operating_settings AS settings FROM merchant_commerce_attempts a JOIN merchant_commerce_quotes q ON q.id=a.id CROSS JOIN merchant_commerce_config c WHERE a.state='completed' AND a.refunded_minor<(q.pricing->>'totalMinor')::integer AND a.created_at>=$1 AND NOT EXISTS(SELECT 1 FROM merchant_email_outbox e WHERE e.attempt_id=a.id AND e.kind='order_confirmation') ORDER BY a.created_at,a.id LIMIT 20 FOR UPDATE OF a SKIP LOCKED",[this.config.activatedAt])).rows;
   for(const row of rows){
    let payload:Payload|Record<string,never>,state='queued',failure:string|null=null;
    try{payload=render(row,this.config);}catch{payload={};state='failed';failure='EMAIL_CONTENT_INVALID';}
    const key='order-confirmation/'+fingerprint([this.config.environment,this.config.merchantId,this.config.locationId,this.config.applicationId,row.id]);
    await tx.query("INSERT INTO merchant_email_outbox(id,attempt_id,kind,idempotency_key,payload,payload_hash,state,failure_code) VALUES($1,$2,'order_confirmation',$3,$4::jsonb,$5,$6,$7) ON CONFLICT(attempt_id,kind) DO NOTHING",[randomUUID(),row.id,key,JSON.stringify(payload),fingerprint(payload),state,failure]);
   }
   return rows.length;
  });
 }
 async status(){
  await assertMerchantEmailSchema(this.db,this.values);
  const groups=(await this.db.query<{state:State;count:string}>('SELECT state,count(*)::text AS count FROM merchant_email_outbox GROUP BY state')).rows;
  const counts=Object.fromEntries(states.map(state=>[state,0]));for(const group of groups){const count=Number(group.count);if(!states.includes(group.state)||!Number.isSafeInteger(count))throw new MerchantEmailError('EMAIL_STATUS_UNAVAILABLE');counts[group.state]=count;}
  const items=(await this.db.query('SELECT id,attempt_id AS "attemptId",state,attempts,created_at AS "createdAt",updated_at AS "updatedAt",next_attempt_at AS "nextAttemptAt",failure_code AS "failureCode",provider_message_id AS "providerMessageId" FROM merchant_email_outbox ORDER BY created_at DESC,id LIMIT 20')).rows;
  return {enabled:true,provider:'resend',dispatchAllowed:true,deliveryMode:this.config.environment==='production'?'production':'sandbox-test-recipient',acceptedIsNotDelivered:true,counts,items};
 }
 private async claim():Promise<Row|undefined>{
  return this.db.transaction(async tx=>{
   // A crash after provider acceptance is unknown. Retry only inside the original key retention window.
   await tx.query("UPDATE merchant_email_outbox SET state='retry',claim_token=NULL,lease_until=NULL,failure_code='EMAIL_OUTCOME_UNKNOWN',updated_at=now() WHERE state='sending' AND lease_until<=clock_timestamp()");
   await tx.query("UPDATE merchant_email_outbox SET state='needs_review',claim_token=NULL,lease_until=NULL,failure_code='EMAIL_RETRY_REQUIRES_REVIEW',updated_at=now() WHERE state IN('queued','retry') AND (attempts>=5 OR COALESCE(first_dispatch_at,created_at)<=clock_timestamp()-interval '23 hours' OR (credential_fingerprint IS NOT NULL AND credential_fingerprint<>$1))",[this.config.credentialFingerprint]);
   const row=(await tx.query<Row>("SELECT * FROM merchant_email_outbox WHERE state IN('queued','retry') AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];if(!row)return;
   if(fingerprint(row.payload)!==row.payload_hash){await tx.query("UPDATE merchant_email_outbox SET state='needs_review',failure_code='EMAIL_PAYLOAD_CHANGED',updated_at=now() WHERE id=$1",[row.id]);return;}
   const token=randomUUID();
   return (await tx.query<Row>("UPDATE merchant_email_outbox SET state='sending',attempts=attempts+1,claim_token=$2,lease_until=clock_timestamp()+interval '60 seconds',first_dispatch_at=COALESCE(first_dispatch_at,clock_timestamp()),credential_fingerprint=COALESCE(credential_fingerprint,$3),updated_at=now() WHERE id=$1 RETURNING *",[row.id,token,this.config.credentialFingerprint])).rows[0];
  });
 }
 private async send(row:Row){
  // Revalidate immediately before network IO: a suspended claimant may have lost its lease.
  const owned=(await this.db.query("SELECT id FROM merchant_email_outbox WHERE id=$1 AND state='sending' AND claim_token=$2 AND lease_until>clock_timestamp() AND first_dispatch_at>clock_timestamp()-interval '23 hours' AND credential_fingerprint=$3 AND payload_hash=$4 AND payload=$5::jsonb",[row.id,row.claim_token,this.config.credentialFingerprint,row.payload_hash,JSON.stringify(row.payload)])).rows.length===1;
  if(!owned)return;

  let state:State='retry',failure:string|null='EMAIL_OUTCOME_UNKNOWN',messageId:string|null=null;
  try{
   const response=await this.transport('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+this.config.apiKey,'Content-Type':'application/json','Idempotency-Key':row.idempotency_key},body:canonical(row.payload)});
   if(response.status===200||response.status===201){
    if(Number(response.headers.get('content-length')??0)>65536)throw new Error();
    const reader=response.body?.getReader();if(!reader)throw new Error();const parts:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536)throw new Error();parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
    const result=JSON.parse(Buffer.concat(parts).toString('utf8'));if(typeof result.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.id))throw new Error();
    state='accepted';failure=null;messageId=result.id;
   }else{
    await response.body?.cancel().catch(()=>{});
    if(response.status===409){state='needs_review';failure='EMAIL_IDEMPOTENCY_CONFLICT';}
    else if([400,401,403,404,422].includes(response.status)){state=row.attempts===1?'failed':'needs_review';failure='EMAIL_PROVIDER_REJECTED';}
    else {state='retry';failure=response.status===429?'EMAIL_RATE_LIMITED':'EMAIL_OUTCOME_UNKNOWN';}
   }
  }catch{/* Never record raw provider errors, tokens, addresses or message bodies. */}
  if(state==='retry'&&row.attempts>=5){state='needs_review';failure='EMAIL_ATTEMPTS_EXHAUSTED';}
  await this.db.query("UPDATE merchant_email_outbox SET state=$3,claim_token=NULL,lease_until=NULL,provider_message_id=$4,failure_code=$5,next_attempt_at=clock_timestamp()+($6::integer*interval '1 second'),updated_at=now() WHERE id=$1 AND state='sending' AND claim_token=$2",[row.id,row.claim_token,state,messageId,failure,Math.min(3600,30*2**row.attempts)]);
 }
 async drain(){
  await this.reconcile();
  let attempted=0;for(;attempted<5;attempted++){const row=await this.claim();if(!row)break;await this.send(row);}
  return {...await this.status(),attempted};
 }
 /** No timer or polling. Only enabled startup, completed-request hooks, and explicit admin drains. */
 kick(){if(this.busy)return;this.busy=true;void this.drain().catch(()=>{}).finally(()=>{this.busy=false;});}
}
export function createMerchantEmailService(db:SqlDatabase,values:Readonly<Record<string,string|undefined>>,transport:typeof fetch=fetch){
 const config=merchantEmailConfiguration(values);return config?new MerchantEmailService(db,Object.freeze({...values}),config,transport):undefined;
}
export const merchantEmailDisabledStatus=disabledStatus;
