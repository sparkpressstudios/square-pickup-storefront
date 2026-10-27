import test from 'node:test';
import assert from 'node:assert/strict';
import {parseShippingAddress,parseFixedShippingPolicy,buildShippingDraft,shippingDraftFingerprint,assertShippingDraftUnchanged} from '../server/src/merchant-shipping';
const address={name:'Fixture Recipient',line1:'123 Test Street',city:'Testville',region:'PA',postalCode:'17000',country:'US'};
const policy={enabled:true,revision:'fixture-v1',rates:[{id:'ground',label:'Ground',regions:['PA','NY'],amountMinor:500}]};
test('shipping address has bounded explicit domestic fields, normalization and no input mutation',()=>{
 const input={...address,name:' Fixture Recipient ',region:'pa',line2:' Unit 2 '};const before=structuredClone(input);const result=parseShippingAddress(input);
 assert.equal(result.region,'PA');assert.equal(result.name,'Fixture Recipient');assert.equal(result.line2,'Unit 2');assert.deepEqual(input,before);assert.ok(Object.isFrozen(result));
 for(const invalid of [null,[],{...address,country:'CA'},{...address,region:'XX'},{...address,postalCode:'1e005'},{...address,line1:'bad\nheader'},{...address,fee:0},{...address,line2:''},{...address,name:'a'.repeat(101)}])assert.throws(()=>parseShippingAddress(invalid),/INVALID_ADDRESS/);
});
test('fixed shipping policy requires trusted configuration, exact schema and bounded integer fees',()=>{
 const parsed=parseFixedShippingPolicy(policy);assert.ok(Object.isFrozen(parsed.rates));assert.ok(Object.isFrozen(parsed.rates[0]!.regions));
 for(const invalid of [{...policy,enabled:'true'},{...policy,rates:[]},{...policy,revision:''},{...policy,rates:[policy.rates[0],policy.rates[0]]},...[NaN,Infinity,-1,1.1,100001,'500'].map(amountMinor=>({...policy,rates:[{...policy.rates[0],amountMinor}]})),{...policy,rates:[{...policy.rates[0],regions:['PA','PA']}]},{...policy,rates:[{...policy.rates[0],regions:['ZZ']}]}])assert.throws(()=>parseFixedShippingPolicy(invalid),/INVALID_SHIPPING_POLICY/);
});
test('fee preview selects server policy only and never implies tax calculated or checkout enabled',()=>{
 const draft=buildShippingDraft(policy,address,'ground');assert.equal(draft.shippingFeeMinor,500);assert.equal(draft.taxStatus,'unresolved');assert.equal(draft.checkoutEnabled,false);assert.equal('totalMinor' in draft,false);assert.ok(Object.isFrozen(draft));
 assert.throws(()=>buildShippingDraft({...policy,enabled:false},address,'ground'),/SHIPPING_DISABLED/);
 assert.throws(()=>buildShippingDraft(policy,{...address,region:'CA'},'ground'),/SHIPPING_UNAVAILABLE/);
 assert.throws(()=>buildShippingDraft(policy,address,'free'),/SHIPPING_UNAVAILABLE/);
 const free=buildShippingDraft({...policy,rates:[{...policy.rates[0],amountMinor:0}]},address,'ground');assert.equal(free.shippingFeeMinor,0);assert.equal(free.taxStatus,'unresolved');
});
test('immutable fulfillment identity detects address, fee, rate and policy changes',()=>{
 const original=buildShippingDraft(policy,address,'ground'),same=buildShippingDraft(policy,{...address},'ground');assertShippingDraftUnchanged(original,same);assert.match(shippingDraftFingerprint(original),/^[0-9a-f]{64}$/);
 for(const changed of [buildShippingDraft(policy,{...address,line1:'124 Test Street'},'ground'),buildShippingDraft({...policy,revision:'fixture-v2'},address,'ground'),buildShippingDraft({...policy,rates:[{...policy.rates[0],amountMinor:600}]},address,'ground'),buildShippingDraft({...policy,rates:[{...policy.rates[0],id:'other'}]},address,'other')])assert.throws(()=>assertShippingDraftUnchanged(original,changed),/SHIPPING_CHANGED/);
});

