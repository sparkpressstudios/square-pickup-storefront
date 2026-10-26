# Evidence summary and remaining gates

This is the sanitized evidence summary for `0.1.0-rc.1`, not a public launch certification. Detailed operational receipts and private deployment identifiers are retained by the maintainer, not included in this candidate.

## Existing implementation evidence

- The existing authorized Square Sandbox merchant flow was exercised with the genuine Web Payments SDK in a supported browser: successful test payments, safe terminal decline, full refund, persisted identity/reload and buyer-visible pickup progression. No live charge or customer email is implied.
- Local application tests cover server-owned totals, inclusive/additive tax behavior, idempotency, signed/reordered callbacks, uncertain payment/refund/fulfillment handling, stock bounds, scoped staff access and CSRF.
- Independent native PostgreSQL work exercised setup, schema upgrade, restart, contention and an actual local backup/restore. Optional email native tests use injected transport, not actual customer delivery.
- Public-subset build and test results must be recorded for the actual candidate artifact. Removing private acceptance helpers changes the test inventory; upstream counts are not candidate pass counts.

## Not yet established

A fresh buyer Railway/SSH installation, real mobile-device acceptance, safe upgrade of a customized/ejected buyer fork, actual buyer policies/stock/credentials and live production-payment acceptance remain separate gates. Optional sender/account setup and actual authorized mail delivery are also separate. Narrow viewport checks do not prove real-device behavior; accepted email does not prove inbox arrival.

Follow the manual installation and operating handoff. Preserve all existing provider identities and unknown liabilities across restarts/restores. This summary grants no permission to provision resources, configure secrets, enable payments or send mail.
