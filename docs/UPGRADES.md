# Customization and controlled upgrades

**Current packaging target: `v0.1.0-rc.2`, not a certified 1.0 release.** Each merchant owns a separate application/database and explicitly adopted release commit. The clean distribution is MIT-licensed; the original working repository/history remains private. Optional paid support terms are separate and not established here. Existing-host sandbox evidence does not prove a fresh buyer Railway installation, production acceptance or a seamless upgrade of a customized fork. See [installation](BUYER-RAILWAY-INSTALL.md) and [release/update policy](RELEASE-POLICY.md).

## What is configuration, data or a code fork?

- **Protected server environment:** connection/provider/session credentials, canonical origin, initial display name and pickup label/instructions. Keep these out of source and backup manifests. Changing application code must not replace merchant credentials or change payment environment.
- **Persisted merchant settings:** the merchant admin setup stores reviewed branding (name, tagline, accent/background colors), support/policy details and pickup operating configuration in the merchant database. These settings are real, not a future catalog feature. The public merchant presentation overlays the supported persisted branding fields on environment-backed baseline presentation. Preserve these rows during upgrades; do not assume every string or asset is admin-configurable. Capacity remains a manual operator policy, not automatic slot enforcement.
- **Catalog/stock/history:** imported Square mappings, website stock allocation, orders, reservations, refund/fulfillment identities and webhook receipts are merchant database records. They are not fixtures to reseed. The synthetic `config/demo-*` files do not represent a buyer's imported merchant catalog.
- **Code customization:** new layouts, components, bespoke copy/assets, integrations or checkout behavior are changes to the buyer's maintained source fork. Record the base commit and a focused customization patch. Keeping branding in supported settings reduces merge conflicts; it does not make arbitrary UI/core changes automatically upgrade-safe.

There is no plugin compatibility contract, fleet updater, automatic fork merger or promise that a template update preserves every customization. An ejected/customized-fork upgrade pilot remains unverified.

## Compatibility for this release candidate

| Database state | `v0.1.0-rc.2` operating contract | Required action / rollback boundary |
| --- | --- | --- |
| Empty, separately approved merchant database | No automatic startup initialization | Run explicit owner-approved fresh setup before normal merchant startup. |
| Recognized commerce schema 1 | Not the normal runtime schema | Rehearse the explicit additive upgrade to schema 2; preserve the original checksum/history. |
| Commerce schema 2; no email tables | Supported base state; email disabled | No email migration or mail credentials required. |
| Commerce schema 2 + optional email schema 1, known checksums; email disabled | Supported; outbox/history retained, no dispatch | Disabling email is not a schema downgrade and does not erase pending or unknown sends. |
| Commerce schema 2 + optional email schema 1; explicitly enabled/valid email configuration | Supported optional path, bounded reconciliation/drain | Preserve activation cutoff, frozen payload/key and provider-account scope. Actual sender/delivery approval remains separate. |
| Unknown/partial schema, changed checksum, mismatched environment/application/merchant/location | Refused | Investigate; never rewrite checksums, adopt another database or drop unfamiliar records to force startup. |

Older binaries may reject schema 2 or the optional email tables. Do not infer backward compatibility from a version label. Verify the exact prior artifact against the post-migration schema on an isolated copy before any code rollback. The optional email migration does **not** change base commerce version 2; see [email setup/rollback](MERCHANT-EMAIL.md). There is no supported automatic schema downgrade.

## Versioned release and merchant adoption

Every candidate/release must identify a full commit, changelog, configuration/schema compatibility, tested evidence and rollback limits. `v0.1.0-rc.2` describes a prerelease package, not a guarantee of production readiness or support entitlement. No customer installation is changed just because an upstream version exists. The release policy separates proposed stable/development channels, customer adoption and narrowly scoped maintenance authority; no branches, tracking settings or fleet updates are created by these documents.

For a feature update, the merchant's developer will:

1. Compare the deployed base version with the intended release and review its changelog and migration notes.
2. Back up that merchant's database/configuration and create an isolated test deployment using appropriately protected data or synthetic fixtures.
3. Merge the release explicitly while preserving merchant configuration, content, custom presentation, and extensions. Core forks may require manual merges and additional tests.
4. Apply documented, ordered schema migrations in the test environment and run relevant catalog/checkout acceptance tests before selecting a rollout time.
5. Deploy the reviewed version and monitor it. Preserve the previous artifact and a tested recovery plan.

