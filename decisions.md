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

## 2026-10-01 — Scenarios 1, 2 and 4

- **Input:** the brief's scenarios 1, 2 and 4 each need a worked example. A run of the code on 1 Oct showed three
  gaps:
  - A question that named Slack and "last week" was answered without any Slack message.
  - There was no runbook to find.
  - By 16 Oct, the fixed late-September mock dates would fall outside "last week".
- **How decided:** both options below were chosen explicitly in a planning session.

### D25 — The project behind scenario 1
- **Options:**
  - the brief's exact example, through a new database migration project;
  - reuse of the payment migration story.
- **Chosen:** the brief's exact example. The question works word for word, and the existing payment documents and
  their tests are unchanged. The new mock data:
  - Jira issues DB-12 and DB-15, with statuses;
  - private #db-migration, with a blocker raised last week;
  - private #db-oncall, which David isn't in;
  - public #db-planning, which is older;
  - a Confluence plan page.
- **Trade-off:** eight more fixture documents to keep consistent, counting scenario 2's runbook and its old copy.

### D26 — Cross-links between platforms
- **Options:** later, with R9 / in this round.
- **Chosen:** later, with R9, next to the Slack-to-Jira card and the per-project master page. Search already finds
  items on every platform when they share words or keys such as PAY-101.

### Implementation details (scenarios 1, 2 and 4)
- **Query plan** (`apps/api/src/query-plan.ts`):
  - Platforms a question names come first, up to three items each.
  - A relative time ("last week", "past 3 days", "yesterday") limits the named platforms, or every platform when none
    is named. The parsing is shared with audit search (`time-window.ts`), which now also accepts "past".
  - Platforms whose best match scores at least half the top score then take turns, and the rest follow by score.
  - The plan is audited as `query_planned` and shown in the asker's own trace. Answers carry it as `scope`, which the
    workspace shows under the answer.
- **Jira status:** a Jira chunk enters the answer context with its status after the key, as in "DB-12 (in progress)
  tracks…". The index is unchanged, and the integrity check after generation still compares the raw chunk text.
- **Local answer writer:** quotes the most relevant source in full, up to six sentences. It then adds the best
  sentence from up to three more sources. Every line is still one checked claim.
- **Search:** "blockers" also matches "blocker".
- **Mock dates:** `loadMockCorpus(now)` moves the fixture dates forward by the whole days since 30 Sep 2026. State
  saved to Supabase keeps the dates it was first saved with.
- **Tests:** `scenarios.test.ts` now covers scenarios 1 to 5. Scenario 2 uses a fake clock for the 1:00 PM edit and
  the 2:05 PM question.

---

## 2026-10-01 — A language model that costs nothing

- **Input:** D17 left the model choice open. Tencent's free packages, as found on 1 Oct and to be confirmed in the
  console:
  - hunyuan-T1 (chat) and hunyuan-embedding each get 1M tokens at first activation, valid for a year;
  - the translation models get 100M, but they can't write answers.

  Tencent's billing page says a used-up or expired free package doesn't switch to pay-as-you-go. Calls fail with a
  billing error unless **Postpaid Settings** is turned on in the Tencent HY console, and it is off by default. This
  came from search results, so the team confirms it in the console.
- **Measured:** a model call here costs about 510 tokens without "thinking": 200–520 in and 60–170 out. Questions with
  nothing the asker may see never call the model. About 350 answers are expected across development, worked examples,
  the video, the team and the judges.
- **How decided:** chosen explicitly in a planning session.

### D27 — Which model, without ever paying (resolves D17)
- **Options:** Hunyuan with a hard budget / Groq's free plan / no model.
- **Chosen:** Hunyuan, if `pnpm llm:usage` shows the plan fits its free 1M tokens: under 70%, which is about 2,000
  tokens per answer. Otherwise, Groq's free plan.
- **How "never paying" is kept:**
  - Postpaid Settings stays off in the Tencent HY console, so calls past the free tokens fail instead of billing.
  - Hunyuan only starts with a usage file and budgets set below the free tokens. That's a second stop, and it also
    keeps tokens for the showcase.
  - Groq has no card on file, so it can't bill.
  - At any limit, the built-in writer answers instead.
- **Trade-off:** T1 is a reasoning model whose thinking tokens aren't known until measured, so the choice waits for
  that run. The same code serves either outcome.

