# linux.com address lookup

A small internal web app with one text box. Enter `username` (or `username@linux.com`) and it shows whether that address exists as:

- an explicit **ForwardEmail** alias on `linux.com`, with its enabled state, forwarding recipients, labels and description
- a **Google Workspace** user, user alias, group, or group alias, with its primary address, name, and suspended state

It runs as a single Cloudflare Worker that serves both the static page and the `/api/*` endpoints. **Cloudflare Access with Okta** protects it, and GitHub Actions deploys it.

```
Browser ──► Cloudflare Access (Okta SSO) ──► Worker (custom hostname)
                                             ├─ /             static SPA (public/)
                                             ├─ /api/me       signed-in user
                                             └─ /api/lookup?user=NAME
                                                  ├─ ForwardEmail  GET /v1/domains/linux.com/aliases/NAME
                                                  └─ Google Admin SDK  users.get → groups.get
```

The Worker verifies the Access JWT on every API request (signature, issuer and audience), so it never relies on edge configuration alone. `workers.dev` and preview URLs are disabled, which means the Access-protected hostname is the only way in.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Router and `/api/lookup` handler (both sources run in parallel; one failing does not hide the other) |
| `src/access.ts` | Cloudflare Access JWT verification |
| `src/forwardemail.ts` | ForwardEmail alias lookup |
| `src/google.ts` | Service-account token (domain-wide delegation) and Directory API lookup |
| `src/validate.ts` | Input normalization and allow-list |
| `public/` | Static page (plain HTML/CSS/JS; no build step) plus `_headers` for CSP |
| `test/` | Vitest suite (Node, with outbound `fetch` stubbed) |
| `.github/workflows/` | `ci.yml` (PRs) and `deploy.yml` (push to `main`) |

## One-time setup

### 1. Cloudflare API token and GitHub secrets

Create a Cloudflare API token with these permissions:
- **Account** → Workers Scripts: Edit
- **Zone** (the zone that holds the hostname) → Workers Routes: Edit, DNS: Edit

In the GitHub repo, create an environment named **`production`** (you can add required reviewers if you want them). All deployment config lives in its secrets; nothing environment-specific is committed:

| Secret | Value | Used for |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token above | deploying |
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account ID | deploying |
| `WORKER_HOSTNAME` | bare hostname, e.g. `linuxcom-lookup.example.org` (on a zone in this account; Wrangler creates the DNS record) | `wrangler deploy --domain` |
| `ACCESS_TEAM_DOMAIN` | e.g. `yourteam.cloudflareaccess.com` (step 2) | Worker secret |
| `ACCESS_AUD` | Access application AUD tag (step 2) | Worker secret |
| `GOOGLE_ADMIN_SUBJECT` | account to impersonate, e.g. `directory-reader@linuxfoundation.org` (step 3) | Worker secret |
| `GOOGLE_SA_KEY_JSON` | full service-account JSON key (step 3) | Worker secret |
| `FORWARDEMAIL_API_TOKEN` | ForwardEmail API token (step 4) | Worker secret |

The deploy job fails early if any of these are missing. Every deploy pushes the five Worker secrets with `wrangler secret bulk`, so to change a value, update the GitHub secret and re-run **Deploy** (it has a manual `workflow_dispatch` trigger). If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is ever empty, the Worker fails closed and every API call returns 401.

### 2. Okta as the login method for Cloudflare Access

1. In **Okta**, create an **OIDC → Web Application** for Cloudflare Access:
   - Sign-in redirect URI: `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback`
   - Assign the people or group who should use the tool.
   - If you want group-based Access policies, add a `groups` claim to the ID token.
2. In **Cloudflare Zero Trust → Settings → Authentication → Login methods**, add **Okta** with the app's client ID, client secret and Okta URL.
3. In **Zero Trust → Access → Applications**, add a **Self-hosted** application:
   - Domain: the same hostname as the `WORKER_HOSTNAME` secret
   - Identity providers: Okta only (turn on instant auth)
   - Policy: **Allow** → *Okta groups* includes your chosen group (or specific emails)
4. Save the application's **Audience (AUD) tag** as the `ACCESS_AUD` secret and your team domain as `ACCESS_TEAM_DOMAIN`.

### 3. Google Workspace service account (read-only)

1. In a GCP project, enable the **Admin SDK API** and the **Cloud Identity** API (`cloudidentity.googleapis.com`).
2. Create a **service account** and a **JSON key**, and save the key as the `GOOGLE_SA_KEY_JSON` secret. No GCP IAM roles are needed.
3. In **Workspace Admin → Security → Access and data control → API controls → Domain-wide delegation**, add the service account's **client ID** with exactly these scopes:
   ```
   https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/cloud-identity.userinvitations.readonly
   ```
   The third scope is optional. It lets the app confirm that an address Google won't describe belongs to an **unmanaged personal account**. It uses its own token, so if it's missing only that check is skipped, and the skip shows in the card's **Why?** section as a `cloudidentity.token` 401 `unauthorized_client`.
4. Choose the account the service account will impersonate and save it as the `GOOGLE_ADMIN_SUBJECT` secret. Best practice is a dedicated account that holds only a **custom admin role** with *Users → Read* and *Groups → Read*.

