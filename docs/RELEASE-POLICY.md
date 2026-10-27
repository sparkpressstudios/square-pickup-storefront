# Prerelease and update policy

The current packaging target is **`v0.1.0-rc.3`**, not 1.0 or live merchant certification. The clean distribution is licensed under MIT, copyright 2026 SparkPress Studios; users may fork, modify, redistribute and sell it subject to the license terms. Original operational history stays private. This document does not itself publish a template, create Git branches, grant infrastructure access or enroll a customer's service in updates.

## Proposed channels — not configured infrastructure

- **Development:** future ongoing changes and experiments, isolated from buyer deployments. A suggested `develop` branch is a plan only; do not assume it exists or that any service tracks it.
- **Stable/candidate distribution:** reviewed immutable version/commit, release notes, required checks and a declared schema/configuration matrix. `v0.1.0-rc.3` remains a candidate until its outstanding buyer/production gates are satisfied. A suggested `stable` branch is a plan only, not evidence of a configured release channel.
- Record each buyer's adopted base commit, custom patch and deployed artifact. Pin an approved version/commit for cutover; a moving branch name alone is not an acceptance receipt. Do not retarget an existing service's repository or branch without its applicable authorization.

Railway documents root-branch update notifications and a user update action in [Template Updates](https://docs.railway.com/templates/updates). Under this policy, a notification is an invitation to review/adopt changes, not permission to force-update a customer. [GitHub-connected deployment triggers](https://docs.railway.com/deployments/github-autodeploys) are a separate configuration/access relationship: changing the branch a buyer's service actually tracks can deploy code independently of a template notification. Review effective source/autodeploy settings before any repository push under a maintenance grant. Do not promise push-once fleet upgrades or automatic merges for ejected/customized forks; that upgrade path still needs a pilot.

Use explicit effective Railway service settings from the [buyer guide](BUYER-RAILWAY-INSTALL.md), not an assumption that legacy `railway.json` controls a new installation. The public legacy file has build settings only so it cannot override the selected setup/merchant deployment profile. This source-only change does not itself mutate hosted settings; deploying it can change effective legacy configuration. The separate private synthetic pilot is unchanged. Owners of older public releases must explicitly review their effective start/health/restart settings before upgrading.

## Customer adoption versus a maintenance grant

**Default: customer opt-in per release.** Give the owner the changelog, exact commit, migration/configuration changes, known limitations, restore evidence and proposed timing. The owner or authorized operator accepts the target-specific update before execution. A notification, purchase, support conversation or repository access is not by itself permission to migrate or restart a service.

**Optional paid maintenance:** a separately agreed standing grant may authorize defined routine updates without asking for every release. Record the covered merchant/project/environment/services, permitted release channel/types, change window, spending limit, required checks, backup/recovery responsibility, incident contact, duration and revocation method. This policy creates no such grant and promises no price, SLA or support term.

Even with maintenance, do not assume authority for new infrastructure, credential/account changes, payment activation, sending customer email, domain/DNS changes, public distribution or destructive data changes outside the grant. Ambiguous or conflicting scope stops the dependent action. Preserve original order/refund/mail identities during recovery; a maintenance fee is not permission to erase uncertain liabilities.

## Candidate promotion and upgrade evidence

Before a new candidate or stable release, require the normal release checks, focused security review, declared base/optional schema compatibility, restart/unknown-outcome tests and upgrade/restore rehearsal. For a customized buyer fork, additionally inspect the customization diff, test the merged application and validate the actual target's settings before rollout. No background updater or recurring migration hook is supplied.

Outstanding readiness categories must remain visible: fresh buyer Railway install, real-device coverage, actual buyer branding/policies/stock, buyer-owned account/security setup, production-payment acceptance and any optional email sender/delivery verification. Existing-host sandbox payment/refund evidence and local restore tests are useful but do not close all those categories. Follow [UPGRADES.md](UPGRADES.md) and the [handoff checklist](MERCHANT-HANDOFF.md).

MIT code rights are independent of optional paid setup, support or maintenance. Those services need separately agreed terms; no price, SLA or maintenance entitlement is included. Public distribution has been approved, but this candidate document does not claim the repository or Railway listing is already published.


## Read-only administrator release notices

The authenticated administrator Updates screen checks the fixed public `releases/latest.json` manifest only when opened. Storefront requests do not check it. The server coalesces concurrent checks, caches successful responses for 24 hours, retries failures no more than hourly, limits payloads to 8 KB, rejects redirects and times out after four seconds. There is no background poller or database storage. A restart resets this process-local cache. The release host receives an ordinary server request without merchant credentials or customer data.

Release maintainers publish validated text fields: `version`, `releasedAt`, `summary`, `securityNotes`, `migrationNotes`, and `acceptanceNotes`. Update the package version and manifest together for a newly versioned release; use honest prerelease identifiers and dated release notes. The manifest records the versioned candidate packaging timestamp, not proof of production acceptance. A tested full commit identifies each candidate; a Git tag is optional and must point to that same reviewed commit if created. Notes are text, not executable content, and upgrade links are fixed official documentation URLs.

Customers choose adoption. No database, environment settings, source fork, deployment or payment is changed by the notice. Essential security information and this notice remain free with the MIT core. This screen does not implement paid access or promise automatic preservation of arbitrary custom source changes.
