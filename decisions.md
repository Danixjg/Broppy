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

### D10 — Branch for this work
- **Options:** `fix/auth0-wiring` / `feat/auth0-sso` / commit straight onto `main`.
- **Chosen:** `fix/auth0-wiring`, branched from `main` at `4225f5c`. It is not pushed yet; when to push is a separate
  decision.

### D11 — Local working notes stay out of git
- **Chosen:** `handoff.md` and `plans.md` are local notes for handing work over between sessions and teammates. Both
  are listed in `.gitignore` and are never committed.

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

## 2026-09-30 — Roadmap to the submission

- **Input:** the challenge brief and the `docs/` folder.
- **How decided:** every option below was chosen explicitly in a planning session; none were defaulted.

### D12 — Submission deadline
- **Chosen:** the final submission is on Fri 16 Oct 2026. Work is planned back from a freeze on Thu 15 Oct.

### D13 — What "the five scenarios" are
- **Options:** take them from the challenge brief / infer them from the five-stage plan.
- **Chosen:** the challenge brief's five scenarios. Each needs a worked example in the submission. The brief's example
  user `jdoe` maps to our fixture users.

### D14 — Order of work
- **Options for the first track:** scenario fixes / dev-only demo mode / docs and diagrams / additional features.
- **Chosen:** scenario fixes first: the relevance gate, the scenario 5 space match, and a document filter for audit
  queries. The order of the later rounds is a recommendation kept in the local plan (`plans.md`, never committed),
  and it can change.

### D15 — Delivery while repository access is being set up
- **Options:** push the current branch first, then branch per round / keep stacking commits locally.
- **Chosen:** keep stacking commits on `fix/auth0-wiring`, with a patch backup after each round. Nothing is pushed
  until the team says so.

### D16 — Deployment
- **Options:** repo plus a demo video / a running deployment / not sure yet.
- **Chosen:** repo plus a demo video. There is no deployment round.

### D17 — Hunyuan for the demo
- **Options:** keys available / stay deterministic / not sure yet.
- **Chosen:** not decided yet. Decide by Tue 6 Oct, before the worked examples are captured.

### D18 — Intern catch-up after the relevance fix
- **Context:** the chargeback guide reached the intern catch-up only through false keyword matches (the padding bug).
  With the fix, a cutover-only question returns just the steering deck.
- **Options:** ask about both topics / steering deck only until the role-aware catch-up / keep the old padding.
- **Chosen:** ask about both. The catch-up question now also asks about the chargeback workflow, so interns get both
  documents because both are relevant. Tests cover the cutover-only question and the combined one.

### Implementation details (scenario fixes)
- **Relevance gate** (`packages/retrieval/src/index.ts`):
  - Questions are matched on topic terms: stopwords and single characters are dropped, and whole words must match
    (substrings no longer count).
  - A hyphenated term such as `payment-gateway` also matches text containing all of its parts.
  - A chunk is a candidate only if it shares a topic term, or, with semantic vectors, reaches `SEMANTIC_MIN`
    (0.35).
  - The ranking weights (0.65 / 0.25 / 0.10) are unchanged.
  - Supabase candidates pass through the same gate (`apps/api/src/brain.ts`).
- **Word handling fix:** terms that are also object property names, such as "constructor" and "toString", used to
  throw in `terms()` or produce NaN scores. They are now handled safely.
- **Audit search** (`apps/api/src/audit-search.ts`):
  - Sources and spaces are matched on whole words, preferring the longest space, so `payment-gateway` is no longer
    read as `PAY`.
  - A new document filter answers "who retrieved <doc>". It accepts a doc ID, a native key such as `PAY-101`, or a
    full title.
- **Tests:** `apps/api/src/scenarios.test.ts` holds the brief-aligned scenario suite; scenarios 3 and 5 are covered
  now.

### D19 — How to confirm the SSO setup
- **Context:** sign-in was reported as failing, and the tenant and Supabase settings live only in each person's
  `.env.local`.
- **Options:** a local check script / opening the development sandbox's network to the tenant / sending the exact
  error.
- **Chosen:** a local check script, `pnpm doctor:sso`. It runs on the machine that has `.env.local`, so secrets
  never leave it.
  - It checks the settings, the Auth0 tenant (reachable, issuer, signing keys, client credentials, sign-in request,
    logout URL), the Supabase tables and demo users, and whether the API runs in Auth0 mode and the web host has its
    settings.
  - It only reads, and it prints no secret values.
  - To test the client secret it makes one token request with a made-up code. Auth0 refuses it (a failed-exchange
    log entry) and issues no token.
  - The code is in `apps/api/src/doctor.ts`, with tests in `doctor.test.ts`.

---

## 2026-10-01 — Hosted demo and sign-in

- **Input:** the repository's website, `https://broppy-one.vercel.app`, is a Vercel project. It deploys only the
  Next.js host, so the workspace there had no API behind it.
