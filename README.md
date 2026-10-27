# Square Commerce Starter

**0.1.0-rc.3 — public-distribution release candidate, not production certification.** A standalone, customizable single-merchant/location storefront for USD physical pickup. Licensed under the [MIT License](LICENSE), copyright 2026 SparkPress Studios: free to use, modify, fork, redistribute and sell, subject to the license notice requirements. Optional paid setup/support is separate; terms and prices are not established here. The clean source is public at [sparkpressstudios/square-pickup-storefront](https://github.com/sparkpressstudios/square-pickup-storefront).

## Start here

Follow **[Buyer installation: manual Railway sandbox first](docs/BUYER-RAILWAY-INSTALL.md)**. Setup is operator-driven: approved app/database, protected Square configuration, explicit schema initialization, first administrator, catalog review and stock activation. A fresh buyer Railway installation remains unverified; this is not a one-click production-launch claim.

- React/Vite storefront, Express server, PostgreSQL persistence and generic product variants.
- Imported supported Square catalog identities; website-owned stock allocation, not automatic Square POS inventory synchronization.
- Authoritative Square tax/discount totals, durable payment/refund identities, signed callback recovery and pickup operations.
- Database-backed merchant branding/operating settings, protected administrator tools and private buyer order status.
- Optional buyer-owned confirmation email, disabled by default and requiring separate migration/account/sender setup. Provider acceptance is not inbox delivery.

One merchant/location, USD and pickup are the supported scope. Gift cards, loyalty, shipping, subscriptions and multi-merchant SaaS are not included promises. Production payment gates, customer-email enablement and infrastructure/account changes require the buyer's separate authorization and acceptance.

## Local synthetic demo

Use Node 22.12+ within 22.x or Node 24.x and pnpm 12.14.0:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

Open `http://127.0.0.1:3000`. This default loopback demo uses fictional products, no credentials, provider calls or mail. `pnpm build && pnpm start` serves the built demo. `.env` files are not automatically loaded. For optional durable local synthetic data, use `pnpm db:setup`, then `pnpm dev:durable`; do not substitute a merchant or production database.

The public `railway.json` retains only the required build and deliberately does not override deployment settings. `pnpm start:railway` remains the **synthetic** runtime, not the merchant entrypoint. Select the explicit setup or merchant runtime profile in the buyer guide; never make initialization a recurring deploy hook. New Railway services use template/dashboard settings, not legacy Config as Code. The old synthetic settings are preserved only as a non-default reference in `examples/railway-synthetic.json`; do not select that example for a merchant installation.

## Merchant and operator guides

- [Sandbox-first installation and effective settings](docs/BUYER-RAILWAY-INSTALL.md)
- [Detailed environment and installation reference](docs/MERCHANT-COMMERCE-INSTALL.md)
- [Initial catalog import and website inventory](docs/MERCHANT-CATALOG-IMPORT.md)
- [Optional order confirmation email](docs/MERCHANT-EMAIL.md)
- [Operating handoff and recovery](docs/MERCHANT-HANDOFF.md)
- [Upgrade/schema compatibility and restore limits](docs/UPGRADES.md)
- [Release channels and customer opt-in policy](docs/RELEASE-POLICY.md)
- [Evidence summary and remaining gates](docs/EVIDENCE.md)
- [Demo asset/font notices](docs/ASSET-NOTICES.md), [changelog](CHANGELOG.md), [security reporting](SECURITY.md)

Supported branding/settings belong in the merchant database and protected environment; deeper source changes remain a maintained fork. No automatic fleet updater, access grant, support SLA or guaranteed conflict-free fork upgrade is supplied. Buyer hosting, payment and optional mail services have their own costs and terms.

## Release boundary

This sanitized candidate deliberately excludes private operational journals, hosted acceptance credentials/configuration and target-specific helper paths. Original private history is retained separately. Generic financial/identity regression tests and applied migration SQL remain intact; run the candidate's own full checks rather than quoting an upstream test count as export evidence.

The application uses the [MIT License](LICENSE). Retain the separate third-party font notices and [asset provenance](docs/ASSET-NOTICES.md). The owner-approved vulnerability reporting address is in [SECURITY.md](SECURITY.md). This publication provides the source repository only; a Railway marketplace listing and fresh-host, mobile and real-email acceptance remain outstanding.
