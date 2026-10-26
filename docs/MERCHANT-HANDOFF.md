# Single-merchant operating handoff

Start with the [current buyer Railway installation guide](BUYER-RAILWAY-INSTALL.md). Existing-host sandbox evidence does not certify a fresh buyer installation or live production.

## What the buyer receives

V1 is one merchant, one location, USD, physical pickup and a website-owned stock allocation. Square variation IDs and authoritative Square tax/discount totals are used; website stock is not a promise of automatic POS inventory synchronization. Keep gift cards, loyalty, subscriptions, delivery and multi-merchant hosting out of the launch promise unless separately implemented and accepted.

The production code path is disabled by default. A passing local test suite, fake-card sandbox charge, repository commit or deployed demo is **not** live merchant certification. The MIT source license does not grant live credentials, live-charge authority, provider subscription changes or customer-email permission. This guide does not itself publish a Railway template.

## Record before ownership transfer

- Buyer/business owner and responsible technical operator; verified support/recovery channel.
- Approved application domain, Railway project/environment/service, database and volume, deployed commit and schema checksum/version.
- Square environment, application, merchant and location IDs; do not include access tokens/signature keys/passwords.
- Timezone, weekly pickup hours, lead time, capacity, closure dates and the shopper-visible pickup/refund policies.
- Website stock allocation and who reconciles physical stock versus other sales channels.
- Backup retention/access owner, latest successful isolated restore rehearsal and escalation procedure.
- Evidence ledger: local/unit, injected-provider, native PostgreSQL, browser desktop/mobile, actual sandbox payment/refund/webhook and fresh install. Mark any missing proof explicitly.

Keep credentials in buyer-owned protected secret controls. Transfer access through the service's supported secure process, not plaintext chat, source, environment exports or email. Do not rotate credentials merely because a handoff guide exists; obtain action-time permission for that specific account change.

## Admin access and recovery

Initial provisioning creates exactly one administrator and refuses existing accounts. For a lost password or lockout, an authorized operator with the correct recognized merchant database can recover **the existing enabled administrator only**:

```sh
node --import tsx scripts/recover-merchant-admin.ts --password-stdin
```

Before execution, obtain the owner's explicit action-time permission for the target merchant account/database and explain that every active merchant staff session will be revoked. Confirm environment/application/merchant/location and canonical HTTPS origin from protected configuration. Supply a fresh 16–128 UTF-8-byte password via a trusted **non-echoing stdin stream**. Do not place it in shell arguments, environment variables, source, logs, screenshots or chat. The script rejects interactive/echoing TTY input and prints no credentials. Do not use a sample/default password from documentation.

Recovery uses the existing strong scrypt policy, fresh random salt, a locked existing admin row, and one transaction for verifier replacement, lockout reset and deletion of all merchant sessions. Unknown schemas, wrong identities, absent administrators and intentionally disabled accounts are refused. It does not create a replacement account, reactivate a disabled user, rotate the session-signing key or expose an HTTP reset backdoor. A failed transaction must leave the prior account and sessions unchanged.

After approved execution, the owner signs in through `/admin/login` and verifies that previous sessions no longer work. Record only the time, target identity, operator and outcome—never the password or session cookie. If compromise is suspected, separately review provider/session credentials and access grants rather than silently treating a password reset as complete incident remediation.

## Daily operation

1. Review operating hours, promised pickup slots and website stock before opening checkout. Reserve stock for other channels deliberately; do not inflate website stock to match a stale POS display.
2. Review orders and reconcile uncertain outcomes before preparing goods. Payment completion alone is not permission to ignore a pending refund or mismatched Square order.
3. Advance pickup through the supported Square-backed fulfillment workflow. Confirm provider state and version; a local label alone is not fulfillment evidence. Do not bypass pending/unknown fulfillment safeguards after timeout.
4. Use the customer receipt/status lookup as designed; lookup tokens are bearer secrets. Do not share someone else's receipt link or add customer emails to logs. Scheduled pickup must use the merchant's reviewed policy, not a fictional demo time.
5. Review financial exceptions, backups, deployment health and failed webhook deliveries. Preserve receipt history.

## Unknown payments, refunds and fulfillment

- An absent measurement or temporarily empty payment search is not proof of no charge. Keep the original checkout identity and inventory hold while reconciliation is required.
- Recover a payment through verified provider reads/signed callbacks; never re-tokenize and submit a second charge just because the first response was lost.
- Explicit order/refund retries use the same persisted provider idempotency identity and request. Do not make a new refund identity after timeout, authentication failure or uncertain recovery.
- Pending, unknown and external refunds reduce the remaining refundable balance. Signed terminal results are deduplicated; do not add multiple accounting views of one refund.
- Refunds do not automatically restock. Review physical disposition and adjust website stock deliberately only when appropriate.
- Uncertain fulfillment changes require provider reconciliation using the same operation identity/version. Do not mark a conflicting or refunded order ready merely to clear an exception.

## Launch and deployment stop rules

Use the supported Railway service settings/IaC interface and verify the effective commands/revision; deprecated alternate-config-file selection is not a reliable deployment mechanism. Never repurpose the historical synthetic database or reseed a merchant database.


Before a live launch, complete the current release checks, isolated restore rehearsal, target-specific secure setup, approved real-browser acceptance and owner operating handoff. Customer emails remain off until a separately configured and approved transactional-email system is verified. Record actual limitations rather than marketing previews as completed launch features.
