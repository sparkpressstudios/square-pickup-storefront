# Initial catalog import and website-owned inventory

Use the separate merchant installation from [the buyer guide](BUYER-RAILWAY-INSTALL.md), not the synthetic demo database. Normal startup never creates/imports a catalog or opens checkout automatically.

## Reviewed initial import

1. Sign in with the separately provisioned administrator. Import routes require trusted staff identity, administrator role, same-origin writes and CSRF; forged role headers are not authentication.
2. Verify the configured Square seller/location and choose **Website** inventory ownership for this V1 checkout. The importer reads a bounded catalog, presents supported items and held reasons, and stages an immutable fingerprinted preview.
3. Review the exact fingerprint and approve the initial import. It stores stable Square item/variation mappings in one transaction. Replaying the same committed fingerprint reuses the receipt; a different batch cannot silently overwrite an existing merchant catalog.
4. Imported base variants remain disabled with zero stock. The separate merchant commerce stock table overlays the deliberately allocated website quantity and enable flag. Review availability in **Stock & orders**, enable intended variants and open checkout only after merchant setup is complete.

The initial import is not periodic synchronization or a general upsert tool. Unsupported modifiers/product types stay held. Taxed catalog-reference items are eligible only through the explicit merchant commerce path using authoritative Square Orders calculations; local catalog prices must not be charged as a substitute for provider-confirmed totals.

## Inventory and persistence boundaries

Website stock is its own allocation. Square POS inventory is not automatically synchronized; the operator must account for sales through other channels. A quantity shown in the Square catalog is not proof that the website can sell it.

Reservations, completed sales and unknown outcomes preserve their existing identity and stock history. Definite pre-payment cancellations may release a reservation once; refunds do not automatically restock. Review physical disposition before a deliberate stock adjustment.

The bootstrap/import markers and disabled base records are safety boundaries, not errors to bypass. Commerce schema 2 provides the separate operational configuration and inventory overlay. Unknown schemas, other merchant identities and an existing synthetic database must not be adopted. Never reseed to resolve an upgrade failure.

See [environment/setup details](MERCHANT-COMMERCE-INSTALL.md), [handoff](MERCHANT-HANDOFF.md) and [upgrade compatibility](UPGRADES.md). Managed invitations/MFA, automatic POS sync and new-merchant production certification are not supplied by the import feature.
