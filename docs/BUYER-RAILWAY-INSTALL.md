# Buyer installation: manual Railway sandbox first

**Current entrypoint — 2026-10-26.** Start here, not at the historical demo instructions in README. V1 is one merchant/location, USD, physical pickup and website-owned stock. The clean source distribution is MIT-licensed; production authorization and access to merchant accounts/infrastructure are not implied by that license or this guide.

The existing implementation has real existing-host Square Sandbox/browser payment, refund and pickup evidence, plus local native PostgreSQL fresh-setup/restore evidence. **A new buyer's fresh Railway deployment has not been verified.** Existing-host acceptance is not proof of a reproducible new hosted installation. See [sanitized evidence](EVIDENCE.md) and [operator handoff](MERCHANT-HANDOFF.md).

## 1. Establish the target and access before executing

The owner approves the target project/environment, one app service, a dedicated PostgreSQL service/volume, spending limits and responsible operator. Record their IDs and a full tested release commit. Never reuse the historical synthetic or acceptance database as a buyer database. Do not create these resources, grant repository access or transfer credentials merely because these instructions exist.

The operator needs an authorized shell with Node 22.12+ within 22.x or Node 24.x, pnpm 12.14.0, this exact release checkout, and connectivity to the dedicated database. **A laptop cannot resolve a Railway private-network database hostname just because Railway variables were copied into it.** Use an approved same-private-network operator shell, or an already approved reachable database connection with verified TLS. If neither is available, stop before schema setup and record that installation blocker; do not expose a database or create a temporary service as an implicit workaround. The temporary SSH hold workflow below addresses the first-start/private-network dependency without exposing a setup endpoint. It is operator-driven, not one-click provisioning, and has not yet been verified in a fresh buyer Railway deployment.

## 2. Supply server configuration securely

Use the app's protected environment controls. The same approved configuration must be available to the explicit setup/provision commands; no `.env` file is loaded automatically. Do not put secrets in the settings record below, source, browser variables, command arguments, screenshots or logs.

| Variables | Sandbox-first value |
| --- | --- |
| `STARTER_DATASET` | `merchant-catalog-v1` |
| `MERCHANT_DATABASE_URL` | This merchant's dedicated database URL. App runtime should use the database service's resolved private-network reference. Public remote URLs must use verified TLS. |
| `STARTER_STORAGE` | `postgres` or omit |
| `PUBLIC_ORIGIN` | Exact approved HTTPS app origin, no path/query/fragment |
| `SQUARE_ENVIRONMENT` | `sandbox` |
| `SQUARE_MERCHANT_COMMERCE_ENABLED`, `SQUARE_SANDBOX_REQUESTS_ENABLED` | Both exactly `true` after owner approval for sandbox access |
| `SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID`, `SQUARE_SANDBOX_MERCHANT_ID` | Approved application/seller/location; sandbox application begins `sandbox-sq0idb-` |
| `SQUARE_SANDBOX_ACCESS_TOKEN`, `SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY` | Dedicated server-only values belonging to that sandbox and exact callback URL |
| `MERCHANT_ADMIN_SESSION_KEY` | Securely supplied canonical base64url 32-byte key (43 characters) |
| `MERCHANT_NAME`, `MERCHANT_PICKUP_LABEL`, `MERCHANT_PICKUP_INSTRUCTIONS` | Reviewed nonempty display strings, maximum 100 / 100 / 500 characters |
| `SQUARE_MERCHANT_WEBHOOK_PATH` | Omit for `/api/commerce/webhooks`; only use `/api/sandbox/webhooks` when deliberately preserving an approved existing subscription |
| `PORT` | Railway supplied; do not hard-code the public HTTPS port |

Omit `DATABASE_URL`, `STARTER_DB_BOOTSTRAP`, acceptance/fixture variables and all production credentials. Leave production activation absent or exactly `false`. Do not copy a sandbox token to a production field. Provider subscription creation, credentials and administrator provisioning remain separate approved operator actions.

Full variable validation is documented in [merchant installation](MERCHANT-COMMERCE-INSTALL.md). Configure the exact callback URL in the approved Square sandbox subscription; domain/path/signing-key mismatches invalidate signatures. No import, automatic catalog synchronization or customer email is enabled merely by configuration. Optional [transactional email setup](MERCHANT-EMAIL.md) is a separate handoff item; never promise receipt delivery until its configured sender and actual delivery are verified.

## 3. Build and run explicit one-time setup

From the exact release checkout in the approved connected operator environment:

```sh
pnpm install --frozen-lockfile
pnpm check
node scripts/check-setup.mjs --profile merchant-sandbox --fresh
pnpm merchant:db:setup --initialize-empty
```

The first checker is offline/static only. The last command performs schema writes and must target an approved **empty** database. It seeds no administrator, products or stock. If a previous run had an uncertain result, inspect the existing recognized state before choosing another action; do not retry empty initialization blindly or drop tables to make it succeed.

