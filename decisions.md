# Decisions

A running log of project decisions, so teammates and future sessions don't re-open settled questions.
Append new entries at the end of the relevant section; don't rewrite old ones. If a decision is reversed, add a new
entry that says which one it supersedes.

Each entry records the options that were considered, what was chosen, and the trade-off that was accepted.

---

## 2026-09-30 — Auth0 wiring round (after audit v0.3)

- **Base commit:** `4225f5c` — "feat: auth0 Configuration (not working)"
- **Input:** Repository audit v0.3. It found that the web host was built correctly, but the API never received its
  Auth0 settings, so every signed-in workspace request returned 401.
- **How decided:** every option below was chosen explicitly in a planning session; none were defaulted.

### D1 — Scope of this round
- **Options:**
  - Auth0 wiring fixes.
  - Dev-only demo mode.
  - P0 backend fixes (scenario 5 space match, relevance threshold).
  - Additional features (Slack → Jira card, Mark done, and others).
- **Chosen:** Auth0 wiring fixes only.
- **Trade-off:** the other three stay open (see *Deferred*). The workspace still needs a working Auth0 + Supabase
  setup to be used in a browser.

### D2 — State of the Auth0 tenant and Supabase directory
- **Options:** fully configured / partially configured / not sure.
- **Chosen:** not sure. The code must not assume dashboard state. Instead, `apps/web/AUTH0.md` carries a checklist
  to confirm the tenant against.

### D3 — How end-to-end sign-in is verified
- **Options:**
  - The user tests locally.
  - Test credentials are added as secrets on the cloud environment.
  - Skip the live check.
- **Chosen:** the user tests the real login locally.
- **Trade-off:** checks in the development sandbox are limited to typecheck, tests, the build and simulated runs,
  and no tenant secrets are shared there. The real login round-trip is confirmed only on a teammate's machine.

### D4 — Delivery
- **Options:** push the branch only / push and open a PR.
- **Chosen:** push the branch only, with no pull request.

### D5 — Where the API reads its settings
- **Options:**
  - A shared root `.env.local`, used by both the web host and the API.
  - A separate API file, e.g. `.env.api.local`.
- **Chosen:** the shared root `.env.local`.
- **Trade-off:** it's simpler and there's one place to edit. `AUTH0_AUDIENCE` and `AUTH0_ORG_ID` can't drift apart.
  In return, the API process also sees the web client secret, and the web host also sees the Supabase key. The old
  "web secrets are not forwarded to the API" statement was removed from `AUTH0.md`. Deployments should still give
  each process its own environment.

### D6 — Start scripts
- **Options:**
  - Keep `pnpm dev` demo-only and add a separate SSO script.
  - Make `pnpm dev` always load `.env.local`.
- **Chosen:** keep `pnpm dev` demo-only and add **`pnpm dev:sso`**.
- **Details:** `pnpm dev` still sets `ALLOW_DEMO_AUTH=true`, loads no file, and accepts `x-demo-user` for curl
  testing. `pnpm dev:sso` loads the root `.env.local` and runs the API in Auth0 mode.

### D7 — Extras included in this round
- **Options:**
  - A clearer workspace 401 message.
  - An API startup log line showing the auth mode.
  - Deriving `AUTH0_ISSUER` from `AUTH0_DOMAIN`.
  - A seed-script shortcut.
- **Chosen:** only the clearer 401 message.
- **Not chosen (for now):** the startup auth log, issuer-from-domain, and the seed-script shortcut.
  `AUTH0_ISSUER` must still be set explicitly, with its trailing slash.

### D8 — Where the setup checklist lives
- **Options:**
  - Rewrite `apps/web/AUTH0.md`.
  - A new `docs/auth0-troubleshooting.md`.
- **Chosen:** rewrite `apps/web/AUTH0.md`. It holds the setup steps, the dashboard and Supabase checklist, and a
  symptom → cause table.

### D9 — Decision log
- **Chosen:** keep this file, `decisions.md`, at the repository root, for teammates and future sessions.

### Implementation details (approved with the plan)
- `package.json`: `"dev:sso": "tsx --env-file=.env.local apps/api/src/server.ts"`. A missing file fails loudly.
- `.env.example` is split into a web section and an API section. It adds `AUTH0_ISSUER`, `SUPABASE_URL`,
  `SUPABASE_SECRET_KEY` and `AUDIT_SIGNING_KEY_FILE`. Comments sit on their own lines, because both `@next/env` and
  Node's `--env-file` parse the file.
- `.gitignore` adds `apps/web/next-env.d.ts` (Next.js regenerates it) and `*.pem` (for the audit signing key). The
  generated file is no longer tracked.
- The "Sign up" link is removed from `/`. A new sign-up has no workspace directory entry, so it can't use the
  workspace.
- Clearer 401 (`apps/web/app/api/brain/[...path]/route.ts` + `apps/web/app.js`):
  - With no web session, the proxy returns `code: "signed_out"` ("Your sign-in session has ended…"), and the
    workspace shows **Log in**.
  - When the API rejects a signed-in user's token, the proxy returns `code: "account_rejected"`, with one fixed
    message for every cause, so no configuration or directory details leak. The workspace shows **Log out**, so the
    person can switch to a provisioned account instead of looping through Log in.
- Finding while writing the docs: with a plain `APP_BASE_URL`, `@auth0/nextjs-auth0` 4.30.0 sends that value
  unchanged as the logout `returnTo` (`dist/utils/app-base-url.js`, `resolveAppBaseUrl`). **Allowed Logout URLs**
  must therefore contain `http://127.0.0.1:3001` with no trailing slash. The old docs listed only the trailing-slash
  form, which Auth0 rejects on logout.

---

## Deferred (not decided yet)
These are open. Pick them up in a later round and record the decision here.

- **Dev-only demo mode:** bring back the persona switcher behind a flag in the Next.js host (audit v0.3 §4).
- **Scenario 5 space match:** `apps/api/src/audit-search.ts` matches spaces by substring, so "payment-gateway"
  filters to `PAY`.
- **Relevance threshold:** unrelated accessible chunks pad answers. The intern and contractor should get the fixed
  "nothing found" reply.
- **Additional features:** Slack "ok" → Jira suggestion card; task → doc "Mark done"; latest-doc badge scoring;
  duplicate merge; intern catch-up; master page hard-coded to `PAY`.
- **Brain as an MCP server:** not started.
- **CodeBuddy/WorkBuddy evidence:** must be captured by someone using those products. The project isn't scored
  without it.
- **Directory caching:** `UserDirectory.bySub` re-reads the whole directory on every request, and every proxied
  workspace call now triggers it.
- **Ravi persona:** the README says "Head of payments", but the demo script has him as a junior engineer.
- The other P1 items are also still open: whole-brain JSONB snapshot writes, independent Merkle root anchoring,
  source-specific FGA types, and webhooks.
