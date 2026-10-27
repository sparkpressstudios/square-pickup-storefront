# Security reporting and updates

## Report privately

The owner has approved the following address for public vulnerability reporting.

Send a suspected vulnerability privately to **adamb@sparkpressstudios.com**, the verified project owner's existing mailbox. Do not post exploit details in public issues. This is an owner contact, not a dedicated security team or a guaranteed response-time commitment.

Include the affected release/commit, a concise description, impact, and safe reproduction steps using synthetic data. Never send passwords, API tokens, session cookies, customer information, database dumps, or private order-access links. Do not test against someone else's store without authorization.

## Current support boundary

`0.1.0-rc.3` is an MIT-licensed public-distribution release candidate, not production certification. No production-support SLA, security-fix deadline or long-term-support window is promised. Earlier development commits are not separately supported release lines.

For a confirmed issue, the maintainer should assess severity, prepare a tested correction, document affected/fixed versions and upgrade/rollback requirements, and notify authorized installation contacts through an agreed private channel. Publish sensitive exploit details only after considering customer exposure and remediation. A reporting email does not authorize access to a reporter's infrastructure.

## How updates reach installations

Free template users choose and apply compatible releases. Paid maintenance may include testing and deployment only under that merchant's explicit scoped access and service agreement. There is no fleet controller, automatic access grant or forced remote update mechanism in this template.

Template update notifications and GitHub-linked auto-deployment are different mechanisms. Do not attach customer production stores to an unrestricted development branch. A security patch still needs compatibility checks; migrations and rollback cannot undo external Square or email effects. Follow [UPGRADES.md](docs/UPGRADES.md).
