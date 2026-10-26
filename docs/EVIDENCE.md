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

After explicit endpoint approval, a public endpoint was created at 12:21 UTC. The normal deployment aligned to its exact origin reached success and passed the platform healthcheck at 12:28 UTC. Authenticated secure-browser login is **not proven**: its user authorization prompt was still pending at 12:30 UTC. Endpoint creation, internal HTTP checks and a successful platform healthcheck do not substitute for that login acceptance. No live payment, actual email delivery, mobile-device acceptance or new merchant checkout certification follows from these setup results.

## Not yet established

A complete fresh buyer Railway installation (including authenticated secure-browser login and the published first-admin stdin path), real mobile-device acceptance, safe upgrade of a customized/ejected buyer fork, actual buyer policies/stock/credentials and live production-payment acceptance remain separate gates. Optional sender/account setup and actual authorized mail delivery are also separate. Narrow viewport checks do not prove real-device behavior; accepted email does not prove inbox arrival.

Follow the manual installation and operating handoff. Preserve all existing provider identities and unknown liabilities across restarts/restores. This summary grants no permission to provision resources, configure secrets, enable payments or send mail.
