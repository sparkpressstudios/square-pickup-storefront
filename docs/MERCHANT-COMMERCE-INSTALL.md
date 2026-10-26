# Merchant sandbox installation

**Current buyer entrypoint:** [manual Railway sandbox-first installation](BUYER-RAILWAY-INSTALL.md). This page is the detailed configuration/reference companion.

This is the opt-in, single-merchant **USD / pickup / website-owned-stock** path. It uses imported Square variation identities and Square-calculated taxes and discounts, durable order/payment identities, and administrator-controlled sandbox refunds. It is not the synthetic demo, and this sandbox installation does not enable production payments or real fulfillment.

## Scope and permissions

- Keep any existing synthetic installation and its database/history unchanged. Never point merchant setup at that database or run synthetic migrations against a merchant database.
- A new merchant deployment, dedicated database, secret configuration, first administrator, webhook subscription, and any paid infrastructure need their applicable explicit approvals. These instructions are not permission to create them.
- Use one merchant and one Square Sandbox location per installation. No Square POS inventory synchronization, multi-merchant tenancy, gift cards or loyalty are promised for V1.
- This clean distribution is MIT-licensed. Do not expose the separate private working history, enable live payments or send customer emails as part of this setup without the applicable authorization.

## Configuration

Supply approved values through server-only environment/secrets controls. Do not paste credentials into chat, source, command arguments, browser variables or logs. Nothing automatically reads `.env` files.

| Variable | Required value or meaning |
| --- | --- |
| `STARTER_DATASET` | `merchant-catalog-v1` |
| `MERCHANT_DATABASE_URL` | Dedicated recognized merchant PostgreSQL database; distinct from `DATABASE_URL`. Prefer the Railway private-network URL. Remote connections require `sslmode=verify-full`. Never target synthetic or unrelated merchant databases. |
| `DATABASE_URL` | Omit for merchant installation; do not borrow the existing synthetic connection. |
| `STARTER_DB_BOOTSTRAP` | Omit. Merchant schema setup is explicit, not a startup hook. |
| `STARTER_STORAGE` | Omit or `postgres`. |
| `PUBLIC_ORIGIN` | Canonical HTTPS application origin, no path/query/fragment. |
| `SQUARE_ENVIRONMENT` | `sandbox` |
| `SQUARE_MERCHANT_COMMERCE_ENABLED` | `true` |
| `SQUARE_SANDBOX_REQUESTS_ENABLED` | `true` |
| `SQUARE_APPLICATION_ID` | Approved sandbox application ID beginning `sandbox-sq0idb-`. |
| `SQUARE_LOCATION_ID` | Location belonging to that seller. |
| `SQUARE_SANDBOX_MERCHANT_ID` | Corresponding seller ID. |
| `SQUARE_SANDBOX_ACCESS_TOKEN` | Approved server-only sandbox token. |
| `SQUARE_MERCHANT_WEBHOOK_PATH` | Omit for `/api/commerce/webhooks`; set exactly `/api/sandbox/webhooks` only to preserve an existing approved callback URL/subscription. No arbitrary URL/path accepted. |
| `SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY` | Approved signing key for the exact `PUBLIC_ORIGIN` + selected callback path notification URL. Preserve an existing approved subscription/key where possible; do not create or reconfigure one without explicit authorization. |
| `MERCHANT_ADMIN_SESSION_KEY` | Approved, canonical base64url encoding of 32 random bytes (43 characters). Provision through trusted secrets controls, not this guide or chat. |
| `MERCHANT_NAME` | Reviewed display name, 1–100 characters. |
| `MERCHANT_PICKUP_LABEL` | Reviewed pickup label, 1–100 characters. |
| `MERCHANT_PICKUP_INSTRUCTIONS` | Reviewed pickup instructions, 1–500 characters. |
| `PORT` | Railway-supplied port; omit for default 8080. |

Presentation strings cannot contain control characters. Credentials must never use `VITE_`, `NEXT_PUBLIC_` or `PUBLIC_` prefixes.

## Explicit installation sequence

Run in the approved deployment environment with the approved variables already supplied:

```sh
pnpm install --frozen-lockfile
pnpm check
node scripts/check-setup.mjs --profile merchant-sandbox --fresh
```

The checker is **static only**. It makes no network calls, changes no settings, and cannot certify credentials, database contents, Square access or launch readiness.

For a separately approved, empty merchant database only:

```sh
pnpm merchant:db:setup --initialize-empty
```

For an already recognized, reviewed merchant **catalog-only** database, use the explicit additive upgrade instead:

```sh
pnpm merchant:db:setup --upgrade-reviewed-catalog
```

Neither command creates the database, grants access, provisions staff, imports products, enables stock or activates live payments. Existing unknown schemas are refused. The additive merchant schema stores its version/checksum and reuses the reviewed sandbox webhook projections. Never edit an applied migration to force startup.

Provision the initial administrator only after the separate account/credential action is approved. Supply a password of **16–128 UTF-8 bytes, without ASCII control characters**, via a trusted, non-echoing stdin stream:

```sh
pnpm merchant:admin:provision
```

The package alias already includes `--password-stdin`; do not append that flag again. Do not pass the password as an argument or environment variable. No default administrator or password is seeded; existing accounts are not silently replaced.

Configure these settings explicitly in the Railway dashboard for the **approved merchant service**, not an existing synthetic installation:

- Build command: `pnpm check`
- Predeploy validation: `node scripts/check-setup.mjs --profile merchant-sandbox` (static configuration only; it does not initialize or upgrade the schema)
- Start command: `pnpm start:merchant`
- Health endpoint: `/api/health`
- Keep the existing database volume; do not reseed on restart.

