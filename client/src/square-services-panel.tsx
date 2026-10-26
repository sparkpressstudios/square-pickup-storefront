import { useEffect, useState } from 'react';
import type { PreorderPreview } from '../../server/src/square-preorders';
import type { SquarePreorderEligibility } from '../../server/src/square-preorder-products';
import type { SquarePromotionQuote, PromotionVariation, SquarePromotionGiftCoverage } from '../../server/src/square-promotion-preview';
import type { PreorderSlotPreview } from '../../server/src/square-preorder-availability';
import type { GiftActivityHistory, LoyaltyRewardHistory, LoyaltyEventHistory } from '../../server/src/square-service-history';
import type {
  SquareServicesAvailability, SquareGiftCardSummary,
  SquareLoyaltyProgramSummary, SquareLoyaltyAccountSummary,
  SquareGiftCardCoveragePreview, SquareLoyaltyPointsPreview, SquareLoyaltyEligibility,
} from '../../server/src/square-services';
import { formatPrice } from '../../shared/catalog';
import { priceMinor } from './admin-model';

async function parseResponse(response: Response): Promise<unknown> {
  const data = await response.json();
  if (!response.ok) throw new Error('Square service is unavailable. Verify the sandbox permissions and feature settings.');
  return data;
}
/** No public/gift-card PAN lookup: this is a verified merchant admin feature only. */
export function SquareServicesPanel({ preview, role, enabled, csrfToken }: {
  preview: boolean; role: string; enabled: boolean; csrfToken: string;
}) {
  const active = !preview && role === 'admin' && enabled;
  const [caps,setCaps] = useState<(SquareServicesAvailability & {promotionsPreview?:boolean}) | null>(null);
  const [promoVariations,setPromoVariations]=useState<PromotionVariation[]>([]);
  const [promoVariant,setPromoVariant]=useState('');
  const [promoQuantity,setPromoQuantity]=useState(1);
  const [promoQuote,setPromoQuote]=useState<SquarePromotionQuote|null>(null);
  const [promoGiftCoverage,setPromoGiftCoverage]=useState<SquarePromotionGiftCoverage|null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [pickupAt,setPickupAt] = useState('');
  const [slotDate,setSlotDate] = useState('');
  const [slotPreview,setSlotPreview] = useState<PreorderSlotPreview | null>(null);
  const [pickupWindow,setPickupWindow] = useState<15|30|60>(30);
  const [preorder,setPreorder] = useState<PreorderPreview | null>(null);
  const [releaseProducts,setReleaseProducts]=useState<{productId:string;maxQuantity:number}[]>([]);
  const [releaseProduct,setReleaseProduct]=useState('');
  const [releaseQuantity,setReleaseQuantity]=useState(1);
  const [releaseResult,setReleaseResult]=useState<SquarePreorderEligibility|null>(null);
  const [cardId,setCardId] = useState('');
  const [card,setCard] = useState<SquareGiftCardSummary | null>(null);
  const [giftHistory,setGiftHistory] = useState<GiftActivityHistory | null>(null);
  const [giftOrderTotal,setGiftOrderTotal] = useState('25.00');
  const [giftCoverage,setGiftCoverage] = useState<SquareGiftCardCoveragePreview|null>(null);
  const [program,setProgram] = useState<SquareLoyaltyProgramSummary | null>(null);
  const [loyaltyId,setLoyaltyId] = useState('');
  const [account,setAccount] = useState<SquareLoyaltyAccountSummary | null>(null);
  const [rewards,setRewards] = useState<LoyaltyRewardHistory | null>(null);
  const [loyaltyEvents,setLoyaltyEvents] = useState<LoyaltyEventHistory | null>(null);
  const [loyaltyOrderId,setLoyaltyOrderId] = useState('');
  const [loyaltyPoints,setLoyaltyPoints] = useState<SquareLoyaltyPointsPreview|null>(null);
  const [rewardEligibility,setRewardEligibility]=useState<SquareLoyaltyEligibility|null>(null);

  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();
    void fetch('/api/admin/square-services/capabilities',{credentials:'same-origin',signal:controller.signal})
      .then(parseResponse).then(value=>{if(!controller.signal.aborted)setCaps(value as SquareServicesAvailability);})
      .catch(()=>{if(!controller.signal.aborted)setError('Cannot load Square services. Check merchant setup and staff permissions.');});
    return ()=>controller.abort();
  },[active]);
  async function post(path:string,body:unknown) {
    return parseResponse(await fetch('/api/admin/square-services/'+path,{
      method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
      body:JSON.stringify(body),
    }));
  }
  function run(work:()=>Promise<void>) {
    if(busy || !active)return;
    setBusy(true);setError('');
    void work().catch((reason:unknown)=>{
      setError(reason instanceof Error?reason.message:'Square service unavailable.');
    }).finally(()=>setBusy(false));
  }
  function loadPromotionVariations(){
    run(async()=>{
      setPromoQuote(null);
      const data=await parseResponse(await fetch('/api/admin/square-services/promotions/variations',{credentials:'same-origin'})) as {variations?:PromotionVariation[]};
      const list=Array.isArray(data.variations)?data.variations:[];
      setPromoVariations(list);setPromoVariant(list[0]?.variantId??'');
    });
  }
  function calculatePromotion(){
    run(async()=>{
      setPromoQuote(null);setPromoGiftCoverage(null);
      if(!promoVariant || !Number.isSafeInteger(promoQuantity) || promoQuantity<1 || promoQuantity>50)
        throw new Error('Choose a valid imported Square variation and quantity.');
      setPromoQuote(await post('promotions/quote',{items:[{variantId:promoVariant,quantity:promoQuantity}]}) as SquarePromotionQuote);
    });
  }
  function previewPromotionGiftCoverage(){
    run(async()=>{
      setPromoGiftCoverage(null);
      if(!promoVariant || !cardId.trim())throw new Error('Select a variation and a Square gift card ID.');
      setPromoGiftCoverage(await post('promotions/gift-card-coverage',{
        items:[{variantId:promoVariant,quantity:promoQuantity}],cardId:cardId.trim(),
      }) as SquarePromotionGiftCoverage);
    });
  }
  function loadSlots(){
    run(async()=>{
      setSlotPreview(null);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(slotDate))throw new Error('Choose a valid business date.');
      setSlotPreview(await parseResponse(await fetch('/api/admin/square-services/preorders/slots?date='+encodeURIComponent(slotDate),{
        credentials:'same-origin',
      })) as PreorderSlotPreview);
    });
  }
  function loadReleaseProducts(){
    run(async()=>{
      const data=await parseResponse(await fetch('/api/admin/square-services/preorders/products',{credentials:'same-origin'})) as {products?:{productId:string;maxQuantity:number}[]};
      const list=Array.isArray(data.products)?data.products:[];
      setReleaseProducts(list);setReleaseProduct(list[0]?.productId??'');setReleaseResult(null);
    });
  }
  function checkReleaseWindow(){
    run(async()=>{
      if(!releaseProduct||!pickupAt||!Number.isFinite(Date.parse(pickupAt)))throw new Error('Choose a product and scheduled pickup time.');
      const pickup=new Date(pickupAt).toISOString().replace('.000Z','Z');
      setReleaseResult(await post('preorders/product-preview',{
        productId:releaseProduct,quantity:releaseQuantity,pickupAt:pickup,
      }) as SquarePreorderEligibility);
    });
  }
  function previewPickup(){
    run(async()=>{
      if(!pickupAt || !Number.isFinite(new Date(pickupAt).getTime()))throw new Error('Choose a valid future pickup time.');
      setPreorder(await post('preorders/preview',{pickupAt:new Date(pickupAt).toISOString(),
        windowMinutes:pickupWindow}) as PreorderPreview);
    });
  }
  function checkGiftCard(){
    run(async()=>{
      setCard(null);
      setCard(await post('gift-cards/lookup',{cardId:cardId.trim()}) as SquareGiftCardSummary);
    });
  }
  function checkGiftCoverage() {
    run(async()=>{
      const total=priceMinor(giftOrderTotal);
      setGiftCoverage(await post('gift-cards/coverage',{
        cardId:cardId.trim(),orderTotalMinor:total,
      }) as SquareGiftCardCoveragePreview);
    });
  }
  function estimatePoints() {
    run(async()=>{
      setLoyaltyPoints(await post('loyalty/points/estimate',{
        orderId:loyaltyOrderId.trim(),...(loyaltyId.trim()?{accountId:loyaltyId.trim()}:{})
      }) as SquareLoyaltyPointsPreview);
    });
  }
  function loadGiftHistory(){
    run(async()=>{setGiftHistory(null);setGiftHistory(await post('gift-cards/activities',{cardId:cardId.trim()}) as GiftActivityHistory);});
  }
  function checkRewardEligibility(){
    run(async()=>{
      setRewardEligibility(null);
      setRewardEligibility(await post('loyalty/rewards/eligibility',{accountId:loyaltyId.trim()}) as SquareLoyaltyEligibility);
    });
  }
  function loadRewards(){
    run(async()=>{setRewards(null);setRewards(await post('loyalty/rewards/history',{accountId:loyaltyId.trim()}) as LoyaltyRewardHistory);});
  }
  function loadLoyaltyEvents(){
    run(async()=>{setLoyaltyEvents(null);setLoyaltyEvents(await post('loyalty/events/history',{accountId:loyaltyId.trim()}) as LoyaltyEventHistory);});
  }
  function loadLoyaltyProgram() {
    run(async()=>{
      setProgram(null);
      setProgram(await parseResponse(await fetch('/api/admin/square-services/loyalty/program',{
        credentials:'same-origin',
      })) as SquareLoyaltyProgramSummary);
    });
  }
  function checkLoyaltyAccount(){
    run(async()=>{
      setAccount(null);
      setAccount(await post('loyalty/accounts/lookup',{accountId:loyaltyId.trim()}) as SquareLoyaltyAccountSummary);
    });
  }
  return <>
    <div className="admin-heading"><div><p className="eyebrow">Square services</p><h1>Preorders, gift cards & loyalty</h1></div>
      <strong>{active?'Sandbox administration':'Preview only'}</strong>
    </div>
    <section className="admin-card">
      <h2>Optional modules for each merchant</h2>
      <p>Square provides scheduled pickup, gift card and loyalty APIs. These are separate features; a merchant can enable only the services they need.</p>
      <p>All modules are <strong>off by default</strong>. This checkpoint checks sandbox data or prepares a scheduled pickup preview. It does not create an order, redeem a card, award points, reserve inventory or charge a customer.</p>
      {!active && <p role="status">No merchant services are enabled in this synthetic preview. An authorized fresh merchant installation, staff sign-in and explicit service permissions are required.</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}
    </section>
    <section className="admin-card">
      <h2>Preorders & scheduled pickup</h2>
      <p>Square Orders API: proposed scheduled pickup at a defined date and window. Release calendars, business timezone, cutoff rules, capacity and inventory still require merchant configuration before checkout.</p>
      <p>Module: {caps?.preorders?'Sandbox pickup preview enabled':'Not enabled for this merchant'}</p>
      {active && caps?.preorders && <div className="admin-fields">
        <label>Pickup time (your browser's local timezone)
          <input type="datetime-local" step={900} value={pickupAt} onChange={event=>setPickupAt(event.target.value)} disabled={busy}/>
        </label>
        <label>Pickup window
          <select value={pickupWindow} onChange={event=>setPickupWindow(Number(event.target.value) as 15|30|60)} disabled={busy}>
            <option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option>
          </select>
        </label>
        <button type="button" className="admin-primary" onClick={previewPickup} disabled={busy || !pickupAt}>Preview Square pickup</button>
      </div>}
      {active && caps?.preorders && caps.preorderSlotsConfigured && <div className="admin-fields"><label>Merchant business date
        <input type="date" value={slotDate} disabled={busy} onChange={event=>{setSlotDate(event.target.value);setSlotPreview(null);}} />
      </label><button type="button" disabled={busy || !slotDate} onClick={loadSlots}>Show pickup slot candidates</button></div>}
      {active&&caps?.preorders&&<><button type="button" disabled={busy} onClick={loadReleaseProducts}>Load seasonal preorder products</button>
        {releaseProducts.length>0&&<div className="admin-fields">
          <label>Preorder product
            <select disabled={busy} value={releaseProduct} onChange={event=>{setReleaseProduct(event.target.value);setReleaseResult(null);}}>
              {releaseProducts.map(p=><option key={p.productId} value={p.productId}>{p.productId} (max {p.maxQuantity} per order)</option>)}
            </select>
          </label>
          <label>Preorder quantity
            <input type="number" min={1} max={100} step={1} value={releaseQuantity} disabled={busy} onChange={event=>{setReleaseQuantity(Number(event.target.value));setReleaseResult(null);}}/>
          </label>
          <button type="button" disabled={busy||!pickupAt||!releaseProduct} onClick={checkReleaseWindow}>Check seasonal release window</button>
        </div>}
      </>}
      {releaseResult&&<p role="status">Product preorder release check: {releaseResult.eligibleForPreorderPreview?'Within the configured release window':'Not eligible — '+releaseResult.reason}. Inventory and slot capacity are not reserved, and checkout remains unavailable.</p>}
      {slotPreview && <><p role="status">{slotPreview.slots.length} pickup slot candidates for {slotPreview.date} ({slotPreview.businessTimezone}). Remaining capacity is NOT verified; no checkout reservation is available.</p>
        <div className="admin-table-wrap"><table><thead><tr><th>Local time</th><th>Configured slot capacity</th><th>Available to sell?</th></tr></thead><tbody>{slotPreview.slots.map(slot=>
          <tr key={slot.pickupAt}><td>{slot.localTime}</td><td>{slot.configuredCapacity}</td><td>No — reservation required</td></tr>)}</tbody></table></div></>}
      {preorder && <p role="status">Scheduled Square pickup preview: {new Date(preorder.pickupAt).toLocaleString()} ({preorder.windowMinutes} minute window). No Square order, inventory reservation or customer notification was created.</p>}
    </section>
    <section className="admin-card">
      <h2>Square gift cards</h2>
      <p>Check an existing gift card by its Square card ID without exposing its full card number, PIN, or customer details. Sales, activation, partial redemption and split payments are not enabled until checkout amounts can be reconciled.</p>
      <p>Module: {caps?.giftCardsRead?'Read-only lookup enabled':'Not enabled for this merchant'}</p>
      {active && caps?.giftCardsRead && <div className="admin-fields">
        <label>Square gift card ID
          <input type="text" autoComplete="off" maxLength={125} placeholder="gftc:…" value={cardId} onChange={event=>{setCardId(event.target.value);setCard(null);setGiftHistory(null);setGiftCoverage(null);}} disabled={busy}/>
        </label>
        <button type="button" className="admin-primary" disabled={busy || !cardId.trim()} onClick={checkGiftCard}>Check gift card</button>
        <button type="button" disabled={busy || !cardId.trim()} onClick={loadGiftHistory}>View activity history</button>
      </div>}
      {active && caps?.giftCardsRead && <div className="admin-fields">
        <label>Illustrative order amount (USD, not charged)
          <input value={giftOrderTotal} maxLength={12} inputMode="decimal" disabled={busy}
            onChange={event=>{setGiftOrderTotal(event.target.value);setGiftCoverage(null);}}/>
        </label>
        <button type="button" disabled={busy||!cardId.trim()} onClick={checkGiftCoverage}>Preview split payment</button>
      </div>}
      {giftCoverage&&<p role="status">Illustrative payment split: gift card {formatPrice(giftCoverage.giftCardMinor,'USD')} and remaining payment {formatPrice(giftCoverage.remainingMinor,'USD')}. No card redemption or payment was made.</p>}
      {card && <p role="status">Card ending {card.cardSuffix}: {card.state}. Verified remaining balance {card.balanceMinor===null?'unavailable':formatPrice(card.balanceMinor,'USD')}. Redemption not enabled.</p>}
      {giftHistory && <section><p role="status">{giftHistory.activities.length} gift card activities (one page){giftHistory.moreAvailable?' — additional pages not loaded':''}. Card number and customer data are hidden.</p>
        <ul>{giftHistory.activities.map((event,index)=><li key={event.createdAt+'-'+index}>{event.type} — {event.createdAt} · Balance after event: {event.balanceAfterMinor===null?'Not supplied':formatPrice(event.balanceAfterMinor,'USD')}</li>)}</ul></section>}
    </section>
    <section className="admin-card">
      <h2>Square Loyalty</h2>
      <p>Check the seller's existing loyalty program and point balances without enrollment, points awards or reward redemption. A Square Loyalty subscription and LOYALTY_READ scope are required.</p>
      <p>Module: {caps?.loyaltyRead?'Read-only lookup enabled':'Not enabled for this merchant'}</p>
      {active && caps?.loyaltyRead && <>
        <button type="button" disabled={busy} onClick={loadLoyaltyProgram}>Check Loyalty program</button>
        <label>Loyalty account ID
          <input type="text" maxLength={64} autoComplete="off" value={loyaltyId} onChange={event=>{setLoyaltyId(event.target.value);setAccount(null);setRewards(null);setLoyaltyEvents(null);}} disabled={busy}/>
        </label>
        <button type="button" disabled={busy || !loyaltyId.trim()} onClick={checkLoyaltyAccount}>Check points balance</button>
        <button type="button" disabled={busy || !loyaltyId.trim()} onClick={loadRewards}>View issued rewards</button>
        <button type="button" disabled={busy || !loyaltyId.trim()} onClick={checkRewardEligibility}>Preview available reward tiers</button>
        <button type="button" disabled={busy || !loyaltyId.trim()} onClick={loadLoyaltyEvents}>View points history</button>
        <label>Square order ID (estimate potential points)
          <input type="text" maxLength={192} autoComplete="off" value={loyaltyOrderId}
            onChange={event=>{setLoyaltyOrderId(event.target.value);setLoyaltyPoints(null);}} disabled={busy}/>
        </label>
        <button type="button" disabled={busy||!loyaltyOrderId.trim()} onClick={estimatePoints}>Calculate potential points</button>
      </>}
      {program && <p role="status">Program {program.status}; {program.rewardTiers.length} reward tiers. Point redemption disabled.</p>}
      {loyaltyPoints&&<p role="status">Square order ending {loyaltyPoints.orderSuffix}: {loyaltyPoints.points} base points plus {loyaltyPoints.promotionPoints} promotion points ({loyaltyPoints.totalPoints} total estimated). No points awarded.</p>}
      {account && <p role="status">Account ending {account.accountSuffix}: {account.pointsBalance} available points, {account.lifetimePoints} lifetime points. No customer contact details were returned.</p>}
      {rewardEligibility&&<section><p role="status">Account ending {rewardEligibility.accountSuffix}: {rewardEligibility.availablePoints} points. Reward tier eligibility is a read-only estimate; no reward was created or redeemed.</p>
        <ul>{rewardEligibility.rewardTiers.map((tier,index)=><li key={tier.name+'-'+index}>{tier.name}: {tier.requiredPoints} points — {tier.eligible?'Points sufficient':'Not enough points'}</li>)}</ul>
      </section>}
      {rewards && <section><p role="status">{rewards.rewards.length} loyalty reward records{rewards.moreAvailable?' (additional pages not loaded)':''}. No points changed.</p>
        <ul>{rewards.rewards.map((reward,index)=><li key={reward.updatedAt+'-'+index}>{reward.status} — {reward.points} points — {reward.updatedAt}</li>)}</ul></section>}
      {loyaltyEvents && <section><p role="status">{loyaltyEvents.events.length} points events{loyaltyEvents.moreAvailable?' (additional pages not loaded)':''}. No points changed.</p>
        <ul>{loyaltyEvents.events.map((event,index)=><li key={event.createdAt+'-'+index}>{event.type} — {event.pointsDelta===null?'Unknown point adjustment':event.pointsDelta+' points'} — {event.createdAt}</li>)}</ul></section>}
    </section>
    <section className="admin-card">
      <h2>Square promotions & automatic discounts</h2>
      <p>Preview Square's own Catalog pricing rules (including eligible discounts) alongside catalog taxes. This uses known Square variation IDs from the separate imported merchant catalog, not editable browser prices.</p>
      <p>Module: {caps?.promotionsPreview?'Sandbox pricing preview enabled':'Not enabled for this merchant'}. No order, inventory reservation or payment is created.</p>
      {active && caps?.promotionsPreview && <>
        <button type="button" disabled={busy} onClick={loadPromotionVariations}>Load imported Square variations</button>
        {promoVariations.length>0&&<div className="admin-fields">
          <label>Imported catalog variation
            <select value={promoVariant} disabled={busy} onChange={event=>{setPromoVariant(event.target.value);setPromoQuote(null);}}>
              {promoVariations.map(v=><option key={v.variantId} value={v.variantId}>{v.productName} — {v.sku} ({formatPrice(v.unitPriceMinor,'USD')})</option>)}
            </select>
          </label>
          <label>Quantity (1–50)
            <input type="number" min={1} max={50} step={1} value={promoQuantity} disabled={busy}
              onChange={event=>{setPromoQuantity(Number(event.target.value));setPromoQuote(null);}}/>
          </label>
          <button className="admin-primary" type="button" disabled={busy||!promoVariant||!Number.isSafeInteger(promoQuantity)||promoQuantity<1||promoQuantity>50}
            onClick={calculatePromotion}>Calculate Square discounts & taxes</button>
        </div>}
        {promoVariations.length===0&&<p>Only imported Square variants can be priced. The existing sandbox Catalog may be empty.</p>}
      </>}
      {active&&caps?.promotionsPreview&&caps.giftCardsRead&&promoQuote&&<button type="button" disabled={busy||!cardId.trim()} onClick={previewPromotionGiftCoverage}>Check gift card against this Square total</button>}
      {promoGiftCoverage&&<p role="status">Fresh Square price: {formatPrice(promoGiftCoverage.totalMinor,'USD')}; gift card could cover {formatPrice(promoGiftCoverage.giftCardMinor,'USD')}; remaining card payment {formatPrice(promoGiftCoverage.remainingMinor,'USD')}. No redemption or charge was sent.</p>}
      {promoQuote&&<p role="status">Square catalog price preview: subtotal {formatPrice(promoQuote.subtotalMinor,'USD')} − discounts {formatPrice(promoQuote.discountMinor,'USD')} + tax {formatPrice(promoQuote.taxMinor,'USD')} = {formatPrice(promoQuote.totalMinor,'USD')}. Stock and checkout remain disabled; no payment was dispatched.</p>}
      <p>Catalog BOGO and scheduled pricing rules must already be configured in Square. We do not create discounts or accept a customer promo code in this phase.</p>
    </section>
  </>;
}
