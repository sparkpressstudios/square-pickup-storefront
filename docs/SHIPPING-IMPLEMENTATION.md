# Pickup plus shipping: development framework, not enabled checkout

The reusable template is being extended to support both pickup and shipping. **Current public buyer checkout still supports pickup only.** These modules are a development-only admin rehearsal; no customer-facing shipping option, real provider request, startup migration or live activation is added.

## Implemented locally

- Strict domestic US address syntax and merchant-owned destination/fixed-fee configuration; unknown regions, extra fields and non-integer or out-of-range fees reject. Address parsing does **not** verify postal deliverability or ZIP/state consistency. International destinations and US territories are not implemented.
- Fee-only immutable shipping draft and integrity fingerprint. It cannot produce a payable order total: `taxStatus` is `unresolved` and `checkoutEnabled` is always false. The fingerprint is not authentication, encryption or a customer access token.
- Offline Square SHIPMENT fragment mapping and strict recipient/state evidence matching. Packaged and shipped do not mean delivered, paid or tax-verified. No network calls are made.
- An unmounted read-only preview component clearly shows unresolved tax and no purchase controls.
- An isolated development-only PostgreSQL draft table and server repository. Scoped merchant/location context is copied; immutable identity/cart/address/fee conflicts reject, expirations hide drafts without deleting history. No HTTP routes expose it. The SQL is **not** part of application setup/startup; only synthetic test databases have used it. A reviewed migration/restore path is required before any merchant installation.

## Reusable merchant onboarding settings—not universal SparkPress rates

Each merchant must configure allowed destinations, shipping methods and fixed/free fees, packaging/handling promises, and a reviewed tax strategy. Product taxability, destination rules, exemptions and whether shipping fees are taxable must come from that merchant's approved tax configuration/provider. Do not infer these from pickup tax totals or the existence of Square catalog tax objects. A tax provider response must be bound to the exact cart, shipping address, method/fee and quote expiry. No tax rules are guessed here, and no missing tax evidence means zero tax.

## Remaining integration gates

1. Add a reviewed optional schema upgrade with immutable fulfillment-kind/address/rate/tax snapshots, deployment-version checks and rollback/backup rehearsal. Existing pickup identities must continue to load unchanged.
2. Implement trusted shipping/tax adapters and server-owned payable quotes, including shipping-fee taxes and Square total verification. Verify the merchant's Square API capabilities before activation. Existing provider checks intentionally reject nonzero service charges; never weaken that invariant without replacing it with explicit evidence.
3. Wire authenticated merchant configuration and buyer pickup/shipping selection. The first integration must choose one fulfillment method for the entire order; mixed pickup/shipment and split shipments are out of scope. Freeze selection at quote/prepare; changes require a new quote, never silently mutate paid/uncertain attempts. Keep shipping disabled until all readiness gates pass.
4. Add shipment fulfillment/tracking and customer status, signed event provenance, refunds/unknown-outcome recovery and data-minimal confirmations. Carrier labels/rates, address validation and delivery confirmation are separate integrations, not supplied by a SHIPMENT object.
5. Independently audit and run full pickup regression, destination/fee/tax tampering tests, concurrency/reload/expiry tests, migration/restore tests and real sandbox end-to-end shipping acceptance before offering shipping checkout. No live payments are authorized by this work.

## Provider references

