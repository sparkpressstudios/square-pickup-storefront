import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MerchantStorefront,verifyMerchantAttempt,merchantCartQuantity,validMerchantLookupToken,safeSquareReceiptUrl,verifyMerchantConfirmation,MerchantConfirmation,checkoutAuthorizationRecord,readCheckoutAuthorization,promisedPickupLabel} from '../client/src/merchant-storefront';
import {MerchantOrderLines,orderHistoryPage,refundAmountMinor} from '../client/src/merchant-operations';
import {MerchantSetupPanel,emptyMerchantSetup} from '../client/src/merchant-setup-panel';
import {merchant} from '../config/merchant';
import {demoCatalog} from '../config/demo-catalog';
const product=demoCatalog.products[0]!,variant=product.variants[0]!,items=[{productId:product.id,variantId:variant.id,quantity:1}];
test('cart quantity changes are immutable, stock-bounded and invalidate stale unavailable selections by removal',()=>{
 const updated=merchantCartQuantity(items,variant.id,2,demoCatalog);assert.equal(updated[0]?.quantity,2);assert.equal(items[0]?.quantity,1);
 for(const value of [-1,1.5,100,NaN])assert.throws(()=>merchantCartQuantity(items,variant.id,value,demoCatalog));
 assert.deepEqual(merchantCartQuantity(items,variant.id,0,{currency:'USD',products:[]}),[]);
 assert.throws(()=>merchantCartQuantity(items,'missing',1,demoCatalog));
});
test('refund input handles exact cents and rejects exponent, fractions, over-refunds and nonpositive amounts',()=>{
 assert.equal(refundAmountMinor('1.01',200),101);assert.equal(refundAmountMinor(' 2 ',200),200);
 for(const value of ['0','-1','1.001','1e2','Infinity','abc','2.01'])assert.throws(()=>refundAmountMinor(value,200));
});
const order={id:'checkout-reference',state:'completed',pickup:{name:'Test customer',email:'qa@example.invalid',phone:'+12025550100'},order_id:'order',payment_id:'payment',refunded_minor:0,fulfillment_state:'unfulfilled',pricing:{totalMinor:191},created_at:'2026-10-25T16:00:00Z'};
test('history supports server cursor pages without pretending a legacy recent window is complete',()=>{
 assert.equal(orderHistoryPage([order]).legacy,true);assert.equal(orderHistoryPage([order]).nextCursor,null);
 const result=orderHistoryPage({orders:[order],nextCursor:'next_page'});assert.equal(result.legacy,false);assert.equal(result.nextCursor,'next_page');
 for(const invalid of [null,{}, {orders:[{}]}, {orders:[order],nextCursor:'\nsecret'}, {orders:[{...order,pricing:{totalMinor:-1}}]}])assert.throws(()=>orderHistoryPage(invalid));
});
test('merchant operations render item names quantities and historical missing-detail warning',()=>{
 const html=renderToStaticMarkup(createElement(MerchantOrderLines,{lines:[{name:'Test mug',variation:'Blue',quantity:2,unitPriceMinor:200,totalMinor:382}]}));
 assert.match(html,/Test mug/);assert.match(html,/Blue/);assert.match(html,/2 × \$2.00/);assert.match(html,/\$3.82/);
 assert.match(renderToStaticMarkup(createElement(MerchantOrderLines,{lines:undefined})),/Verify the Square order before fulfillment/);
});

