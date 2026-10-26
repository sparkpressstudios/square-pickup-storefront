import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {merchantEmailStatus,MerchantEmailSummary,MerchantEmailPanel} from '../client/src/merchant-email-panel';
import {MerchantConfirmation} from '../client/src/merchant-storefront';
const counts={queued:1,sending:2,retry:3,accepted:4,needs_review:5,failed:6};
const enabled={enabled:true,dispatchAllowed:true,deliveryMode:'production',provider:'resend',acceptedIsNotDelivered:true,counts};
const render=(element:ReturnType<typeof createElement>)=>renderToStaticMarkup(element);
test('email status normalizes only safe counts and rejects malformed or contradictory observations',()=>{
 const normalized=merchantEmailStatus({...enabled,items:[{recipient:'private@example.invalid',body:'private body',token:'private-capability'}],secret:'provider-secret'});
 assert.deepEqual(Object.keys(normalized).sort(),['acceptedIsNotDelivered','counts','deliveryMode','dispatchAllowed','enabled','provider']);assert.doesNotMatch(JSON.stringify(normalized),/private|secret/);
 for(const raw of [null,{...enabled,dispatchAllowed:'true'},{...enabled,deliveryMode:'disabled'},{...enabled,acceptedIsNotDelivered:false},{...enabled,provider:null},{...enabled,counts:{...counts,accepted:-1}},{...enabled,counts:{...counts,queued:1.5}},{...enabled,enabled:false,provider:null}])assert.throws(()=>merchantEmailStatus(raw));
});
test('disabled, unknown and each durable delivery state have distinct honest copy',()=>{
 const summary=render(createElement(MerchantEmailSummary,{status:merchantEmailStatus(enabled),sandbox:false}));for(const label of ['Queued','Sending / outcome pending','same-identity retry','Provider accepted — not delivery confirmation','Needs review','Failed'])assert.ok(summary.includes(label));assert.doesNotMatch(summary,/email delivered|successfully delivered/i);
 const disabled=merchantEmailStatus({...enabled,enabled:false,dispatchAllowed:false,deliveryMode:'disabled',provider:null,counts:{queued:0,sending:0,retry:0,accepted:0,needs_review:0,failed:0}});
 assert.match(render(createElement(MerchantEmailSummary,{status:disabled,sandbox:false})),/disabled \/ not configured/);
 assert.match(render(createElement(MerchantEmailSummary,{sandbox:false})),/missing measurements do not mean an empty queue/);
 assert.match(render(createElement(MerchantEmailSummary,{status:merchantEmailStatus({...enabled,deliveryMode:'sandbox-test-recipient'}),sandbox:true})),/only to the owner-configured test recipient, not to checkout customers/);
});
test('admin panel initially permits status refresh but not a send, with no rendering side effects',()=>{
 let calls=0;for(const environment of ['sandbox','production'] as const){const html=render(createElement(MerchantEmailPanel,{environment,request:async()=>{calls++;return enabled;}}));assert.match(html,/<button>Refresh email status<\/button>/);assert.match(html,/<button disabled="">Process up to 5 eligible confirmations<\/button>/);assert.doesNotMatch(html,/<input|type="password"|recipient@/);}assert.equal(calls,0);
});
test('confirmation retains private receipt and never promises email delivery',()=>{
 const value={attemptId:'a'.repeat(36),state:'completed',amountMinor:100,currency:'USD' as const,refundedMinor:0,fulfillmentState:'unfulfilled',lines:[]};
 const normal=render(createElement(MerchantConfirmation,{value,link:'#order=private'}));assert.match(normal,/no confirmation email is sent/);
 const email=render(createElement(MerchantConfirmation,{value,link:'#order=private',emailEnabled:true}));assert.match(email,/may be delayed or fail/);assert.match(email,/provider acceptance does not confirm delivery/);assert.match(email,/Save this private order-status link/);assert.doesNotMatch(email,/no confirmation email is sent/);
});
