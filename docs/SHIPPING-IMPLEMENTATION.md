# Pickup plus shipping: development framework, not enabled checkout

The reusable template is being extended to support both pickup and shipping. **Current public buyer checkout still supports pickup only.** These modules are an inert development slice; no customer-facing shipping option, provider request, startup migration or live activation is added.

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

A successful result contains a validated amount and frozen quote fingerprint but always `paymentExecutionEnabled: false`. It is not dispatched to Square, persisted as a checkout attempt, exposed by any route or accepted by current pickup payment code. The fingerprint is not a signature/authentication mechanism: `assertUnchanged` requires an original quote retained by the trusted server, never an original supplied by the buyer. Durable authoritative-quote storage and recovery still need integration before any payment use. Adapter timeout/failure produces no quote and no retry; no error body/PII is echoed.
