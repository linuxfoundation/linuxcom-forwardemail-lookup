<!--
SPDX-FileCopyrightText: 2026 The Linux Foundation

SPDX-License-Identifier: MIT

Adapted from agents/AGENTS-nodejs.md and agents/AGENTS-github-actions.md in
https://github.com/jordanconway/package-manager-hardening (MIT).
-->

# Agent instructions

Standing rules for AI coding agents (and humans) changing dependencies or CI
in this repository. The two sections below are mandatory.

## How this repository applies them

- **Package manager:** npm. Every dependency is pinned to an exact version;
  `.npmrc` sets `save-exact=true`.
- **Release-age cooldown:** enforced by the Dependabot `npm` and
  `github-actions` cooldowns in `.github/dependabot.yml`, *not* by
  `min-release-age` in `.npmrc` (which would also block Dependabot security
  updates). Every update type waits at least 7 days (patch included; the
  `semver-patch-days: 3` in the generic example below is overridden to 7
  here). Agents still must not add a version published in the last 7 days.
- **CI installs:** always `npm ci --ignore-scripts`, followed by
  `npm run lint:lockfile`, `npm audit signatures` and
  `npm audit --audit-level=moderate`.
- **CI tooling outside npm:** zizmor is declared in `tools/pyproject.toml`,
  hash-locked in `tools/uv.lock`, installed with `uv sync --frozen` and kept
  current by Dependabot's `uv` ecosystem. Never install tools inline
  (`uvx tool==x`, `pip install`, `npx --yes`).
- **Fuzzing:** fast-check property tests in `test/fuzz.test.ts` cover the
  untrusted-input surface (`normalizeLocalPart` and `/api/lookup`).
- **CodeQL:** runs via GitHub's CodeQL *default setup* (actions +
  JavaScript/TypeScript, weekly), not a `codeql.yml` workflow; adding one
  would conflict with default setup.
- **Harden-Runner:** first step of every job, currently `egress-policy: audit`.
  Runtime monitoring needs a StepSecurity plan while the repository is
  private. Tighten to `block` using the `allowed-endpoints` already listed once
  audit logs confirm them.
- **Secrets:** deploy secrets are passed to individual steps only, never at
  job level, and the `production` environment only deploys from `main`.

## Node.js dependency management

This file contains mandatory guidelines for managing dependencies in this Node.js project. Follow these rules whenever adding, updating, or removing packages, or modifying CI configuration.

### Hash Verification: Never Fabricate

**AI agents must never invent, guess, autocomplete, or extrapolate an SRI `integrity` value (`sha512-...`), a tarball checksum, or any other cryptographic hash** in `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, or `.npmrc`. A fabricated integrity hash either fails verification or silently pins to the wrong tarball.

All lockfile integrity hashes must be produced by the package manager itself — run `npm install`, `pnpm install`, `yarn install`, or `bun install` and commit the resulting lockfile. Do not hand-edit `integrity:` fields.

To confirm a published tarball's integrity (e.g. when reviewing a Dependabot PR):

**Preferred:** if the `harden-packages` skill is available, use its helper:

```bash
python {SKILL_DIR}/verify_hash.py npm <package> <version>    # → sha512-... SRI integrity
```

**Fallback:** `npm view <pkg>@<version> dist.integrity dist.tarball dist.shasum`.

If you cannot verify a hash with any of the above, **stop and ask the user**. Do not insert a placeholder or a "likely correct" value.

### Package Names: Never Guess

**AI agents must never add a dependency whose exact name they have not verified against the registry in the current session.** Typosquatting and slopsquatting — attackers registering names that language models tend to invent — are actively exploited vectors. A guessed name either fails to resolve or resolves to a malicious look-alike.

Before adding any new package:

1. Verify the exact name on the registry and confirm it is the package you intend: `npm view <package> name description repository.url time` — the description and linked repository must match the stated purpose.
2. Treat as red flags: a very recent first publish date, a name one or two characters off a popular package, a missing or unrelated repository link, and low download counts for a supposedly well-known package.

If the lookup is ambiguous or the package cannot be confidently identified, **stop and ask the user** — do not choose between similar names on intuition.

### Package Manager

This project uses: **npm** (`package-lock.json`).

### Dependency Rules

**Always pin exact versions.** Never use `^` or `~` prefixes in `package.json`. Every dependency and devDependency must specify an exact version string.

```json
// correct
"express": "4.18.2"