Before the normal merchant-runtime deployment, complete only the applicable owner-reviewed schema command above (`--initialize-empty` or `--upgrade-reviewed-catalog`) against the approved separate merchant database. The setup script is an explicit operator action, not a recurring predeploy/startup bootstrap. For private-network first setup, use the [temporary non-serving SSH hold sequence](BUYER-RAILWAY-INSTALL.md#private-network-first-install-temporary-non-serving-ssh-hold); a local `railway run` does not grant private DNS access. Leave `STARTER_DB_BOOTSTRAP` unset; do not install sandbox fixtures, seed credentials or import products by default. Secrets, the session key and first administrator remain manual, owner-approved secure setup steps.

Do **not** rely on this repository's default `railway.json`: it describes the retained synthetic runtime, not a supported new-buyer installation. Confirm the effective deployed settings match the merchant commands above.

## First merchant workflow

1. Open `/admin/login`; sign in using the separately provisioned administrator.
2. Open **Import products**. Verify the seller/location and select **Website** inventory ownership. Review and commit the disabled import fingerprint. Taxed catalog references are eligible only in this explicit merchant mode; unsupported modifiers remain held.
3. Open **Stock & orders**. Enter reviewed available stock, enable intended variants, then open the sandbox storefront. Imported catalog records alone never make stock sellable.
4. Open `/`. Confirm identity/pickup copy, variants, availability, authoritative tax/discount totals and sandbox labeling. Only use fake sandbox card data.
5. Verify `/api/commerce/webhooks` is configured at Square for the exact HTTPS URL. Test raw-body signature rejection, duplicate/reordered events and recovery.
6. Test refunds from **Stock & orders**. Preserve unresolved refund identities; never create a replacement identity for an uncertain result. Refunds do not automatically restock.

## Required release evidence and current limits

Local injected-provider/PGlite tests are not evidence of current native PostgreSQL contention, actual browser card tokenization, real webhook delivery or an accepted fresh Railway merchant installation. Those must be verified against the authorized target before claiming merchant launch readiness.

Acceptance must include: fresh install/import/activation, taxed and discounted checkout, database/process restart, concurrent submissions and last-stock contention, expired untouched reservations, unknown order/payment/refund recovery, signature/replay handling, external pending refunds, partial/full refunds and no refund-driven restocking. Check desktop and supported mobile browsers and keyboard navigation.

Sandbox acceptance never enables production payments by itself. Native/database/browser proof still pending must be reported explicitly. Any live launch needs a separately reviewed production-readiness step and its required authorization.

## Buyer-readiness code: production is an explicit, separate path

The merchant code now includes a **disabled-by-default production gate**. That is code support, not certification, approval to process a live card, or evidence that this installation is ready. The historical synthetic server continues to reject production. Never convert its database or credentials into a merchant installation.

For a separately authorized production merchant installation, use `SQUARE_ENVIRONMENT=production` and the explicit `SQUARE_PRODUCTION_PAYMENTS_ENABLED=true` gate with **all five distinct settings**:

- `SQUARE_PRODUCTION_APPLICATION_ID`
- `SQUARE_PRODUCTION_LOCATION_ID`
- `SQUARE_PRODUCTION_MERCHANT_ID`
- `SQUARE_PRODUCTION_ACCESS_TOKEN`
- `SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY`

No generic or sandbox credential fallback is permitted. Do not rename or copy a sandbox token into a production field. The validated loader selects the production API and Web Payments SDK domains together; only application ID, location ID, environment and SDK URL may reach the browser. Production orders carry the configured environment/application/merchant binding and a scheduled pickup promise. Use the buyer's approved single-location timezone, weekly hours, lead time and manually operated capacity policy (automatic slot-capacity enforcement is not supplied); do not silently default production orders to fictional ASAP pickup.

The native merchant database must have the recognized version-2 checksum and matching environment/application/merchant/location. An existing sandbox database must **not** be relabeled production. Fresh production initialization and any secrets/account changes require their own owner-approved action and current release checks. Static setup checks do not establish merchant account activation, permissions, correct provider configuration or actual payment acceptance.

### Railway service configuration

As checked on 2026-10-25, [Railway Config as Code](https://docs.railway.com/config-as-code) is deprecated. New services cannot opt into `railway.json` / `railway.toml`; existing services stop reading them on **2026-12-01**. [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) is Railway's replacement, but this guide does not supply or provision a buyer IaC installation.

Use the explicit dashboard settings above for a new approved merchant service. For an existing legacy service, file configuration can override dashboard values: verify the **effective** build, predeploy, start and healthcheck configuration and deployed commit, not only the settings form. Legacy service-specific config overrides are not buyer install or fresh-install proof. Do not modify the synthetic service as a shortcut.

The runtime remains `pnpm start:merchant`. An authorized production installation uses `node scripts/check-setup.mjs --profile merchant-production` for static predeploy validation, never the sandbox profile as production evidence. Neither checker runs migrations, enables payments or certifies acceptance. A complete fresh buyer Railway installation through the supported configuration path remains **unverified** and is a release gate.


## Administrator access recovery

For an existing administrator, use the explicitly owner-approved operator workflow in [MERCHANT-HANDOFF.md](MERCHANT-HANDOFF.md). Do not rerun initial provisioning to overwrite an account. Recovery is not an HTTP endpoint, does not generate a default password and does not enable an intentionally disabled account.

## Operational readiness before handoff

Complete the [handoff checklist](MERCHANT-HANDOFF.md) and the isolated restore/upgrade rehearsal in [UPGRADES.md](UPGRADES.md). Record which evidence is local, native-database, injected-provider, real sandbox and real browser; never substitute one for another. No customer emails are sent until a separately approved sender and explicit transactional-email policy are configured and verified. No gift-card, loyalty, POS inventory synchronization, subscription or multi-merchant promise is implied by V1.