### D28 — The model in the public demo
- **Options:** none / a small daily allowance.
- **Chosen:** with Groq, a small daily allowance shared by every visitor (`LLM_DAILY_ANSWERS`, 100 to start). With
  Hunyuan, decided after measuring; until then the demo uses the built-in writer.
- **Trade-off:** visitors share one allowance, so a busy day ends in built-in answers until midnight UTC.

### D29 — A model reply with nothing copied word for word
- **Context:** every answer keeps only lines copied word for word from sources the asker may see. A model that
  paraphrases, or a model that only translates, can lose every line.
- **Options:** the built-in writer's answer / the fixed "nothing found" reply.
- **Chosen:** the built-in writer's answer, from the same authorized sources. The audit records `llm_fallback` with
  reason `ungrounded`, and `pnpm llm:usage` counts it as no usable answer.
- **Trade-off:** as with every fallback, the asker isn't told which writer answered.

### D30 — No second model as a backup
- **Context:** the built-in writer is code in this repository, not a model. It needs no key, network or allowance, so
  it is the step that always works.
- **Options:** one model, then the built-in writer / Hunyuan, then Groq, then the built-in writer.
- **Chosen:** one model, then the built-in writer. The model is whichever one `pnpm llm:usage` picks (D27).
- **Trade-off:** when the chosen model can't answer, the built-in writer quotes sources instead of picking sentences.
  The measurement's 30% margin is meant to keep that rare during the showcase.

### D31 — Tencent's international model service, TokenHub
- **Context:** search results found on 1 Oct, while writing the team's measurement steps, show that international
  Tencent Cloud accounts get models through TokenHub:
  - OpenAI-compatible, at `https://tokenhub-intl.tencentcloudmaas.com/v1`, with keys from TokenHub's API Key page;
  - Hunyuan's model there is `hy3-preview`, a reasoning model;
  - each language model gets 1M free tokens for 90 days;
  - calls stop when those run out unless post-paid billing is enabled.

  The `hunyuan` setting points at the China site and sends a Hunyuan-only request field.
- **Options:** a `tokenhub` setting / an existing setting pointed at TokenHub with `LLM_BASE_URL`.
- **Chosen:** `LLM_PROVIDER=tokenhub`, with TokenHub's address built in, no Hunyuan-only fields, and the same required
  usage file and budget. D27's rule is unchanged; the team measures `hy3-preview` on TokenHub.
- **Trade-off:** one more setting. Semantic search keeps the China-site embedding client, unconfirmed on TokenHub.
- **Correction (1 Oct):** the console lists the released model as `hy3`; `hy3-preview` was its preview name. The
  free trial is claimed under New User Free Trial in the Model Gallery, or automatically on the first call.

### Implementation details (language model)
- **Client:** `apps/api/src/llm.ts` serves every provider through its OpenAI-style chat API, with fixed presets.
  - `tokenhub` (D31) uses TokenHub's international address. Every provider but Groq needs the usage file and a
    budget.
  - `LLM_BASE_URL` may point at another HTTPS address, or plain HTTP on the same machine for a local stub.
  - Thinking in `<think>` tags or a separate field is dropped.
  - Each call's reported token usage is read; when a provider doesn't report it, it is estimated on the high side.
  - Each answer is capped by `LLM_MAX_TOKENS`, default 1500.
  - A call gives up after 60 seconds.
- **Meter** (`apps/api/src/llm-budget.ts`):
  - Counts chat tokens, embedding tokens and model answers per UTC day, in `LLM_USAGE_FILE` when set.
  - It fails closed: a file it can't read or write stops the model.
  - Calls still running count against the limits. Each holds its prompt estimate plus `LLM_MAX_TOKENS` until it
    ends, so questions asked at the same moment can't all get past the budget or the daily allowance.
  - Calls without a usable answer still count what the provider may bill:
    - an answer cut off at `LLM_MAX_TOKENS`, or one that fails the checks, counts its tokens;
    - a server error or a call that times out counts the whole amount it held;
    - a refused request (HTTP 4xx, rate limits included) counts nothing.
  - In the hosted setup, each API has its own file on the `model-usage` volume.
  - Each place that uses one Tencent Cloud account counts only its own calls. Their budgets together must stay below
    the free tokens, e.g. 100000 on a laptop and 700000 on the server.
