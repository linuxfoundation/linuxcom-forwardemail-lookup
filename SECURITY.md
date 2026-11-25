# Security policy

This repository holds the internal linux.com address lookup tool (a
Cloudflare Worker behind Cloudflare Access / Okta that reads ForwardEmail and
Google Workspace).

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a
security problem.**

- Report it privately through GitHub's private vulnerability reporting:
  <https://github.com/linuxfoundation/linuxcom-forwardemail-lookup/security/advisories/new>
- While this repository is private (where that form is unavailable), contact
  the repository administrators directly and privately instead.

Include what you found, how to reproduce it, and the impact you expect.

### What to expect

| Step | Target |
| --- | --- |
| Acknowledge the report | 3 business days |
| Initial assessment | 7 days |
| Fix or mitigation for critical / high issues | 14 days |
| Fix for moderate / low issues | next scheduled release |

We'll keep you updated and credit you in the advisory unless you prefer not
to be named.

## Scope

In scope:

- The Worker code (`src/`), the static page (`public/`) and their
  configuration (`wrangler.jsonc`, `public/_headers`).
- The GitHub Actions workflows and dependency configuration in this
  repository.
- Handling of the credentials the app uses (Cloudflare Access JWT checks,
  the Google service-account delegation, the ForwardEmail token).

Out of scope (report to the vendor instead): Cloudflare, Okta, Google
Workspace and ForwardEmail themselves.

## Supply-chain controls

See [AGENTS.md](AGENTS.md) for the full rules. In short: exact-pinned npm
dependencies with a committed lockfile, `npm ci --ignore-scripts`,
lockfile-lint, `npm audit signatures`, a Dependabot cooldown, SHA-pinned
actions, zizmor, dependency review on pull requests, CodeQL, and fast-check
fuzzing of the input-handling code.

## Known trade-offs

- **Harden-Runner runs in `audit` mode.** Runtime egress monitoring requires
  a StepSecurity plan for private repositories; it becomes free if the
  repository is made public, at which point the policy should move to
  `block`.
- **Single-maintainer review.** Changes are usually merged by the maintainer
  without a second approver, so OpenSSF Scorecard's `Code-Review` check is
  expected to score low.