// incorrect — do not use
"express": "^4.18.2"
"express": "~4.18.2"
```

**Never add a package that was published within the last 7 days.** Check the publication date on the registry before adding any new dependency. If a package was published less than 7 days ago, defer the addition until the cooldown has elapsed.

**Always commit the lockfile.** `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, or `bun.lock` must be committed. Never add lockfiles to `.gitignore`.

**Never run install commands that bypass the lockfile in CI.** Use the strict install command for this project's package manager:

- npm: `npm ci`

### Configuration to Verify

When modifying dependency configuration, verify the following are in place:

**For npm** (`.npmrc`):

```ini
save-exact=true
audit=true
fund=false
```

### Security Audit

Run a vulnerability audit whenever dependencies change:

```bash
npm audit --audit-level=moderate

# npm: also verify registry signatures + provenance attestations for the
# full tree (catches tampered artifacts that hash verification cannot)
npm audit signatures
```

If the audit reports vulnerabilities, do not merge the change until they are resolved or explicitly acknowledged with a documented justification.

### CI Configuration

#### Dependabot

`.github/dependabot.yml` must include a cooldown for this ecosystem. If the file does not exist or lacks a cooldown block, add it:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "daily"
    cooldown:
      default-days: 7
      semver-major-days: 30
      semver-minor-days: 7
      semver-patch-days: 3
```

Security update PRs from Dependabot bypass the cooldown automatically and should be reviewed and merged promptly.

#### Harden-Runner

Every GitHub Actions workflow that installs dependencies must include `step-security/harden-runner` as its first step. New workflows must not be added without it.

Start in `audit` mode for new workflows, then tighten to `block` once the egress policy is stable:

```yaml
- uses: step-security/harden-runner@6c3c2f2c1c457b00c10c4848d6f5491db3b629df # v2
  with:
    egress-policy: block
    disable-sudo: true
    allowed-endpoints: >
      api.github.com:443
      github.com:443
      objects.githubusercontent.com:443
      registry.npmjs.org:443
```

Add `npm.pkg.github.com:443` to `allowed-endpoints` if this project uses GitHub Packages.

#### Lockfile linting

CI must validate the lockfile's resolved URLs — a tampered `resolved` field installs an
attacker's artifact while hash verification and `npm ci` both pass:

```bash
npm run lint:lockfile   # lockfile-lint, pinned in devDependencies
```

Add each private registry hostname to `--allowed-hosts` if applicable. Never edit `resolved`
or `integrity` fields by hand.

### What Requires Human Review

The following changes must not be made autonomously and require explicit human approval before proceeding:

- Adding a new dependency with no prior version in the lockfile
- Upgrading a major version (`x.0.0` → `y.0.0`)
- Removing `--ignore-scripts` from any `npm ci` in CI
- Modifying `.github/dependabot.yml` cooldown values downward
- Removing or modifying Harden-Runner from a workflow

## GitHub Actions security

This file contains mandatory guidelines for working with GitHub Actions workflows in this repository. Follow these rules whenever adding, modifying, or reviewing files under `.github/workflows/`.

### Hash Verification: Never Fabricate

**AI agents must never invent, guess, autocomplete, or extrapolate a commit SHA, image digest, or any other cryptographic hash.** A fabricated SHA either fails verification (breaks the build) or — worse — silently pins to whatever artifact happens to collide with the guessed value. Treat any hash you did not just look up as unknown.

Every action SHA, runner image digest, or tool integrity hash written into a workflow must come from an authoritative lookup performed in this session.

**Preferred:** if the `harden-packages` skill is available, use its helper instead of hand-rolling `curl`/`gh` invocations:

```bash
python {SKILL_DIR}/verify_hash.py gh-action <owner>/<repo> <tag-or-ref>   # → full commit SHA
python {SKILL_DIR}/verify_hash.py oci <image>:<tag>                       # → sha256: digest
```

**Fallback if the helper isn't present:** `gh api repos/<owner>/<repo>/commits/<ref> --jq .sha` or `git ls-remote https://github.com/<owner>/<repo>.git 'refs/tags/<tag>^{}'`.