- **Fallbacks:**
  - Answers: over a limit, rate limited, failing, or with no line copied word for word (`ungrounded`, D29), the
    built-in writer answers from the same authorized context, and the audit records `llm_fallback` with the reason.
  - Embeddings: over budget, embeddings pause, so sync and questions use keyword search.
- **Scripts:**
  - `pnpm llm:usage` measures ten typical questions and gives the verdict.
  - `pnpm llm:calibrate` suggests `SEMANTIC_MIN` from labelled questions, including three with no shared keywords.

---

## 2026-10-01 — Worked examples for the five scenarios (R7)

- **Input:** the brief asks for a worked example of each scenario. Scenario tests and a README table covered them,
  but there was no walk-through to read.
- **How decided:** chosen explicitly in a planning session.

### D32 — Worked examples before the model is chosen
- **Options:** start now with the built-in writer / wait for the model measurement.
- **Chosen:** start now. `docs/worked-examples.md` uses the built-in writer, and `pnpm scenarios:model` captures the
  chosen model's version in `docs/worked-examples-model.md`.
- **Trade-off:** the checked examples show quoted sentences rather than a model's choice. The model's version is a
  separate, unchecked file.

### D33 — The tests check the worked examples
- **Options:** `pnpm test` fails when the page no longer matches the code / regenerate it by hand.
- **Chosen:** the tests check it. `pnpm scenarios` rewrites the page.
- **Trade-off:** a change that alters an example needs `pnpm scenarios` and a review of the diff.

### D34 — 'jdoe' in scenario 5
- **Options:** Ravi stands in / a new 'jdoe' persona.
- **Chosen:** Ravi stands in, and the page says so.
- **Trade-off:** the brief's sentence isn't run word for word, but no persona, permissions or SSO seed change.

### D35 — Screenshots
- **Options:** images only / images and the capture script, with Playwright as a dependency / no screenshots.
- **Chosen:** images only, in `docs/images`. The capture script stays out of the repository.
- **Trade-off:** re-taking them needs the script, which is kept with the team's notes.

### Implementation details (worked examples)
- **Generator** (`apps/api/src/worked-examples.ts`):
  - Each scenario runs on a fresh Brain with a fixed clock: Thursday 15 October 2026, with scenario 2 at 12:00,
    13:00 and 14:05 UTC.
  - Every claim in the text, such as "cites it: no", is computed from the run.
  - The output never changes between runs: no trace IDs or hashes, and dates in UTC with fixed month names.
- **Check:** `worked-examples.test.ts` compares the page with a vitest file snapshot.
- **Asker's view:** `actorTrace` is exported from `server.ts`, so the page can show the asker's own trace.
- **Model capture:** it uses no HTTP server, so the Auth0 and Supabase settings in `.env.local` are never used. Its
  calls count against the usage meter.
- **Screenshots:** taken in the public demo, with the API's and the browser's clocks set to 15 October 2026, 14:05
  UTC.

## 2026-10-01 — Docs and diagrams catch up with the code (R8)

- **Input:** `docs/architecture.md`, `docs/trust-boundary.md` and the diagram source still described the September
  design. That meant a Python static site, browser PKCE with the token in `sessionStorage`, and Hunyuan as the only
  model. There was no demo, hosting, usage meter or query plan. The five-stage plan asks for a final diagram that
  makes five points "visually unavoidable". The README's link to that plan was broken.
- **How decided:** chosen explicitly in a planning session.

### D36 — A brief-first architecture doc
- **Options:** brief-first / today's layout with every stale fact corrected.
- **Chosen:** brief-first. `docs/architecture.md` opens with the brief's five requirements, each tied to the code,
  the test that proves it and the worked example. The pipeline diagram follows, with the plan's five points numbered
  ①–⑤.
- **Trade-off:** it's written for judges first. The engineering detail sits in shorter sections below.

### D37 — The September docs stay, marked as history
- **Options:** keep them, marked as history / move them to `docs/history/` / delete them.
- **Chosen:** keep them where they are. The five-stage plan, the 30 Sep audit and its implementation notes are
  unchanged apart from a dated note at the top pointing to the current design. The README lists them under History.
- **Trade-off:** they still describe the old design, so readers rely on that note.