test('offline Square shipment fragment preserves address and does not inherit pickup states',async()=>{
 const {shipmentFulfillmentPreview,verifyShipmentFragment,shipmentStateLabel}=await import('../server/src/merchant-shipment-preview');
 const draft=buildShippingDraft(policy,address,'ground'),contact={email:'fixture@example.invalid',phone:'+15555550123'};
 const preview=shipmentFulfillmentPreview(draft,contact);assert.equal(preview.type,'SHIPMENT');assert.equal('pickup_details' in preview,false);assert.equal(preview.shipment_details.recipient.address.postal_code,'17000');
 const evidence={...preview,uid:'fixture-fulfillment',state:'COMPLETED'};const verified=verifyShipmentFragment(evidence,draft,contact,'fixture-fulfillment');assert.equal(verified.label,'Shipped');assert.equal(verified.deliveryVerified,false);assert.equal(verified.paymentVerified,false);assert.equal(shipmentStateLabel('PREPARED'),'Packaged');
 for(const bad of [{...evidence,type:'PICKUP'},{...evidence,uid:'other'},{...evidence,state:'picked_up'},{...evidence,pickup_details:{}},{...evidence,shipment_details:{recipient:{...preview.shipment_details.recipient,address:{...preview.shipment_details.recipient.address,postal_code:'10000'}}}}])assert.throws(()=>verifyShipmentFragment(bad,draft,contact,'fixture-fulfillment'),/UNVERIFIED_SHIPMENT/);
 assert.throws(()=>shipmentFulfillmentPreview(draft,{...contact,phone:'123'}),/UNVERIFIED_SHIPMENT/);
});
test('read-only shipping preview clearly blocks checkout and escapes user supplied text',async()=>{
 const {createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{ShippingDraftSummary}=await import('../client/src/shipping-draft-summary');
 const draft=buildShippingDraft({...policy,rates:[{...policy.rates[0],label:'<script>bad</script>'}]},address,'ground');
 const html=renderToStaticMarkup(createElement(ShippingDraftSummary,{draft}));assert.match(html,/not enabled/);assert.match(html,/tax is unresolved/);assert.match(html,/not a payable quote/);assert.match(html,/\$5.00/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<button|<form/);
});

test('isolated development draft schema preserves immutable identity, scope and history',async()=>{
 const {PGlite}=await import('@electric-sql/pglite'),{readFile}=await import('node:fs/promises'),{ShippingDraftStore}=await import('../server/src/merchant-shipping-drafts');
 const db=await PGlite.create();try {
  await db.exec(await readFile(new URL('../db/merchant-shipping-drafts.sql',import.meta.url),'utf8'));
  const store=new ShippingDraftStore(db,{merchantId:'fixture-merchant',locationId:'fixture-location'});
  const input={id:'55555555-5555-4555-8555-555555555555',cartFingerprint:'a'.repeat(64),draft:buildShippingDraft(policy,address,'ground'),expiresAt:new Date(Date.now()+60000).toISOString()};
  const [first,replay]=await Promise.all([store.save(input),store.save(input)]);assert.deepEqual(first,replay);assert.equal(first.checkoutEnabled,false);
  await assert.rejects(store.save({...input,cartFingerprint:'b'.repeat(64)}),/SHIPPING_CHANGED/);
  await assert.rejects(store.save({...input,draft:buildShippingDraft(policy,{...address,postalCode:'17001'},'ground')}),/SHIPPING_CHANGED/);
  const other=new ShippingDraftStore(db,{merchantId:'another-merchant',locationId:'fixture-location'});assert.equal(await other.read(input.id),null);await assert.rejects(other.save(input),/SHIPPING_CHANGED/);
  assert.deepEqual((await store.read(input.id))?.draft,input.draft);assert.equal((await db.query('SELECT * FROM merchant_shipping_drafts')).rows.length,1);
  await db.query("UPDATE merchant_shipping_drafts SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",[input.id]);assert.equal(await store.read(input.id),null);assert.equal((await db.query('SELECT * FROM merchant_shipping_drafts')).rows.length,1);
 } finally {await db.close();}
});