For tool hashes inside workflows, generate them with the ecosystem's own tooling (`npm ci` against a committed `package-lock.json`, `pip-compile --generate-hashes`, etc.) — never hand-edit `integrity:` or `--hash=` values.

If you cannot verify a hash with any of the above, **stop and ask the user**. Do not insert a placeholder, a truncated SHA, or a "likely correct" value.

### Action Names: Never Guess

**AI agents must never add a `uses:` reference whose exact `owner/repo` they have not verified on GitHub in the current session.** A guessed action name either fails to resolve or resolves to a look-alike under a squatted account (`action/checkout` vs `actions/checkout` is the canonical example).

Before adding any new action:

1. Verify the exact `owner/repo` exists and is the action you intend: `gh repo view <owner>/<repo>` — confirm the README, publisher, and Marketplace listing (verified-creator badge where available) match the stated purpose.
2. Treat as red flags: an owner name one or two characters off a well-known one (`actions`, `docker`, `aws-actions`), a recently created repository with few stars presenting itself as a well-known action, and forks referenced in place of the canonical repository.

If the lookup is ambiguous or the action cannot be confidently identified, **stop and ask the user** — do not choose between similar names on intuition. Then SHA-pin the verified action per the hash rules above.

### Checkout: disable credential persistence

Every `actions/checkout` invocation must set `persist-credentials: false` unless the job genuinely needs to push back to the repo (release tagging, automated commits). The default leaves `GITHUB_TOKEN` in `.git/config` for the rest of the job, where any subsequent step — including a compromised dependency build — can use it.

```yaml
- uses: actions/checkout@<sha> # v4
  with:
    persist-credentials: false
```

If a job needs to push, override only in that job and document why in a YAML comment.

### Workflow concurrency

Every workflow must declare a top-level `concurrency:` block. For CI workflows (lint/test/build), cancel superseded runs:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

For release / deploy workflows where in-flight runs should complete, keep the `group:` but set `cancel-in-progress: false`.

### Static analysis: CodeQL (SAST)

Every repository must run CodeQL on every push, every PR to the default branch, and on a weekly schedule. SAST is a Scorecard requirement and CodeQL is the canonical implementation for GitHub.

- Use a separate workflow file: `.github/workflows/codeql.yml`. Do not bundle into `ci.yml`.
- Enable at minimum the `actions` language plus the primary application language(s). `actions` complements zizmor by catching workflow vulnerabilities CodeQL surfaces differently.
- Use `queries: security-extended` for security-focused repos. Do not use `security-and-quality` (noisier code-quality findings dilute the signal).
- `egress-policy` must be `audit`, not `block` — CodeQL fetches query packs from `objects.githubusercontent.com` and submits results back to the API. A fixed allowlist is impractical.
- `permissions: security-events: write` is required to upload SARIF; do not omit.
- Do not delete the workflow, narrow the language matrix, or downgrade `security-extended` to `security-and-quality` without explicit human approval.

### Fuzzing