### D38 — Mermaid plus rendered images
- **Options:** Mermaid plus PNGs / Mermaid only.
- **Chosen:** both. GitHub draws the Mermaid, and `docs/images/diagram-*.png` serve the video and slides. The images
  are made in the development sandbox from a downloaded copy of Mermaid, with no new dependency.
- **Trade-off:** the images need re-rendering whenever a diagram changes. The script is kept with the team's notes.

### D39 — The tests check the docs
- **Options:** `pnpm test` checks the diagrams and links / review by hand only.
- **Chosen:** the tests check them, in `apps/api/src/docs.test.ts`.
- **Trade-off:** moving a file or editing a diagram means updating the docs in the same change.

### Implementation details (docs and diagrams)
- **Sources:** each diagram lives in `docs/diagrams/NAME.mmd`; the old `docs/diagram-source.mmd` is now
  `pipeline.mmd`. A doc embeds a diagram, copied exactly, after a `<!-- diagram: docs/diagrams/NAME.mmd -->` line.
- **Check:** `docs.test.ts` reads the README, this file, `apps/web/AUTH0.md`, `infra/tencent/README.md` and
  `docs/*.md`.
  - Every relative link and image outside code blocks must point to a file that exists.
  - Every embedded diagram must equal its source.
  - Every source must be embedded somewhere and have its `docs/images/diagram-NAME.png`.
- **Diagrams:** flowcharts and one sequence diagram, using only syntax that parses in Mermaid 11 and 12. Node text
  keeps each line to 24 characters or fewer, because Mermaid wraps longer lines on its own.
- **Images:** rendered at twice the size in Chromium with Mermaid 11.17.2. The script, `r8-diagrams.mjs`, also checks
  that each diagram parses in Mermaid 12.

## 2026-10-01 — Links across platforms, project pages and workspace actions (R9)

- **Input:** the brief asks that one answer can draw on "a Jira ticket, its linked Slack discussion, the related
  Confluence doc and an attached Drive file", respecting each platform's permissions. D26 had deferred cross-links to
  this round. The five-stage plan's additional features were still browser heuristics:
  - the Slack → Jira card only paired a thread with an existing issue;
  - a task had no Mark done;
  - the Latest badge gave no reasons;
  - the duplicate notice needed a file already labelled superseded;
  - the catch-up was one intern question;
  - the master page was fixed to the PAY space.
- **How decided:** chosen explicitly in a planning session.

### D40 — What R9 includes
- **Options:** any of cross-links / project pages and catch-up / Slack → Jira and Mark done / duplicates and the
  Latest badge.
- **Chosen:** all four.
- **Trade-off:** a larger round. Each part is its own commit, with its own tests.

### D41 — Links change answers
- **Options:** answers and the workspace / the workspace only.
- **Chosen:** both. Linked items join an answer's context, and each passes the same checks as a search result.
- **Trade-off:** answers draw on more items, so the worked examples changed and were reviewed.

### D42 — Who may change tasks
- **Options:** project members / admins only / no writes.
- **Chosen:** project members, on mock sources. Anyone who can see an issue in a Jira project may create a task there
  from an agreement, or mark a task done. With live sources the app links to Jira and keeps read-only scopes.
- **Trade-off:** in the shared public demo, any visitor can create or close demo tasks until it restarts.

### D43 — Duplicate merge
- **Options:** a clickable preview / a working merge in the demo.
- **Chosen:** a preview that changes nothing, as the five-stage plan asked.
- **Trade-off:** merging stays a manual step at the source.

### D44 — Spotting agreements
- **Options:** fixed phrases / ask the model.
- **Chosen:** fixed phrases at the start of a sentence, such as "Agreed:", "Decision:" or "OK, let's".
- **Trade-off:** looser wording isn't caught. In return it is predictable and free, and it works with the built-in
  writer.

### D45 — The catch-up
- **Options:** by role and groups / add job titles to the directory.
- **Chosen:** role and groups, with no directory change.
- **Trade-off:** Ravi and David get the same kind of catch-up. The Ravi persona question stays open.

### D46 — What a project is
- **Options:** a master page and its links / a configured list.
- **Chosen:** a Confluence page labelled "master" defines a project. It holds what the page links to, the issues,
  pages and channels tagged with its key, and what those issues link to. A project is listed only to people who can
  open its master page.