test('private order tokens require canonical 32-byte base64url and receipt links stay on Square receipt hosts',()=>{
 const token=Buffer.alloc(32,1).toString('base64url');assert.equal(validMerchantLookupToken(token),true);
 for(const bad of [token+'x','checkout-reference',token.slice(0,-1)+'B','javascript:alert(1)',null])assert.equal(validMerchantLookupToken(bad),false);
 assert.equal(safeSquareReceiptUrl('https://squareup.com/receipt/preview/test'),'https://squareup.com/receipt/preview/test');
 for(const bad of ['https://squareup.com.attacker.example/receipt/test','https://user:pass@squareup.com/receipt/test','javascript:alert(1)','https://squareup.com/redirect?to=attacker','http://squareup.com/receipt/test'])assert.equal(safeSquareReceiptUrl(bad),undefined);
});
test('confirmation normalizes only non-contact order fields and renders private-link warning',()=>{
 const raw={attemptId:'11111111-1111-4111-8111-111111111111',state:'completed',amountMinor:191,currency:'USD',refundedMinor:0,fulfillmentState:'ready',lines:[{name:'QA mug',quantity:1,unitPriceMinor:200,totalMinor:191}],pickup:{email:'private@example.invalid'},receiptUrl:'https://evil.example/receipt'};
 const checked=verifyMerchantConfirmation(raw);assert.equal('pickup' in checked,false);assert.equal(checked.receiptUrl,undefined);
 const html=renderToStaticMarkup(createElement(MerchantConfirmation,{value:checked,link:'#order='+Buffer.alloc(32,1).toString('base64url')}));
 assert.match(html,/Payment confirmed/);assert.match(html,/Anyone with this link/);assert.match(html,/no confirmation email is sent by this template/);assert.match(html,/Quantity 1/);assert.doesNotMatch(html,/private@example|evil.example/);
 for(const change of [{amountMinor:-1},{currency:'EUR'},{refundedMinor:192},{lines:[{name:'Bad',quantity:-1,unitPriceMinor:1,totalMinor:1}]},{pickupAt:'not-a-time'}])assert.throws(()=>verifyMerchantConfirmation({...raw,...change}));
});

test('checkout write authorization is bound to its own attempt and cannot be recovered from a UUID',()=>{
 const id='11111111-1111-4111-8111-111111111111',token=Buffer.alloc(32,2).toString('base64url');const record=checkoutAuthorizationRecord(id,token);assert.equal(readCheckoutAuthorization(record,id),token);
 for(const raw of [null,'not-json',JSON.stringify({attemptId:id}),JSON.stringify({attemptId:'different',token})])assert.throws(()=>readCheckoutAuthorization(raw,id));
 assert.throws(()=>checkoutAuthorizationRecord(id,'bad-token'));
});
test('pickup display uses server-provided store timezone rather than browser-local arithmetic',()=>{
 const label=promisedPickupLabel('2026-11-01T06:30:00Z','America/New_York');assert.ok(label?.includes('1:30'));assert.ok(label?.includes('EST'));
 assert.equal(promisedPickupLabel('bad','America/New_York'),undefined);assert.equal(promisedPickupLabel('2026-11-01T06:30:00Z','Unknown/Zone'),undefined);
});

test('setup form begins unreviewed with no invented hours and never asks for provider credentials',()=>{
 const draft=emptyMerchantSetup();assert.equal(draft.reviewed,false);assert.equal(draft.inventory.allocationReviewed,false);assert.deepEqual(draft.pickup.weeklyHours,[]);assert.equal(draft.pickup.timeZone,'');
 const html=renderToStaticMarkup(createElement(MerchantSetupPanel,{request:async()=>{throw new Error('No network in render');}}));assert.match(html,/Square POS — synchronization unavailable/);assert.match(html,/not private, signed or credential-bearing links/);assert.doesNotMatch(html,/type="password"|ACCESS_TOKEN|SIGNATURE_KEY|SESSION_KEY/);
});

test('production UI mode requires explicit matching public payment configuration and status mode',()=>{
 const html=renderToStaticMarkup(createElement(MerchantStorefront,{storefront:{mode:'merchant-production',merchant,catalog:demoCatalog,payment:{environment:'production',applicationId:'sq0idp-unit-only',locationId:'LOCATION',sdkUrl:'https://web.squarecdn.com/v1/square.js'}}}));assert.doesNotMatch(html,/SQUARE SANDBOX/);assert.match(html,/ORDER SUPPORT/);
 const view={attemptId:'11111111-1111-4111-8111-111111111111',state:'completed',amountMinor:191,currency:'USD',orderId:'order',paymentId:'payment',refundedMinor:0,failureCode:null,fulfillmentState:'ready',requiresReconciliation:false,fulfillmentAuthorized:true,mode:'merchant-production'};
 assert.throws(()=>verifyMerchantAttempt(view,view.attemptId));assert.equal(verifyMerchantAttempt(view,view.attemptId,'merchant-production').mode,'merchant-production');
});