Every repository with parser-style code (anything that consumes external file content, network input, or user-controlled strings) must have a fuzzing integration recognised by [OpenSSF Scorecard's `Fuzzing` check](https://github.com/ossf/scorecard/blob/main/docs/checks.md#fuzzing). The detection is narrow and language-specific. **Hypothesis is not recognised for Python** — do not add only Hypothesis and assume the check is satisfied.

Minimum viable per language:

- **Python** — `import atheris` in a `fuzz/` harness, hash-pinned in `fuzz/requirements.txt`. Atheris is coverage-guided libFuzzer; ships wheels for Linux x86_64 only, and only for the CPython ABI versions each release builds (3.1.0 is `cp312`–`cp314`, with no sdist fallback), so pin the workflow's `python-version` to match the pinned atheris and re-check on every bump. Run on a scheduled workflow (weekly), not per-PR (too slow). Keep Hypothesis property tests in `tests/test_fuzz.py` alongside — different bug class, fast enough for PRs.
- **Go** — `func FuzzXxx(f *testing.F)` targets; run as part of CI.
- **Rust** — `cargo-fuzz` targets under `fuzz/`.
- **C / C++** — `LLVMFuzzerTestOneInput` harnesses, integrated via ClusterFuzzLite (`.clusterfuzzlite/Dockerfile`) or OSS-Fuzz.
- **Cross-language** — ClusterFuzzLite is the most flexible answer; OSS-Fuzz is the most thorough; both are recognised regardless of language.

The contract under test is usually "parser must not crash on arbitrary input." Property tests are not full fuzzing campaigns but they catch ReDoS, encoding edge cases, and crash-on-empty-input bugs that unit tests miss.

Do not remove the fuzzing target / dev-dep / test file without explicit human approval.

### Static analysis: zizmor

Every repository must run [`zizmor`](https://docs.zizmor.sh) against `.github/workflows/` in CI as a required status check. zizmor catches the controls in this file plus many others (template injection, mutable reusable-workflow refs, dangerous triggers, secrets exposed to forks, etc.) and is the canonical static analyser for this domain.

Minimum gate: `--min-severity=medium` on the default persona. Stricter gate (preferred for security-sensitive repos): `--persona=auditor --min-severity=low`.

New or modified workflows must pass `uvx zizmor --persona=auditor .` locally before being committed. New zizmor findings must not be merged — either fix the underlying issue or, if it is a confirmed false positive, suppress it explicitly with a `# zizmor: ignore[<rule>]` comment plus a justification in the PR description.

Do not downgrade the `--min-severity` threshold or remove the zizmor job from CI without explicit human approval.

### Pin runner images

`runs-on: ubuntu-latest` is mutable and changes underneath you. Always pin to a specific image (`ubuntu-24.04`, `ubuntu-22.04`, `windows-2022`, `macos-14`). Bump explicitly when you've validated the new image. Dependabot does not propose runner-image bumps; track these manually.

### Block vulnerable / disallowed dependencies on PRs

Every repository must run `actions/dependency-review-action` as a PR-only required status check. It compares head against base and fails on:

- Vulnerabilities at or above `fail-on-severity: high` (or stricter)
- Licenses on the `deny-licenses` list (project-specific)
- Packages on the `deny-packages` list, if any

Do not lower `fail-on-severity` below `high` without explicit human approval. Do not delete the job or remove its required-check status without explicit human approval.

The action requires Dependabot security updates to be enabled on the repo (Settings → Code security, or `gh api -X PATCH repos/<owner>/<repo> -f 'security_and_analysis[dependabot_security_updates][status]=enabled'`). Without it, every run fails with `Dependency review is not supported on this repository`. When adding the job to a repo that doesn't already have it enabled, enable the setting in the same change.

### OpenSSF Scorecard

Every repository must publish an OpenSSF Scorecard score via `ossf/scorecard-action`, run on a weekly schedule and on push to `main`. SARIF results upload to the Security tab; results publish to the OpenSSF API so the README badge resolves.

The Scorecard workflow uses `egress-policy: audit`, not `block` — the analyser legitimately contacts dozens of ecosystem endpoints. Do not change to `block`.

The `ossf/scorecard-action` step **must** receive `repo_token: ${{ secrets.SCORECARD_TOKEN }}` if the repository has any branch protection configured. The default `GITHUB_TOKEN` cannot read the classic branch-protection API and the entire run will fail with `some github tokens can't read classic branch protection rules`. The token must be a fine-grained PAT scoped **only** to `Administration: Read-only` on the target repo — never a classic PAT, never broader scopes, never named `GITHUB_TOKEN` (reserved). When recommending the Scorecard workflow, include the secret-creation step in the same instruction.

A dropping Scorecard score is a regression that must be triaged like any other CI failure. Common causes: a new unpinned action, a removed branch protection rule, a permission grant added without justification.

### Vulnerability disclosure: SECURITY.md

Every repository must have a root `SECURITY.md` linking to GitHub's private vulnerability reporting (`https://github.com/<owner>/<repo>/security/advisories/new`), with explicit "do not file public issues" wording, expected response SLOs, and scope. Private vulnerability reporting must be enabled in repo Settings → Code security → "Privately report a vulnerability".

### Action Version Pinning

**Always pin actions to their full commit SHA**, not to a version tag. Include the human-readable tag as a comment on the same line:

```yaml
# Correct
- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4

# Incorrect — tag can be silently moved
- uses: actions/checkout@v4
```

To resolve the commit SHA for a tag:

```bash
git ls-remote https://github.com/<owner>/<action>.git refs/tags/<tag> 'refs/tags/<tag>^{}'
# Use the ^{} line (dereferenced SHA) for annotated tags
```

**Never add a new action that was published within the last 7 days.** Check the release date before adding any new action to a workflow.

### Workflow Permissions

Every workflow must declare `permissions:` at the workflow level with `contents: read` as the baseline. Grant elevated permissions at the job level only where explicitly required:

```yaml
# Workflow-level baseline
permissions:
  contents: read

jobs:
  deploy:
    permissions:
      contents: write   # only if this job pushes commits or creates releases
      id-token: write   # only if this job uses OIDC to authenticate to a cloud provider
```

Never leave `permissions:` undeclared — this relies on organisation defaults which vary.

### Harden-Runner

Every job that installs dependencies or runs build steps must include `step-security/harden-runner` as its **first step**:

```yaml
steps:
  - uses: step-security/harden-runner@<sha> # v2
    with:
      egress-policy: block
      disable-sudo: true
      allowed-endpoints: >
        api.github.com:443
        github.com:443
        objects.githubusercontent.com:443
```

Add ecosystem-specific endpoints as needed (e.g. `pypi.org:443 files.pythonhosted.org:443` for Python jobs, `registry.npmjs.org:443` for Node.js jobs).

For any action that downloads a binary from a GitHub release (e.g. `astral-sh/setup-uv`, `opentofu/setup-opentofu`), also allow `release-assets.githubusercontent.com:443` — modern GitHub release downloads redirect through that host. The older `github-production-release-asset-2e65be.s3.amazonaws.com` is deprecated and will fail with `ECONNREFUSED` in `block` mode.

Some actions also fetch a runtime version manifest from `raw.githubusercontent.com`. Notable case: `astral-sh/setup-uv` **v8+** reads `https://raw.githubusercontent.com/astral-sh/versions/main/v1/uv.ndjson` on every run; v6.x did not. A Dependabot bump that crosses this boundary will fail in `block` mode until `raw.githubusercontent.com:443` is added. Always re-validate the allowlist when an action crosses a major version.

**Exception:** jobs that fetch arbitrary external URLs (link checkers, scanners) must use `egress-policy: audit` since a fixed allowlist cannot be constructed. Add a comment explaining why.

Start new jobs in `audit` mode and tighten to `block` once the allowlist is confirmed from the audit logs.

### Tool Version Pinning

All tools installed in workflow steps must be hash-verified from a committed lockfile, not just version-pinned inline. This is what OpenSSF Scorecard's `Pinned-Dependencies` check requires.

- **Python**: `uv sync --frozen --group dev` from `uv.lock`. Tools declared in `pyproject.toml [dependency-groups].dev` so Dependabot's `uv` ecosystem keeps them current. Inline `pip install ruff==0.11.2` is acceptable only as a short-term transitional measure with a tracked follow-up; the lockfile form is required for new repos.
- **npm**: `npm ci --ignore-scripts` from committed `package.json` + `package-lock.json`. Tools declared in `devDependencies` at exact versions so Dependabot's `npm` ecosystem keeps them current. Inline `npm install pkg@ver` is **not sufficient** for `Pinned-Dependencies` — it pins the direct version but not the integrity hash, and does not pin transitive deps. `--ignore-scripts` is mandatory: it blocks `preinstall` / `postinstall` hooks that are a primary supply-chain attack vector.
- **`npx --yes <pkg>` is forbidden**: it fetches and runs whatever is currently published under that name, with no version or hash check at all.

```yaml
# Correct
- run: uv sync --frozen --group dev
- run: uv run ruff check .

- run: npm ci --ignore-scripts
- run: npx markdownlint-cli2 "**/*.md"

# Incorrect (silently rots; not hash-verified; invisible to Dependabot)
- run: pip install ruff
- run: pip install ruff==0.11.2
- run: npm install markdownlint-cli2@0.17.2
- run: npx --yes markdownlint-cli2
```

**Dependabot blind spot**: inline `pip install x==y` / `npm install x@y` lines in workflow files are pinned but **not parsed by Dependabot** — no ecosystem will open update PRs for them, and they silently rot. Always declare tools in a manifest Dependabot understands.

When adding npm tooling to a repo that doesn't yet have it:

1. Create a minimal `package.json` with `"private": true` and the tool in `devDependencies` at an exact version.
2. Generate `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
3. Add an `npm` ecosystem entry to `.github/dependabot.yml` with a cooldown.
4. Annotate `package.json` and `package-lock.json` in `REUSE.toml` (both lack a comment syntax for inline SPDX headers).
5. Use `npm ci --ignore-scripts` in the workflow step.

Do not use `npm install` (without `ci`) in CI — it can mutate the lockfile silently. Always `npm ci`.

### Expression Injection

Never interpolate untrusted context values directly into `run:` blocks. Pass them through environment variables:

```yaml
# Correct
- env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "$PR_TITLE"

# Incorrect — attacker-controlled input interpolated into shell
- run: echo "${{ github.event.pull_request.title }}"
```

Untrusted values include: `github.event.issue.title`, `github.head_ref`, `github.event.pull_request.body`, any `workflow_dispatch` input.

### `pull_request_target`

Do not use `pull_request_target` unless write access or secrets are explicitly required. If used, never check out or run code from the PR head branch in that context.

### What Requires Human Review

The following changes must not be made autonomously and require explicit human approval:

- Adding a new action not already present in an existing workflow
- Upgrading an action to a new major version
- Adding or modifying `secrets:` references
- Changing `egress-policy` from `block` to `audit`
- Adding `pull_request_target` triggers
- Granting any permission beyond `contents: read` at the workflow level
- Modifying the Dependabot configuration for the `github-actions` ecosystem
- Setting `persist-credentials: true` (or omitting it, which defaults to `true`) on `actions/checkout`
- Removing or weakening the workflow-level `concurrency:` block
- Removing the zizmor job, lowering its `--min-severity`, or suppressing a finding without a documented justification
- Removing the dependency-review job, lowering its `fail-on-severity`, or removing it from required status checks
- Removing the Scorecard workflow, or changing its `egress-policy` away from `audit`
- Removing the CodeQL workflow, narrowing its language matrix, or downgrading from `security-extended` to `security-and-quality`
- Removing the fuzzing integration (Atheris harness in `fuzz/` for Python; `func Fuzz*` for Go; `cargo-fuzz` for Rust; `LLVMFuzzerTestOneInput` for C/C++; ClusterFuzzLite for any), or removing the Hypothesis property suite that complements it
- Bumping a runner image (`ubuntu-24.04` → `ubuntu-26.04`, etc.) without confirming the matrix still passes
- Removing or weakening `SECURITY.md` or disabling private vulnerability reporting
- Dismissing a Scorecard / CodeQL finding without a documented justification in `SECURITY.md`