- [Square order fulfillments](https://developer.squareup.com/docs/orders-api/fulfillments): SHIPMENT type, recipient fields, one-fulfillment limitation, PREPARED/COMPLETED shipment meanings. The documentation identifies SHIPMENT as Beta; actual compatibility must be verified before launch.
- [Square order creation](https://developer.squareup.com/docs/orders-api/create-orders): include tax/discount details before CalculateOrder. Destination-aware tax correctness is not proven by this template's existing pickup calculation.

The earlier release-candidate and production-acceptance limitations remain unchanged. Do not market this development slice as working live shipping.

## Offline authoritative amount contract (development branch)

`ShippingQuoteService` accepts only a server-registered tax adapter, trusted merchant/location identity, merchant tax-configuration revision, server-owned item prices/discounts/tax-category IDs and merchant rate policy. Buyer input must never construct the adapter registry or supply the merchandise basis. Missing configuration/adapter is a hard failure, not an assumption of zero tax. No real tax adapter, merchant tax rules or external provider calls are included.

The request freezes merchant/location, cart lines, address, selected fee, configuration revision and expiry into one fingerprint. Adapter evidence must echo that identity, have a nonempty reference, matching currency/revision and a bounded future expiry. Inclusive tax stays inside the configured merchandise/shipping basis; only additional taxes increase the amount. Arithmetic, maximums and malformed evidence fail closed. This validates evidence from a trusted adapter—it does not independently prove that a merchant's tax rules are legally correct.

A successful result contains a validated amount and frozen quote fingerprint but always `paymentExecutionEnabled: false`. It is not dispatched to Square or accepted by current pickup payment code. The development admin rehearsal described below retains it in a separate preview table, not a real commerce/payment attempt. The fingerprint is not a signature/authentication mechanism: `assertUnchanged` requires an original quote retained by the trusted server, never an original supplied by the buyer. Live commerce-attempt storage, stock reservation and recovery still need integration before any payment use. Adapter timeout/failure produces no quote and no retry; no error body/PII is echoed.

## Integrated admin rehearsal (development branch only)

The existing authenticated merchant admin now has a **Shipping rehearsal** page. It is admin-only, retains existing origin/CSRF guards, and starts unconfigured. It has no enable/payment control: `/execute` always returns 423. Normal application startup registers no shipping resolver and makes no shipping schema changes. Merely setting request fields cannot activate it.

Developers can explicitly inject a trusted `ShippingCheckoutRehearsal` instance into the merchant app for synthetic fixtures. Its server-owned resolver supplies the cart basis, rate policy, tax service and bounded CalculateOrder evidence adapter. The separate `db/merchant-shipping-checkout.sql` schema is development-only and must not be applied to merchant databases without the migration/restore review above. No real adapter implementation or credentials are included.

A request ID durably claims one immutable quote input. Same-process duplicate clicks coalesce; a reconstructed service returns the retained quote without redispatch. Failed or interrupted claims require review rather than automatic retry. Preparation rechecks current cart, address, rate revision, tax configuration and expiry, then retains an immutable SHIPMENT preview. Neither quoting nor preparation reserves stock, creates a Square order, charges a payment or purchases a label. Configuration reads are snapshots, not a live atomic stock/configuration transaction. Browser reload recovery and production operational tooling remain unimplemented.

The evidence verifier binds quote/location, currency, each line's price/quantity/discount/tax split, order totals and the one configured shipping service charge. Included taxes remain inside the basis; additive taxes increase totals. It rejects offsetting line errors, modifiers, tips and extra service charges. This is component consistency checking, **not proof of tax legality or actual Square acceptance**. The trusted adapter must eventually map reviewed tax IDs and service-charge configuration to the Square API; no outgoing request mapping is guessed here.

- [Square service charges](https://developer.squareup.com/docs/orders-api/service-charges): taxable charges require `SUBTOTAL_PHASE`; setting taxable is not itself a tax strategy.
- [OrderServiceCharge](https://developer.squareup.com/reference/square/objects/OrderServiceCharge): applied money includes inclusive tax; total money also includes additive tax.
- [Order](https://developer.squareup.com/reference/square/objects/order): total service-charge money includes inclusive but excludes additive tax.

Tests use synthetic addresses and injected offline tax/pricing data only. Required live gates remain: reviewed migration/restore, merchant-specific configuration and real adapters, exact Square tax/fee/SHIPMENT acceptance, atomic stock/order/payment workflow and uncertainty recovery, signed events/refunds/tracking, buyer selection and real sandbox end-to-end acceptance. Existing pickup tests must continue to pass. Do not advertise this admin rehearsal as available customer shipping.

## Buyer quote and shared-stock integration (development only)

A separately injected `MerchantShippingBuyer` now supports capability-token quotes, locked stock reservation, status, cancel and expiry. Its explicit shipment quote/attempt snapshots live in separate development tables; legacy pickup records/schema/readers are unchanged. Both flows lock and decrement the same merchant inventory rows, preventing simultaneous claims on the final unit. Configuration revision and current catalog prices are rechecked inside the reservation transaction. Request-body prices/categories/tax policy are never accepted. The initial shipping adapter contract uses catalog base prices with **no discounts**; automatic pickup promotions are not silently applied.

A server-only configuration method stores per-merchant fixed/free destination rates, variant tax categories and a registered tax configuration identity. It does not invent rates or legal tax policy. The new `db/merchant-shipping-buyer.sql` remains outside startup/setup and has only run against synthetic local databases. Unknown configuration/adapter fails closed. A real merchant rollout still needs a reviewed migration, backup/restore, operational expiry strategy and privacy retention policy.

The optional sandbox-development storefront panel uses the current cart and buyer address/contact, retaining only quote ID + bearer capability in session storage for status/cancel recovery. It locks conflicting cart navigation while a preview is retained. Restored previews can be checked/canceled; they do not silently restart preparation. A lost response requires status inspection, not another identity. Address deliverability and shipping labels are not provided. This panel is absent by default; production injection is rejected.

**Shipping submit always rejects before any state transition or provider call.** The quote's `paymentExecutionEnabled: false` remains enforced. Reservations can only be held or released; there is no claim of a paid/shipped order, refund or financial recovery. The next execution integration must introduce separately reviewed fulfillment-aware provider dispatch and durable unknown-outcome recovery, signed payment reconciliation, exact Square tax/fee/SHIPMENT payload acceptance, customer confirmations and actual sandbox end-to-end tests. Never route these shipment tokens/evidence through the pickup payment or fulfillment path.

Stock adjustment safety: inventory quantities mean **available/unreserved** units. Native admin updates now include all held pickup reservations and any optional shipping reservations when enforcing the 1,000,000-unit capacity, so later cancellation/expiry cannot overflow the inventory constraint. Missing optional shipping schema preserves baseline behavior; a present incompatible schema fails closed. Private Pro bulk-product mutation must independently recognize optional shipping holds before a combined release.

## Merchant shipping settings (development branch)
Square Ecommerce Storefront now exposes administrator-only draft settings in the shipping page: US state destinations, up to 20 named fixed/free rates in cents, per-variant reviewed tax categories, and a choice among tax configurations already registered on the server. No credential, URL, code, tax percentage or universal legal tax policy can be supplied by this screen.

The optional development buyer service and reviewed optional schema must be installed before this page can persist settings. Saving does not install schema, activate customer shipping or permit payment execution. An empty tax selection is a valid saved draft but quotes fail closed; it does not mean tax is zero. Tax readiness reports server registration and missing categories, not provider/legal acceptance. Existing catalog base-price-only shipping quotes do not silently inherit pickup discounts.

Settings revisions are server-generated and saved under an identity-scoped lock; a stale edit receives a conflict and must reload. The original server configuration seam participates in the same lock. A changed revision invalidates unprepared quotes. Existing reservations and cancellation/expiry evidence remain retained and releaseable; settings never rewrite old quotes. Admin requests use the existing verified session, same-origin and CSRF protections. Reads/writes are no-store. Manager, staff and public users cannot configure shipping.

The UI suppresses repeated requests, aborts on unmount, and requires reload after a conflict or uncertain save. Reload explicitly discards unsaved edits. Browser/device interaction acceptance remains outstanding; SSR/source/API tests are not claimed as real-browser proof. Shipping order/payment execution, provider acceptance, operational expiry and migrations remain gated as described above.

This branch incorporates public 0.1.0-rc.3 metadata and pickup repair regression while retaining the stronger combined pickup/shipping reservation capacity guard. Its shipping additions are not part of the main rc.3 release and are not enabled by that release manifest.