- **Trade-off:** an item that nothing links to or tags stays outside every project, under All sources.

### D47 — Links from live sources
- **Options:** collect them from what's already read / mock sources only.
- **Chosen:** collect them, with no extra requests. That covers Jira's issue links and description links, Confluence's
  storage-format links, Jira macros and "master" label, and links in Slack messages.
- **Trade-off:** tested with recorded responses only, because the development sandbox can't reach the services.

### Implementation details (links, projects and workspace actions)
- **Links:** `SourceDocument.links` holds item IDs.
  - `linksIn` reads issue keys, and links by their path: Jira `/browse/KEY`, Confluence `pageId` or `/pages/ID`,
    Slack `/archives/ID` and Drive `/d/ID`.
  - A link counts only where an item with that ID exists.
  - The index hashes links with the metadata, so a link-only change never re-embeds.
- **Links in answers:**
  - **Where from:** documents the asker may open that score at least half the best of them, up to eight. Links are
    followed one hop, in either direction.
  - **How checked:** a linked item scores half the item it came through, takes its first chunk and keeps to the time
    window. It is audited as `candidate_linked` and passes ② and ④. It counts only while the item it came through
    passes its own live check.
  - **Ordering:** it never takes a named platform's first places, nor makes a platform clearly relevant. That kept
    scenario 1's cited lines unchanged.
- **Workspace:** `/v1/workspace` adds projects, the latest files, duplicates and suggestions. `workspace.ts` computes
  them from the visible documents only. Duplicates share at least 60% of their content words, or a title where one is
  superseded.
- **Tasks:** `POST /v1/tasks` and `POST /v1/tasks/done`.
  - A new task's title and text come from the agreed sentence, and it links back to the thread.
  - It copies the permissions and tier of the issue it is modelled on: the one the thread links to, else the
    project's latest.
  - Both are audited, as `task_created` and `task_status_changed`.
- **Catch-up:** `POST /v1/catch-up`. `Brain.query` gained an optional project scope, which the answer's scope and the
  asker's trace report.
- **Built-in writer:** it now picks a source's best sentence by topic words, ignoring small words such as "is" or
  "of". The worked examples were unchanged by this.
- **Demo data:** six items gained links and the two master pages their label. #db-migration gained an agreement. Two
  Drive files are new: a wave checklist reached only through links, and a near-copy of the API spec.
- **Screenshots:** the seven worked-example screenshots were re-taken, and the README gained two of the workspace.

---

## 2026-10-02 — Connectors first, and the root anchor

- **Input:** an audit of the repo against the Notion plan, then the Coucou review and its "active Brain" proposal.
- **How decided:** chosen explicitly in a planning session.

### D48 — Proposal storage
- **Options:** the existing in-memory and snapshot state / a new Supabase migration for `proposals` and
  `agent_settings`.
- **Chosen:** the existing state. No schema change.

### D49 — Scope: connectors before features
- **Chosen:** no new features and no Active/Paused toggle for now. Connector reliability comes first. The Slack-to-Jira task
  suggestion had already merged from R9 (D44), so no further feature is planned.
- **Trade-off:** the Coucou ideas (status bar, queue, watchers) wait until the connectors are solid.

### D50 — Root anchor: a separate GitHub repository, written by a Rust tool
- **Options:** Tencent COS retention lock / a separate GitHub repository.
- **Chosen:** a separate GitHub repository, written by `tools/anchor` (Rust, no network code, public key only).
- **Trade-off:** it stays outside the pnpm workspace, and it reads the JSONL log, not Supabase-only batches. The
  repository still needs creating, and someone must run `publish` and push. See `tools/anchor/README.md`.

### D51 — What a company includes from each source
- **Context:** a trace of connecting a source found that every source started as connected with an empty scope, which
  meant "everything". The five-minute sync would import all a credential could see before an admin chose anything. The
  only controls were free-text ID fields and a date.
- **Chosen:** an explicit mode, `all`, `selected` or `none`, with `none` as the default after the OAuth callback. A
  "new or changed from now on" option fixes its starting moment when saved. A checklist is loaded from the provider.
  Saving starts the import, and narrowing removes what is no longer included.
- **Trade-off:** "from now on" uses the source's modified time, so an older item edited later counts. A scope with no
  mode keeps its old meaning, so demo onboarding, which imports everything, is unchanged.

