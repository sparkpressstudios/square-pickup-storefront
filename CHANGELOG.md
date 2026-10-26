# Changelog

## 0.1.0-rc.2 — 2026-10-26

Free administrator release notices, following the rc.1 distribution. Installed version is read from the package; the public manifest advertises this newer candidate so rc.1 notice-capable installations can identify it. Older rc.1 installations without the notice feature still require manual review or Railway's template update flow.

- Administrator-only read-only Updates page and dashboard link; bounded cached checks, offline/stale reporting, security/migration/acceptance notes and fixed official upgrade/changelog links.
- No new schema, configuration migration, credentials, billing, background polling or automatic deployment. Merchant commerce schema remains **2**; optional email schema remains **1**. The existing compatibility and backup/restore guidance still applies.
- Required full checks retain restart and unknown-outcome regression coverage, plus release-notice authentication, cache, failure, SemVer and UI tests. Historical local restore evidence is unchanged. No hosted or custom-fork upgrade rehearsal is claimed for rc.2; those acceptance gaps remain open.
- All rc.1 production, fresh-buyer, real-device and optional email acceptance limits below remain in effect. This candidate does not unlock premium access or change free MIT rights.

## 0.1.0-rc.1 — 2026-10-26

Sanitized MIT-licensed public-distribution candidate for the existing reviewed implementation. Copyright 2026 SparkPress Studios. Private source provenance is retained separately. This metadata release changes no payment, email, schema or activation behavior. This document does not assert a published repository or Git tag, or production certification.

### Implemented
- Free read-only administrator Updates screen: installed/latest version, release/security/migration notes, bounded cached checks and owner-controlled upgrade guidance. No automatic deployment, migration, paid access or data mutation.
- Single-merchant/location USD pickup storefront, imported Square catalog and separate website-owned stock.
- Authoritative Square tax/discount totals, durable checkout identities, signed webhook recovery, refunds and pickup fulfillment.
- Database-backed merchant configuration, private customer confirmation/status, scoped administrator controls and explicit checkout status.
- Optional buyer-owned Resend confirmation outbox, disabled by default; immutable retry identities and conservative unknown-outcome handling. Provider acceptance is not delivery.
- Explicit manual Railway buyer setup, non-serving bounded bootstrap hold, configuration checks, backup/restore and upgrade guidance.

### Verified evidence
- Existing hosted Square Sandbox: two successful $1.91 test payments, one terminal decline, one full refund and pickup ready-to-collected. Signed natural callback retries recovered without replacement charges/refunds.
- The underlying implementation passed its required checks and native email tests with injected transport. Candidate-specific test counts must be recorded after private helper exclusions; upstream totals are not candidate evidence.
- Normal buyer initialization and actual local PostgreSQL backup/restore were tested; these do not certify a newly provisioned Railway buyer installation.

### Compatibility and remaining gates
- Runtime merchant commerce schema: **2**. Optional email schema: **1**, installed only by explicit buyer action. Existing schema-2 installations need no email migration while email remains disabled.
- Node 22.12+ within 22.x or Node 24.x; pnpm 12.14.0. Preserve applied migration SQL/checksums and consult [upgrade compatibility](docs/UPGRADES.md).
- Fresh buyer Railway/SSH execution, mobile-device acceptance, real sender delivery and actual merchant production activation remain unverified or owner-dependent.
- Hosted sandbox new purchases and email dispatch remain disabled; existing-order status and recovery remain available. No live payments, customer emails or new infrastructure are enabled by this release. MIT licensing and public-distribution approval do not establish production readiness.

Private implementation receipts remain with the maintainer. See [sanitized evidence](docs/EVIDENCE.md); fresh buyer hosting and production gates remain open.