Prefer additive migrations that allow a staged rollout. A code rollback is safe only while the previous version remains compatible with the current schema. Destructive or incompatible migrations require a documented database restore/forward-fix strategy; reverting application code alone does not reverse a database change. Backups and restore procedures must be tested before such migrations are approved.

This document authorizes no database backup/restore, deployment, credential change or automatic update. Explicit merchant migration code exists, but executing it remains a separately scoped owner operation.


## Merchant commerce schema v1 → v2

Version 2 is an explicit additive merchant migration. Preserve the applied v1 SQL/checksum unchanged; the v2 checksum covers the reviewed v1 base plus the appended v2 SQL. Upgrade only a recognized version-1 merchant schema whose recorded checksum, application, merchant and location match the configured installation. An unrecognized checksum or table set is a hard stop, not a reason to edit migration records. A repeated run against recognized v2 is a verification/no-op, not a reseed.

V2 binds the commerce environment and adds operating settings, quote/pickup snapshots, customer lookup-token hashes/expiry and durable fulfillment requests. A sandbox v1 database retains sandbox ownership; the migration must not change it into production. Customer lookup tokens are secrets and must not be printed in migration logs. Historical attempts, provider identities, reservations, refunds and webhook receipts must remain intact.

Use the explicit owner-run merchant schema command from the installation guide (`pnpm merchant:db:setup --upgrade-reviewed-catalog` for a recognized existing merchant database). Confirm the selected release supports the actual starting version. Do not attach this command to startup, healthchecks or a blanket automatic deployment hook. First complete or explicitly account for outstanding financial/fulfillment outcomes and quiesce new checkout dispatch; webhook reconciliation must not silently be lost during a cutover.

## Backup and isolated restore rehearsal

Before an approved migration or release:

1. Record deployed commit, schema version/checksum, environment/application/merchant/location binding, service start settings and the exact database/volume identity. Record counts and identities of unsettled orders, reservations, refunds, fulfillment requests and optional email outbox entries (including unknown provider outcomes). Keep secrets in the existing protected secret store, not in this manifest.
2. Obtain a protected database backup through the approved hosting/backup workflow or a reviewed PostgreSQL dump process. Do not put a password or connection URL in command arguments, source, chat or logs. Restrict backup access and retention; order/contact data is private. Record the backup timestamp and checksum and confirm that restore tooling is compatible with the PostgreSQL version.
3. Restore **only to an explicitly approved isolated copy**. Never overwrite the live database as a trial. Disable provider requests, outgoing mail, scheduled jobs and public access in the copy; do not reuse its live access/session keys in another exposed application. Reading a backup does not authorize additional accounts or infrastructure.
4. Inspect schema/checksum and representative order, reservation, refund, fulfillment, webhook-deduplication and optional email schema/outbox records. Confirm financial totals and unknown liabilities survive. Run the intended migration on this copy and test restart and re-execution, then run mocked/injected acceptance. Rehearse native contention tests on a separately disposable test database, not the restored live data.
5. Record the restore duration, data cut-off, evidence and responsible operator. A backup file that has not been successfully restored is not a tested rollback plan.

## Rollback boundaries

There is **no automatic v2 → v1 downgrade**. A v1 binary may reject a v2 table set and lacks v2 ownership/customer-token/fulfillment semantics. Do not drop new columns/tables, truncate receipts or rewrite checksums to force an older binary to start. Prefer a compatible forward fix. A database restore is a separate authorized recovery action and must account for every Square effect after the backup cut-off; otherwise restoring old state can resurrect spendable stock, lose refunds or duplicate charges. Never retry unknown operations with fresh identities after a restore.

Restoring PostgreSQL cannot reverse a Square charge/refund/pickup change or recall a Resend request already accepted or possibly accepted. Unknown provider outcomes remain unknown even if the restored database predates them. Reconcile every external effect since the backup cut-off using original provider identities before reopening checkout or draining mail. Keep email disabled during restore; preserve its stored activation cutoff and frozen payload/idempotency scope, and never manufacture a replacement key or reset dispatch age to force another send. A restored “queued” row is not evidence that the original message was unsent. Retain the newer incident/provider evidence outside the restored copy in protected records.

Choose a maintenance/cutover plan only after this rehearsal, release checks and target-specific authorization. Retain the prior artifact, protected backup, configuration manifest and a written reconciliation plan. MIT rights to modify and redistribute code do not grant access to another merchant's infrastructure. Remote restart/credential approvals remain target-specific.