### D52 — New companies are not onboarded automatically
- **Context:** `docs/live-sources-and-sign-in.md` states one API process serves one `AUTH0_ORG_ID`, and a new
  organization is not provisioned or routed. A new company can't register itself today.
- **Chosen:** not changed. Self-registration needs multi-tenant provisioning (an Auth0 organization and directory
  rows per company, and routing), which is new infrastructure and waits for approval.

### D53 — The Brain is one pipeline, not agents reading agents
- **Chosen:** four connectors behind one interface feed one index, one authorization check and one answer path. The
  language model only picks and orders sentences. The sync orchestrator is a timer, not an agent. The Notion notes
  proposed an orchestrator with a sub-agent per platform; the build replaced that with the single gateway in
  `docs/internal-brain-five-stage-plan.md`.

### Implementation details (connector hardening)
- **A rejected credential is not a deleted item.** A 401 from a provider, or Slack's `invalid_auth`, `token_revoked`
  and similar, now throws `CredentialRejected`. Before, `LiveConnector` returned "not found", which sync turns into
  a tombstone and a purge of the item. Now the sync fails and keeps the index. A user's rejected credential still
  means "no access". 403 and 404 still mean gone.
- **Dropped connections** (reset, refused, timeout) are retried three times with 250, 500 and 1000 ms backoff.
- **`listUpdatedSince`** reports only items whose version moved since the last poll, not every configured item.
  *Amended 2 Oct:* the first poll and every twelfth report every item. Sharing or restricting an item changes no
  version, so without that pass a newly shared item never reached the index for its new reader (revocations stayed
  safe, because every answer rechecks access at the source). At five-minute polls, a share arrives within an hour.
- **Per-user permission checks** run together, not one by one. *Amended 2 Oct:* five at a time, so a large directory
  can't fire every check at once and hit the provider's rate limit.
- **Rate limits are pauses, never "gone".** Drive reports one as a 403 (`userRateLimitExceeded`), and Slack can report
  `ratelimited` inside a 200. Both retry with 1, 2 and 4 second waits, then fail the sync so it resumes later. A
  Slack channel lookup that fails for any reason other than `channel_not_found` or `not_in_channel` now fails the
  sync; before, any `ok: false` read as a missing channel and was tombstoned.
- **Reconnecting keeps the scope.** The OAuth callback used to reset a source to `none`, so reconnecting after a
  rejected credential would have emptied it. A new connection still starts at `none`; reconnecting a source that was
  already set up keeps the admin's choice (`Brain.markConnected`).
- **A source in error says why.** The Connectors page shows the reason ("slack credential was rejected; reconnect the
  source") until the next successful sync clears it. Documents stay indexed while a source is in error.
- **Trashed items are not indexed.** A trashed Drive file and a Confluence page that isn't `current` can still be
  fetched by ID, so both now read as gone. A Confluence page moved to another space keeps its ID and is picked up or
  dropped by the container it now sits in.

---

## Deferred (not decided yet)
These are open. Pick them up in a later round and record the decision here.

- **The model's route and the public demo on Hunyuan:** waits for the team's `pnpm llm:usage` run (D27, D28).
- **Hosted SSO next to local SSO work:** the audit chain allows one writer per organization. Either stop the hosted
  SSO API during local `pnpm dev:sso` work, or give it its own Supabase project.
- **Demo state:** the public demo shares one state across all visitors until it restarts. Scheduled restarts or
  per-visitor state aren't decided.
- **Additional features:** done in R9 (D40–D47), except a working duplicate merge, which stays a preview (D43).
- **Brain as an MCP server:** not started; to be written in Rust after submission.
- **Anchor repository:** not created yet; the tool is built (D50).
- **CodeBuddy/WorkBuddy evidence:** must be captured by someone using those products. The project isn't scored
  without it.
- **Directory caching:** `UserDirectory.bySub` re-reads the whole directory on every request, and every proxied
  workspace call now triggers it.
- **Ravi persona:** the README says "Head of payments", but the demo script has him as a junior engineer.
- The other P1 items are also still open: whole-brain JSONB snapshot writes, independent Merkle root anchoring,
  source-specific FGA types, and webhooks. The snapshot write runs after every successful response, `/health`
  included, which matters once the SSO API is reachable from the internet.