Google lookups only match `@linux.com` addresses if `linux.com` is a primary, secondary or alias domain in the tenant. Aliases that come from a domain alias show up as `nonEditableAliases` and are reported as "Alias of a user". If you want to query a different domain, change `GOOGLE_LOOKUP_DOMAIN`.

### 4. ForwardEmail API token

Under **My Account → Security** in ForwardEmail, create an API token for an account that can see the `linux.com` domain. Save it as the `FORWARDEMAIL_API_TOKEN` secret.

### 5. Deploy

Once all eight secrets are set, merge to `main` (or run **Deploy** manually). The workflow runs the tests, uploads the Worker secrets, then deploys to `WORKER_HOSTNAME`.

`wrangler.jsonc` only holds the non-sensitive defaults `FE_DOMAIN` and `GOOGLE_LOOKUP_DOMAIN` (both `linux.com`).

## Local development

```bash
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars   # fill in FORWARDEMAIL_API_TOKEN / GOOGLE_SA_KEY_JSON
npm run dev                      # http://localhost:8787 (keeps the real localhost origin)
```

`DEV_BYPASS_ACCESS=1` in `.dev.vars` skips the Access check, but **only** for requests to `localhost` or `127.0.0.1`. Never set it as a deployed secret.

```bash
npm run typecheck
npm test               # unit tests + fast-check fuzzing (test/fuzz.test.ts)
npm run lint:lockfile
```

## Supply-chain security

Dependency and CI rules are in [AGENTS.md](AGENTS.md), which follows [package-manager-hardening](https://github.com/jordanconway/package-manager-hardening). How to report a vulnerability is in [SECURITY.md](SECURITY.md). In short:

- **Dependencies:** exact pins, committed lockfile, `npm ci --ignore-scripts`, lockfile-lint, `npm audit signatures`, `npm audit`.
- **Updates:** a 7-day Dependabot cooldown.
- **Workflows:** SHA-pinned actions with Harden-Runner, zizmor (auditor persona) and dependency review on PRs.
- **Code scanning:** CodeQL default setup.

## Org sweep

The **Org sweep** page (`#/sweep`, API `GET /api/sweep`) lists every **active** Google Workspace account (not suspended or archived) that has an `@linuxfoundation.org` address, primary or alias, whose local part also exists as an explicit ForwardEmail `@linux.com` alias. For example, `jane@linuxfoundation.org` on Jane's account and a ForwardEmail alias `jane@linux.com`.

- **What's compared:** only `@linuxfoundation.org` addresses (`SWEEP_GOOGLE_DOMAIN` in `wrangler.jsonc`). Aliases on other domains are ignored, although they count when deciding whether the ForwardEmail alias forwards to the same person.
- **Each row shows** the Google account, the matching address (primary or alias), the linux.com alias and whether it's enabled, its recipients, and whether it forwards to one of that user's own addresses. "No — elsewhere" is the case worth reviewing.
- **Download:** "Download CSV" saves the full report. Cells that start with `=`, `+`, `-`, `@`, a tab or a line break (or the full-width `＝＋－＠`) are prefixed with `'` so spreadsheets don't run them as formulas.
- **How it works:** it reads the whole Google user list (500 per page) and the whole ForwardEmail alias list once, then joins them in memory, so a run takes a handful of API calls rather than one per address. Catch-all (`*`) and regex aliases can't be matched by name; the report says how many were skipped.
- **Permissions:** no new ones. It uses the existing `admin.directory.user.readonly` delegation and the ForwardEmail token. Each run logs a `sweep` event with the actor and counts (no addresses) to Workers Logs.

## Behavior notes

- Input is lowercased, has any `@linux.com` suffix removed, and must match `[a-z0-9._+-]`, starting and ending with a letter or digit (at most 64 characters). Anything else is rejected before any upstream call.
- ForwardEmail matching is **exact**. Catch-all (`*`) and regex aliases are not evaluated, so "Not found" means there is no explicit alias with that name.
- Each lookup writes `{actor, query, forwardemail, google}` to Workers Logs (observability is enabled) as an audit trail. Recipients and secrets are never logged.
- Upstream errors appear on that source's card. The Google 403 and token-exchange messages include the OAuth error code to help diagnose delegation setup.
- **Google 403 for a single address.** Google returns 403 (not 404) when an address belongs to a Google account outside this Workspace. The app then checks groups, then whether the admin subject can read its own record. If it can, the card shows **Not in Workspace**, never a conflict. With the Cloud Identity scope, it also says whether the address is an **unmanaged personal account** (`isInvitableUser`) or something else. If the admin subject can't read its own record either, it's a setup problem and is shown as an error.
- Any lookup with a non-200/404 Google call returns a `googleTrace` (shown under **Why?**) and logs a `google_trace` event with each call's step, HTTP status, timing and Google's full error response. Tokens are never logged.

## License

[MIT](LICENSE) © The Linux Foundation. The bundled Inter font in `public/fonts/` is under the SIL Open Font License 1.1 ([public/fonts/Inter-LICENSE.txt](public/fonts/Inter-LICENSE.txt)).
