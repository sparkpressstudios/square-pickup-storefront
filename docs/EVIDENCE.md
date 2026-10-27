# Evidence summary and remaining gates

This is the sanitized evidence summary for `0.1.0-rc.1`, not a public launch certification. Detailed operational receipts and private deployment identifiers are retained by the maintainer, not included in this candidate.

## Existing implementation evidence

- The existing authorized Square Sandbox merchant flow was exercised with the genuine Web Payments SDK in a supported browser: successful test payments, safe terminal decline, full refund, persisted identity/reload and buyer-visible pickup progression. No live charge or customer email is implied.
- Local application tests cover server-owned totals, inclusive/additive tax behavior, idempotency, signed/reordered callbacks, uncertain payment/refund/fulfillment handling, stock bounds, scoped staff access and CSRF.
- Independent native PostgreSQL work exercised setup, schema upgrade, restart, contention and an actual local backup/restore. Optional email native tests use injected transport, not actual customer delivery.
- Public-subset build and test results must be recorded for the actual candidate artifact. Removing private acceptance helpers changes the test inventory; upstream counts are not candidate pass counts.

## Partial fresh Railway proof — 2026-10-26

A clean public-source app pinned to the reviewed documentation-fix revision built successfully (334 application tests passed) and reached a successful temporary non-serving hold. The target used a dedicated PostgreSQL 18 service and new 1 GB volume. Target identifiers and operational receipts remain private.

The authenticated native Railway Console opened without registering an SSH key. Its shell omitted Node from `PATH`; the operator discovered the installed supported binary rather than changing the image. At 11:56:52 UTC, the published empty merchant schema initializer succeeded against that dedicated database. At 11:57:36 UTC, a separately authorized private hash-only first-administrator operation succeeded. No helper, verifier, password or target identity from that operation is distributed here.

This proves neither the complete published stdin provisioning path on Railway nor a completed buyer installation. The ordinary stdin-only provisioning path has local evidence; the private host operation is not a substitute receipt for it. The normal merchant runtime subsequently reached deployment success and passed the platform `/api/health` check at approximately 12:07 UTC; the temporary hold was replaced. Internal health/storefront checks through the authenticated Console at 12:09 UTC returned HTTP 200, zero products, checkout disabled, email disabled and schedulers disabled. Temporary seed and hold settings were absent.

After explicit endpoint approval, a public endpoint was created at 12:21 UTC. The normal deployment aligned to its exact origin reached success and passed the platform healthcheck at 12:28 UTC. After the owner completed the secure browser authentication step, independent browser accessibility inspection at 14:02:57 UTC verified the authenticated HTTPS `/admin` dashboard with a Sign out control. The installation was closed to new orders, with no imported variants or checkout attempts; email and its processing control were disabled. This establishes protected administrator login on the fresh host, not just a public page or platform healthcheck. A final browser reload at 14:04:36 UTC preserved the authenticated administrator view, configured branding, zero orders/products, closed checkout and disabled email. After acceptance, the application deployment was removed at 14:06:07 UTC, followed by the database deployment at 14:07:08 UTC. Guard and independent operator checks at approximately 14:08 UTC confirmed both services offline, all listed deployments in REMOVED state and no staged changes. Services, the 1 GB volume and database data were preserved; retained storage may still incur charges. After separate explicit owner approval, the two stopped test services and their isolated test volume were permanently deleted; an inventory check at 15:04 UTC confirmed no services or volumes remained in the proof environment. The original existing installation was independently verified unchanged. No live payment, actual email delivery, mobile-device acceptance or new merchant checkout certification follows from these setup results.

## Not yet established

The published first-admin stdin provisioning path on a fresh Railway host, real mobile-device acceptance, safe upgrade of a customized/ejected buyer fork, actual buyer policies/stock/credentials and live production-payment acceptance remain separate gates. Optional sender/account setup and actual authorized mail delivery are also separate. Narrow viewport checks do not prove real-device behavior; accepted email does not prove inbox arrival.

Follow the manual installation and operating handoff. Preserve all existing provider identities and unknown liabilities across restarts/restores. This summary grants no permission to provision resources, configure secrets, enable payments or send mail.


## rc.2 release notices

The rc.2 change adds free authenticated read-only release notices, not a new merchant schema or production-acceptance claim. The historical rc.1 evidence above remains historical. Required local regression checks and focused release-notice tests accompany the rc.2 commit; hosted/mobile card acceptance and customized-fork upgrade rehearsal remain unverified.

## rc.3 pickup stock-capacity correction

Local regressions exercise outstanding reservation capacity during stock edits and both cancellation/expiry release paths. This does not certify native multi-process race behavior, fresh hosted installation, mobile acceptance or a customized-fork upgrade. No schema migration or shipping capability is added. Historical sandbox and restore evidence above remains historical.