For a recognized existing merchant catalog/commerce schema only, use the reviewed upgrade command instead of empty initialization:

```sh
pnpm merchant:db:setup --upgrade-reviewed-catalog
```

Provision the first administrator once, with a separately approved password of **16–128 UTF-8 bytes, without ASCII control characters**, supplied through a trusted **non-echoing stdin stream**:

```sh
pnpm merchant:admin:provision
```

The package alias already supplies `--password-stdin`; **do not append it again**. The script refuses interactive TTY input and existing accounts. Do not use `echo PASSWORD`, a command-line password or a documented default password. Existing-account recovery is a distinct approved operation, not reprovisioning. Keep schema/provision commands out of recurring build, predeploy, start and healthcheck hooks.

### Private-network first install: temporary non-serving SSH hold

Use this only for a newly approved buyer app/database, never as an alternate mode for an existing storefront with pending orders. [Railway SSH](https://docs.railway.com/cli/ssh) supports commands in running containers and piped stdin without a PTY; it also documents service-instance access without a public domain. These platform capabilities support the following proposed operator sequence, **not yet fresh-host acceptance evidence**. Prerequisite: authenticated Railway access and an existing registered SSH key authorized for this exact service/workspace. The CLI can prompt to register a key on first use; do not accept that access-changing prompt without the owner's specific authorization. This guide performs no key registration/access grant.

1. Configure the same release/app environment above. In protected service settings add `BUYER_BOOTSTRAP_MODE=manual-ssh-only-v1`, `BUYER_BOOTSTRAP_PROJECT_ID`, `BUYER_BOOTSTRAP_ENVIRONMENT_ID` and `BUYER_BOOTSTRAP_SERVICE_ID` matching the actual Railway-provided target IDs. Set `BUYER_BOOTSTRAP_EXPIRES_AT` to an owner-approved absolute UTC deadline no more than one hour after intended startup. Do not silently extend the deadline after expiry.
2. For this one temporary deployment, use build `pnpm check`, static-only predeploy `node scripts/check-setup.mjs --profile merchant-sandbox`, start `node scripts/merchant-bootstrap-hold.mjs`, **no HTTP healthcheck**, one replica and restart policy **Never**. Review any effective legacy override. The hold opens no port, connects to no database, seeds nothing and prints no secrets; it only keeps an authenticated operator target alive until its fixed expiry. Do not attach a public domain to this hold. This is not a storefront and should receive no public traffic. The native schema initializer is never a predeploy hook.
3. After the hold is actually running, retrieve the actual running **deployment-instance ID** from the approved deployment metadata and verify it belongs to the intended hold deployment. This is not the app service UUID, and do not assume a separately labeled service-instance ID is interchangeable with this CLI argument. Include `--deployment-instance` below because the hold has no public domain; retain the project/environment/service selectors as additional scope. Unlike `railway run`, this executes inside the container/private network:

   ```sh
   railway ssh --project <project-id> --environment <environment-id> --service <app-service-id> --deployment-instance <hold-instance-id> -- node --import tsx scripts/setup-merchant-commerce.ts --initialize-empty
   ```

   Require a successful sanitized schema receipt. If the connection/result is uncertain, inspect existing state before any retry; do not drop/recreate or repeat empty initialization blindly.
4. Pipe the approved password manager's non-echoing output into the following command (it intentionally refuses interactive TTY input when run alone):

   ```sh
   railway ssh --project <project-id> --environment <environment-id> --service <app-service-id> --deployment-instance <hold-instance-id> -- node --import tsx scripts/provision-merchant-admin.ts --password-stdin
   ```

   This is the direct script, so exactly one stdin flag is required. Do not type passwords into SSH arguments, environment variables, shell history or a public setup form. Confirm the first-admin receipt; uncertain provisioning requires inspection, not an account reset.
5. Remove the temporary `BUYER_BOOTSTRAP_*` variables and replace the temporary start/health settings with the normal values below. Keep predeploy static-only; restore the reviewed normal bounded restart policy. Deploy the same tested release after this specific cutover is approved. Preserve the database/volume. After switching to the normal serving runtime, attach or verify the separately approved public domain and HTTPS certificate; its origin must exactly match `PUBLIC_ORIGIN`. Do not attach a public domain while the non-serving hold is active. If the final origin differs from the planned value, stop and obtain the required configuration/subscription approval before aligning the protected origin and exact Square callback URL/signing key. Then verify HTTPS login and the closed merchant storefront before import/activation. If SSH, non-PTY streaming, private DNS or hold deployment does not work on the target, stop and record the blocker; never expose the database or add resources as a silent fallback.

The offline buyer-plan checker below intentionally **rejects** the hold start command: it checks the normal operating state only. The hold's deadline stops its process, not retained storage charges; the owner must still complete the agreed compute/storage cleanup. A redeploy after expiry cannot pass the old deadline.

## 4. Set and verify effective Railway service commands

For the approved merchant app, use the supported service settings interface and verify the effective deployment values, including any legacy file override. Do not assume the repository's default `railway.json` describes this installation: it starts the historical synthetic server. Do not change that default to migrate an unrelated existing service.

| Setting | Required merchant value |
| --- | --- |
| Build | `pnpm check` |
| Predeploy | `node scripts/check-setup.mjs --profile merchant-sandbox` |
| Start | `pnpm start:merchant` |
| Health path | `/api/health` |
| Replicas for this initial handoff | `1` |
| Automatic schema/provision/import commands | None |

Record the **actual observed** effective settings in an operator-owned JSON file outside source control, with exactly these fields (replace bracketed placeholders; they deliberately fail validation):

```json
{
  "schema": "buyer-railway-sandbox-v1",
  "releaseCommit": "<full-40-character-tested-commit>",
  "projectId": "<project-uuid>",
  "environmentId": "<environment-uuid>",
  "appServiceId": "<app-service-uuid>",
  "databaseServiceId": "<distinct-database-service-uuid>",
  "buildCommand": "pnpm check",
  "preDeployCommand": "node scripts/check-setup.mjs --profile merchant-sandbox",
  "startCommand": "pnpm start:merchant",
  "healthcheckPath": "/api/health",
  "replicas": 1,
  "automaticSchemaChanges": false
}
```

With the resolved app environment securely supplied, compare that record offline:

```sh
node scripts/check-buyer-railway-plan.mjs --plan /protected/operator-settings.json
```

A successful exit proves only that the supplied record and static environment match the documented sandbox contract. It does **not** read Railway, verify target ownership, check database contents, prove that the record is truthful/current, deploy anything or authorize payments. Preserve the independent effective-setting and deployment receipts with the handoff.

After the specifically approved deployment, verify terminal success, expected commit, `/api/health`, `/api/storefront` merchant mode, HTTPS origin and `/admin/login`. An HTTP 200 or successful static check alone is not acceptance. If configuration/checksum/identity fails, leave checkout closed and diagnose; do not weaken validators or reseed.

## 5. Merchant workflow and acceptance receipts

1. Sign in as the provisioned administrator. Complete branding, support/refund/privacy policies, timezone, pickup hours, lead time, manual capacity policy and closure dates. Capacity is an operator policy, not automatically enforced order-slot capacity. Do not use fictional default policies for a buyer.
2. Verify seller/location, import and approve the disabled Square catalog using **Website** stock ownership. Review held items; modifiers remain unsupported. Assign deliberately allocated website stock, enable intended variants, then open sandbox checkout.
3. In a supported browser verify shopper flow, inclusive/additive taxes and configured discounts, scheduled pickup and amount-bound Square SDK test-card tokenization. Record actual sandbox payment IDs privately, never tokens. Test decline, refresh/restart identity and unknown outcomes without replacement charges.
4. Verify real signed webhook delivery, matching identities, deduplication, partial/full refunds without automatic restock, pending/unknown liability recovery, and buyer-visible pickup state. Record whether replay was injected/local or actually delivered; do not conflate them.
5. Close new purchases when acceptance ends, preserve recovery access/history and reconcile outstanding liabilities. Record native contention, desktop/narrow layout, real-device and fresh-host proof separately; leave missing categories explicitly unverified.

Existing implementation acceptance receipts do not satisfy steps 1–5 for a new merchant. No live charges, customer emails, public publication or production enablement are part of this sandbox handoff.

## 6. Backup, upgrade and ownership handoff

Before accepting operational ownership, record a protected backup timestamp/checksum, retention/access owner and successful **isolated restore** receipt. Include schema version/checksum, app release, provider binding and unsettled order/refund/fulfillment identities. Never copy credentials into that manifest. The project's PostgreSQL 18 local restore drill is useful implementation evidence, not proof of the buyer's backup policy or Railway restore.

Before a later upgrade: review release/migration compatibility, close new checkout dispatch, reconcile or account for every unknown liability, back up, rehearse on an authorized isolated copy with providers/mail disabled, run required checks, apply only the explicit reviewed merchant upgrade, deploy the compatible artifact and verify recovery. Preserve old receipts and the previous artifact. No automatic v2-to-v1 downgrade is supplied; restoring old data can lose later provider effects and requires a separate approved reconciliation plan. See [UPGRADES.md](UPGRADES.md) for the full rehearsal and rollback constraints.

Handoff is incomplete without a responsible operator, current evidence ledger, secure account ownership, buyer policies, tested recovery and [MERCHANT-HANDOFF.md](MERCHANT-HANDOFF.md). A separate production-readiness decision must precede live credentials/activation. MIT licensing does not close these installation or production-readiness gates.
