# Optional buyer-owned order confirmation email

Email is **disabled by default**. Existing sandbox/base commerce schema 2 needs no email tables, credentials, mail service, or polling process. Deploying code does not authorize real sends, production payment activation, domain changes, or new paid resources.

## Scope and limits

One plain-text paid-order confirmation per new completed checkout, using the buyer's **Resend** account and verified sender. No marketing, password resets, automatic refund emails, or delivery webhooks. No customer checkout/write token or private order-lookup bearer link is included. The message confirms a historical payment, not current fulfillment/refund status.

Provider acknowledgment means **accepted**, not delivered. Inbox arrival, suppression, bounce/complaint investigation and spam handling remain the buyer's responsibilities in Resend. Do not claim guaranteed delivery from accepted counts.

## Explicit buyer setup

1. Verify the sender domain with Resend; configure appropriate SPF/DKIM/DMARC. Review suppression/bounce policies. Disable open/click tracking for transactional messages. Use a least-privilege sending key.
2. Keep new purchases **closed throughout migration/configuration cutover**. Choose a fresh UTC activation cutoff later than every existing checkout. Preserve it on future deploys. Old checkouts, including old pending ones that later succeed, are not backfilled.
3. Deploy protected provider/sender/key/cutoff settings while keeping email **disabled**, so the existing container can start before optional tables exist:
   - MERCHANT_EMAIL_ENABLED=false (until migration completes)
   - MERCHANT_EMAIL_PROVIDER=resend
   - MERCHANT_EMAIL_FROM=orders@your-verified-domain.example (plain mailbox, not a display-name header)
   - MERCHANT_EMAIL_RESEND_API_KEY (secret; never commit or pass in command arguments)
   - MERCHANT_EMAIL_ACTIVATED_AT: actual current canonical UTC ISO timestamp including milliseconds; format YYYY-MM-DDTHH:mm:ss.sssZ.
   - Square sandbox additionally requires MERCHANT_EMAIL_SANDBOX_RECIPIENT: one explicitly approved test mailbox. All sandbox mail is redirected there and labeled [SANDBOX]. This is a **real Resend test email**, not a simulation.
   - Production forbids the sandbox-recipient override. Production payment configuration gates remain separate and unchanged.
4. Back up the merchant database and rehearse on an isolated restore. From the authenticated running container (or an explicitly approved shell on the same private network), run the following with protected settings already available. Only the nonsecret enable flag is temporarily overridden for this command:

       MERCHANT_EMAIL_ENABLED=true node --import tsx scripts/merchant-email.ts --migrate-reviewed

   This creates only checksummed optional merchant_email_schema and merchant_email_outbox tables. It sends nothing and refuses partial/unknown schemas or a changed stored cutoff. Base commerce stays version 2; no startup DDL occurs.
5. After migration succeeds, set MERCHANT_EMAIL_ENABLED=true and redeploy/restart the normal runtime. A valid enabled integration runs one bounded startup reconciliation/drain. Perform an authorized test before opening buyer traffic. Never enable the runtime before the explicit migration: missing optional tables correctly refuse startup, which could remove your shell access.

The initial cutoff must be within 15 minutes before migration (at most one minute in the future), later than every pre-existing checkout. A future cutoff excludes checkouts created before that instant. Deployment time counts against this window. If deployment took too long, refresh the protected cutoff before the first migration while purchases remain closed; after successful migration it must never change. Subsequent runs require the unchanged stored cutoff. No public setup/bootstrap endpoint exists.

These capability/setup instructions do not authorize an assistant to provision credentials, alter DNS, migrate an account, activate production or send messages without the relevant permission.

## Durability and operations

Payment commits **before** email reconciliation. Email rendering/provider/storage failures cannot roll back successful payment. A separate transaction finds eligible completed attempts and inserts one unique (attempt, order_confirmation) entry. A crash gap is recovered at the next enabled startup, relevant successful request, or explicit administrator drain. Already fully refunded attempts are not newly enqueued.

The outbox freezes sender, recipient, subject, body, payload hash, and provider idempotency key. Branding/settings changes never rewrite pending messages. Recipient/body are customer data: restrict database/backups; never expose them in public APIs, logs, screenshots, or support exports.

Bounded passes run at enabled startup, asynchronously after successful payment/recovery/webhook responses, or when an authenticated administrator chooses **Process up to 5 eligible confirmations**. Equivalent explicit commands:

    node --import tsx scripts/merchant-email.ts --status
    node --import tsx scripts/merchant-email.ts --drain

There is **no permanent polling or scheduled retry worker**. Delayed retries require a later trigger or administrator action; monitor the queue. Each pass reconciles at most 20 new confirmations and attempts at most 5 messages. Repeat an explicit drain for larger backlogs. CLI output contains counts, not addresses/bodies/secrets.

Unknown responses and expired leases preserve original identities. Retry uses identical payload/key, exponential backoff and at most five attempts. Resend retains idempotency keys for 24 hours; this implementation stops conservatively after **23 hours from first dispatch**. Old unsent entries also require review rather than sending stale confirmations. Needs-review does not prove a message was unsent.

Changing credentials blocks unresolved retries because provider account/idempotency scope might change. Inspect the original provider account before deciding what happened. No UI action creates a new identity to blindly resend an unknown outcome.

A queued confirmation may be accepted after an order changes or is refunded. Its wording describes the original payment, not present pickup eligibility. Never treat email as authorization to fulfill an order.

## Disable, upgrade and rollback

Set MERCHANT_EMAIL_ENABLED=false (or remove it) and restart instances. No worker or polling is installed while disabled. Existing optional tables are preserved; startup checks their known marker/checksum but does not dispatch or reconcile outbox entries. Toggling configuration cannot recall an already-sent provider request.

Migration is explicit and repeat-safe. Do not modify applied migration SQL/checksums. Older binaries unaware of optional tables can refuse startup; use a compatible rollback version, not dropped records. Never restore old outbox state and replay sends without reconciling provider effects since backup.

## References
- [Resend idempotency retention](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction)