- **How decided:** each option below was chosen explicitly in a planning session, except D24, where no preference was
  given and the recommended option applies.

### D20 — What the Vercel site is for (supersedes D16)
- **Options:** a public demo without sign-in / an SSO showcase / both / local only for now.
- **Chosen:** both. The start page offers **Try the demo** (fictional people and data, no sign-in) and **Sign in
  with SSO** (the real Auth0 login). A signed-in session always takes priority over demo mode. Preview deployments
  offer the demo only.
- **Trade-off:** the most setup of the four: hosted APIs, Vercel settings and Auth0 URLs. The demo is public, and its
  state is shared by all visitors until the demo API restarts.

### D21 — Where the API runs
- **Options:** inside the Vercel app / a separate Node host (Render, Railway or Fly.io) / Tencent Cloud / not
  decided yet.
- **Chosen:** Tencent Cloud, on condition that it's free. It is: as of 30 Sep 2026, Lighthouse's free trial for new
  users (2 vCPU, 2 GB, 3 months, no card) covers the hackathon. Auto-renew stays off.
- **Trade-off:** someone needs a Tencent Cloud account, and the trial ends after 3 months. The hackathon's credits
  don't cover hosting.

### D22 — One backend or two
- **Options:** two backends / one backend for both.
- **Chosen:** two. A demo API (`PUBLIC_DEMO=true`) serves only the mock corpus, and it refuses to start next to any
  real identity or data setting. A separate SSO API uses Auth0 and Supabase. The web host sends demo visitors only to
  `DEMO_API_URL`, with just a persona name. It sends signed-in people only to `BRAIN_API_URL`, with their token.
- **Trade-off:** two services to run, in exchange for demo visitors never reaching the data behind the SSO showcase.

### D23 — Public address and how the server runs
- **Address options:** a free sslip.io address / our own domain.
- **Chosen address:** sslip.io names such as `demo-api.43-156-1-2.sslip.io`, with Caddy getting and renewing HTTPS
  certificates. There's no domain to buy.
- **Runtime options:** Docker Compose / plain Node with systemd.
- **Chosen runtime:** Docker Compose. One command starts the demo API, the optional SSO API (profile `sso`) and
  Caddy. The guide is `infra/tencent/README.md`.

### D24 — Where the demo persona is chosen
- **Options:** a switcher in the workspace header / the start page.
- **Chosen:** no preference was given, so the recommended header switcher applies. **Viewing as** in the workspace
  header switches the persona, next to a demo banner and a **Leave demo** button.

### Implementation details (hosted demo)
- **API:** with `PUBLIC_DEMO=true`, the API accepts `x-demo-user` even under `NODE_ENV=production`. Startup fails if
  any Auth0, Supabase, live-source, source-OAuth or remote FGA setting is present.
- **Web host:**
  - `/demo` sets an HttpOnly cookie for 8 hours, and `/demo/exit` clears it. The cookie selects the mode, never an
    identity.
  - `/api/session` reports demo mode.
  - Redirects and the same-origin write check use the host the browser used.
- **Image:** it holds only what the API runs, with nothing from `infra/`, where the server keeps `sso.env` and the
  audit key. `.dockerignore` also excludes env and key files anywhere in the tree.
- **Server:** the guide uses Ubuntu 24.04 with Docker's install script. Lighthouse's Docker CE image, whose documented
  base is CentOS 7.6, works too if its Compose is v2 or later.
- **Constraints found while writing the guide:**
  - **One SSO API per Supabase project.** The audit chain accepts one writer per organization (see
    `docs/live-sources-and-sign-in.md`). The hosted SSO API and a local `pnpm dev:sso` on the same project therefore
    break each other.
  - **The team's existing audit signing key.** The hosted SSO API must use it, because stored audit batches are
    verified at startup.

---

## Deferred (not decided yet)
These are open. Pick them up in a later round and record the decision here.

- **Hosted SSO next to local SSO work:** the audit chain allows one writer per organization. Either stop the hosted
  SSO API during local `pnpm dev:sso` work, or give it its own Supabase project.
- **Demo state:** the public demo shares one state across all visitors until it restarts. Scheduled restarts or
  per-visitor state aren't decided.
- **Additional features:** Slack "ok" → Jira suggestion card; task → doc "Mark done"; latest-doc badge scoring;
  duplicate merge; intern catch-up; master page hard-coded to `PAY`.
- **Brain as an MCP server:** not started.
- **CodeBuddy/WorkBuddy evidence:** must be captured by someone using those products. The project isn't scored
  without it.
- **Directory caching:** `UserDirectory.bySub` re-reads the whole directory on every request, and every proxied
  workspace call now triggers it.
- **Ravi persona:** the README says "Head of payments", but the demo script has him as a junior engineer.
- The other P1 items are also still open: whole-brain JSONB snapshot writes, independent Merkle root anchoring,
  source-specific FGA types, and webhooks. The snapshot write runs after every successful response, `/health`
  included, which matters once the SSO API is reachable from the internet.
