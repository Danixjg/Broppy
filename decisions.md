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
- **The anchor tool checks entries too** (2 Oct). `publish` and `verify` used to check only the batch records, so a
  changed audit entry passed `verify` as long as its batch record was untouched. Both now recompute every entry's
  hash from its content, exactly as `packages/audit` does, check the chain between entries, and rebuild each batch's
  root from its entries. The test fixture is a real 130-entry log written by the TypeScript `AuditLog`.

---

## 2026-10-02 — The language model, for now

- **Input:** the model measurement with `pnpm llm:usage` on 2 Oct.
- **How decided:** chosen explicitly in a planning session.

### D54 — gpt-oss-120b on Groq until TokenHub runs
- **What the measurement found:**
  - **TokenHub:** the free trial for `hy4-preview` and `hy3` was claimed, which created a default inference service for
    each. Both show "Stopped" for insufficient account balance, so calls return 402 with code `401006`. Running them
    needs money in the account, which D27 rules out. The team asked Tencent whether hackathon teams can get credits.
  - **Groq:** `llama-3.3-70b-versatile` has been retired. `openai/gpt-oss-120b` grounded 8 of 9 answers at about 870
    tokens each, with `LLM_MAX_TOKENS=4000`. The ninth, a yes/no question, came back reworded, so the built-in writer
    answered it.
- **Options:** a small top-up of the Tencent account / a teammate's Tencent account / Groq now, while asking
  Tencent.
- **Chosen:** Groq's `openai/gpt-oss-120b` for now, and `hy4-preview` on TokenHub once Tencent resolves the balance
  block. D27 and D30 stand: one model at a time, then the built-in writer.
- **Trade-off:** until then the model isn't Tencent's own. Switching back is two settings.

### Implementation details (Windows and the model)
- **Windows:** the docs check built its folder path from a file URL's `pathname`, which on Windows becomes
  `C:\C:\…`; it now uses `fileURLToPath`. `data/seed.ts` compared `import.meta.url` with `file://` plus the script
  path, which never matches on Windows; it now uses `pathToFileURL`, as the API does. `.npmrc` sets
  `shell-emulator=true`, so scripts such as `pnpm dev` (`ALLOW_DEMO_AUTH=true tsx …`) run on Windows too.
  *Amended 3 Oct:* Git for Windows checks text out with CRLF line endings by default, so the docs check's diagram
  markers never matched and every diagram read as not embedded. It now compares text with LF line endings.
- **`pnpm llm:usage` with Groq** no longer judges the plan against Tencent's free tokens. Groq's free plan can't bill,
  so the report gives the tokens and points to Groq's per-day limits, and it exits 0 when any answer was measured.
- **Examples** name `openai/gpt-oss-120b` for Groq and `LLM_MAX_TOKENS=4000` for reasoning models.

---

## 2026-10-02 — No Tencent model

- **Input:** D54's TokenHub block.
- **How decided:** chosen explicitly in a planning session.

### D55 — No Tencent model; Groq answers on both APIs (supersedes D54's return to TokenHub)
- **Options:** wait for Tencent's answer on credits, then move to `hy4-preview` as D54 planned / drop Tencent's models.
- **Chosen:** drop them, for answers and for embeddings.
  - Groq's `openai/gpt-oss-120b` answers on the public demo and on the sign-in API. Each API keeps its own daily
    allowance (`LLM_DAILY_ANSWERS`).
  - With Tencent's embedding model gone, semantic search is off until another provider is added.
  - The `tokenhub` and `hunyuan` presets and the Hunyuan embedding client stay in the code as tested options, unused.
    The docs and examples name Groq only.
- **Trade-off:**
  - The model isn't Tencent's own.
  - Every key in one Groq account shares its per-minute and per-day limits, so the two APIs compete for them; the
    daily allowances cap each one's share.
  - Groq's free plan has no card on file, so nothing can be billed (D27).

### Implementation details (no Tencent model)
- **Docs and examples** name Groq only: the README, `.env.example`, `infra/tencent/sso.env.example`, the hosting
  guide's model step, the architecture page, and the hosting diagram with the trust-boundary table.
- **The sign-in API on Groq:** `sso.env.example` has the Groq lines and a daily allowance of 100. The API counts its
  answers in `/data/usage-sso.json`, as before.
- **The model's instructions** (*added 3 Oct*).
  - **What the run showed:** `pnpm scenarios:model` with Groq and Cloudflare kept every access rule. But the model
    answered only the Slack half of scenario 1, with no Jira status. It also left out Ravi's #db-oncall line and
    step 1 of the runbook.
  - **Why:** the instructions only said to copy sentences and cite them.
  - **Now:** they also ask the model to answer every part of the question, to use every passage that helps and leave
    out unrelated ones, to keep status labels and every step, and to put the direct answer first, in at most eight
    sentences.
  - **Unchanged:** sentences must still be copied exactly, so the grounding check is the same.
- **The copy check** (*added 3 Oct*).
  - **What the runs showed:** step 1 of the runbook ("page the payments on-call engineer") was missing in both
    model runs. The first run had also lost every other hyphenated line: DB-12, DB-15 and "On-call…".
  - **Why:** the model can write a non-breaking hyphen where the source has an ordinary one. The two look the same,
    but the check compared characters, so it dropped the line.
  - **Now:** both sides are folded before they're compared: NFKC, hyphen and dash variants, curly quotes and special
    spaces. A kept line shows the source's own sentence.
  - **Unchanged:** a reworded sentence is still dropped.
- **The model version of the worked examples** (*captured 3 Oct*, the third run, with Groq and Cloudflare's
  embeddings) is committed as `docs/worked-examples-model.md`.
  - **What it shows:** scenario 1 cites the same four sources as the built-in writer, the runbook answer has every
    step, and scenario 3's fixed reply holds.
  - **One fallback:** in scenario 4, one answer came from the built-in writer, because Groq's free plan rate-limited
    the call. The page says so.
  - **Header:** it now names the search as well as the writer.
- **Answers vary from run to run** (*added 3 Oct, corrected 4 Oct*).
  - **What showed it:** on the team's real sign-in, Ravi's scenario 1 answer was three lines. It left out DB-12's
    status and his #db-oncall blocker, although both were sent to the model, and the captured run had included them.
    The same question then got fuller answers on later runs.
  - **Tried:** a fixed seed on Groq requests (3 Oct). On the team's machine, the same question asked twice still got
    two different answers, so the seed was removed (4 Oct). Both of those answers were complete.
  - **Not tried:** temperature 0. OpenAI recommends 1.0 for gpt-oss, and forcing 0 can make a reasoning model loop.
  - **What holds on every run:** each line is copied from a passage the asker may see and is cited.
  - **Still open:** about one answer in five so far has been thin. A fix could make sure every allowed passage from a
    platform the question names is quoted.

---

## 2026-10-02 — Embeddings from Cloudflare

- **Input:** a search for free embedding providers on 2 Oct, after D55 dropped Tencent's.
- **How decided:** chosen explicitly in a planning session.

### D56 — Cloudflare Workers AI's bge-m3 for semantic search
- **What mattered:** the embedding provider sees more than the chat model. Sync sends it every chunk, restricted
  documents included, while the model only sees what one asker may read. So besides cost, the question was whether a
  provider trains on what it's sent.
- **Options:**
  - **Cloudflare Workers AI, `@cf/baai/bge-m3`.** 10,000 free neurons a day, about 9 million tokens for this model.
    The free plan refuses calls past that instead of billing, and Cloudflare doesn't use customer content to train
    models. 1024 dimensions, with an OpenAI-style endpoint.
  - **Jina AI, `jina-embeddings-v3`.** A one-off grant of free tokens per key, no training on API data, 1024
    dimensions. The grant doesn't renew.
  - **A model inside the API.** Nothing leaves the server, but it needs a native library, a model download, and the
    2 GB server's CPU and memory.
  - **Ruled out:**
    - Gemini's free tier: Google may use the input to improve its products, and people may read it.
    - Mistral's free plan: it reportedly requires opting into training.
    - Voyage AI without a card: 3 requests a minute.
    - Cohere's trial: 1,000 calls a month.
    - GitHub Models: 150 embedding requests a day.
    - Groq: it has no embedding models.
- **Chosen:** Cloudflare's `bge-m3`. Its vectors are the same size as before, so the index and Supabase need no
  change.
- **Trade-offs:**
  - Cloudflare sees every chunk's text, restricted documents included.
  - Cloudflare's forum has many recent reports of free accounts refused as "allocation used up" right after the
    daily reset. So a refusal must never break sync or slow answers (below).
  - `SEMANTIC_MIN` (0.35) was never tuned against a real model. `pnpm llm:calibrate` tunes it before semantic search
    goes into a demo.
  - The account must stay on the Workers Free plan; on Workers Paid, use past the allocation is billed.

### Implementation details (Cloudflare embeddings)
- **Client:** `EmbeddingClient` has `cloudflare` and `hunyuan` presets.
  - **Settings:** `EMBEDDING_PROVIDER` and `EMBEDDING_API_KEY` choose the preset. Cloudflare also needs
    `CLOUDFLARE_ACCOUNT_ID`, 32 hexadecimal characters. The older `HUNYUAN_EMBEDDING_API_KEY` still selects Hunyuan.
  - **Calls:** they give up after 10 seconds.
  - **Checks:** Cloudflare's vectors are checked by size, because its responses aren't documented to name the model.
- **Budget:** optional for Cloudflare, whose free plan can't bill. It is still required for Hunyuan.
- **Failures never stop sync.**
  - **Before:** a failed embedding failed the sync run. The source showed an error, and the items after it weren't
    indexed until the provider recovered.
  - **Now:** the document keeps keyword search, and the provider rests for five minutes. After that, each sync
    embeds whatever still lacks vectors and rewrites those chunks in Supabase.
  - **Questions during the pause** skip the provider, and the audit records `embedding_fallback` with the reason
    (`failed` or `paused`).
- **Threshold** (*tuned 3 Oct*). `pnpm llm:calibrate` ran against `bge-m3` over the 26 mock items.
  - **Matching pairs:** lowest 0.43, 25th percentile 0.51, median 0.59.
  - **Non-matching pairs:** median 0.40, 95th percentile 0.51, highest 0.61.
  - **The change:** `SEMANTIC_MIN` moves from 0.35, which let in 176 of the 234 non-matching pairs, to 0.51.
  - **What's left:** the two groups overlap, so about one unrelated pair in twenty still passes on similarity alone.
    Keyword matches are unaffected.
  - **Retune** when the documents change.

### Implementation details (setting up sign-in, 3 Oct)
- **Migration 005's Vault grant.** It granted `vault.update_secret(uuid,text,text,text)`. Newer Supabase Vault versions
  give that function a fifth input (a key ID), so the statement failed and, with it, the whole migration. It now grants
  whatever versions of `create_secret` and `update_secret` the project has. The failure was found while applying the
  migrations to the team's Supabase project.
- **Seeding the demo users.** The seed script reported only a status code. It now prints the reason Auth0 or
  Supabase gave, and `apps/web/AUTH0.md` lists what each reason means.
  - **The 400 the team hit:** new Auth0 database connections require passwords of at least 15 characters by default,
    while the script only checks for 12. The guide now says the connection's policy applies too.
  - **Windows:** the guide gained a PowerShell version of the command.
  - **Afterwards:** the guide says to delete the machine-to-machine application once seeding is done.
- **No false permission changes after a restart.** The team's audit export showed all 26 documents logged as
  `document_synced` with `permissionChanged: true` after the API restarted, although nothing had changed.
  - **Why:** Supabase keeps the saved state in a `jsonb` column, which returns object keys shortest first. The index
    hashed permissions and metadata with plain `JSON.stringify`, which depends on key order, so every reloaded
    document looked changed. The audit log already sorts keys for the same reason (hash version 2).
  - **Now:** the index sorts object keys before hashing.
  - **Once more:** hashes saved before this change were made the old way, so the first sync after updating logs one
    last round of permission changes. After that they stop.

## 2026-10-04 — UI fixes, round 1

- **Input:** using the workspace with real sign-in on 3 Oct.
  - Clicking a source opened a browser error page.
  - Answers ended every line in raw markers such as `[slack:db-oncall:0]`.
  - A 15-second answer looked frozen.
  - Nur's audit question in the chat got the fixed reply.
  - The audit console listed every field of every entry, and each restart added 26 routine sync rows.
- **How decided:** chosen explicitly in a planning session.

### D57 — What round 1 covers
- **Chosen:**
  - sources that open in the workspace, with the quoted lines highlighted;
  - numbered citations;
  - progress while an answer is on its way;
  - an audit hint in the chat for compliance users;
  - a readable audit console.
- **Not now:**
  - a label saying which writer answered, the built-in one or the model;
  - "Show more" for long lists, which waits for the generated dataset.

### D58 — Demo addresses are labelled, not linked
- **Why:** all 26 demo documents live at addresses on the reserved `.example` domain, which no browser can open.
- **Options:** keep the links, drop them silently, or label them.
- **Chosen:** a document at an `.example` address says "Demo document: there's no live Slack page" (or Jira,
  Confluence, Drive) in place of a link. Real addresses keep "Open in Slack ↗".
- **Trade-off:** the test is the host name alone. `.example` is reserved for documentation (RFC 2606), so no real
  source uses it.

### D59 — The audit hint is for compliance users only
- **Chosen:** when a compliance user's chat question reads like an audit question, the answer offers **Search the
  audit log**, which opens the console and runs the same question there.
  - **The wording it looks for:** accessed, retrieved, audit, "user 'x'", "who opened…", and "what did … ask".
- **Why only compliance:** only compliance can search the audit. Everyone else gets exactly the reply they got
  before, so scenario 3's fixed reply stays the same whatever was asked.
- **Trade-off:** a fixed list of patterns misses some audit questions. The console is one click away either way, and
  a node check shows the hint never fires on the scenarios' document questions.

### D60 — Routine sync checks are hidden by default
- **What they are:** syncs that re-read a document and found neither its content nor its permissions changed.
  - **How many:** a Supabase-backed API logs one per document at every restart. Live sources log one per unchanged
    item at every full re-read, which runs hourly.
- **Chosen:** a **Hide routine sync checks** toggle, on by default. It applies to whatever list is on screen, the
  whole log or a search's results, and says how many entries it hides.
- **Unchanged:** the entries stay in the log and the hash chain. The search still returns every match, the proofs
  cover every entry, and the CSV export writes every entry. The toggle only changes what the table shows.

### D61 — Browser checks stay outside the repository
- **Chosen:** as with D35, the browser checks (Playwright in Chromium, against the public demo) stay out of the
  repository. The new logic gets unit tests in `apps/web/answer.nodecheck.js`, which `pnpm test` runs.
- **Trade-off:** CI doesn't check the pages in a browser. Each round checks them by hand.

### Implementation details (UI fixes, round 1)
- **One module for the logic:** `apps/web/answer.js` touches no page, so `node --test` checks it.
  - **What it holds:** `numberSources`, `answerLines`, `quotedRanges`, `isDemoAddress`, `looksLikeAuditQuestion`,
    `auditSummary` and `isRoutineSync`.
  - **Tests:** nine node checks, each written and seen failing before the code.
- **Numbering:** citations come one per passage, so a document cited for two passages keeps one number. Numbers
  follow the order the answer first cites each document. A marker that names no cited passage stays as text.
- **Highlighting:** a kept line is the source's own sentence, except Jira lines, which carry the status the brain
  adds: "DB-12 (in progress) tracks…" or "DB-15 (blocked): …".
  - **How lines are found:** the sentence as written first, then without the status, ignoring differences in
    spacing.
  - **Tests:** the node checks use the real DB-12 and DB-15 text.
- **Opening a source:** a chip or a source opens the document in the workspace.
  - It marks the quoted lines, centres the first one, and moves keyboard focus to the document's heading.
  - A Jira task's working doc opens the same way.
- **Progress:** the chat and the catch-up show a spinner and the seconds since asking.
  - Screen readers don't hear the counter. In the chat they hear the existing status line when the question starts
    and ends. The catch-up has no such line, before or after this round.
  - The spinner turns only when the system allows motion.
- **Audit lines:** each of the 37 event types the API writes has a line of its own. A node check fails when a new
  type has none.
  - **Left out of the line:** references that only tie entries together: docRef, chunkRef, fromRef, checkpointRef,
    traceId, orgId and questionHash.
  - **Raw data:** each row writes out its full entry, hashes included, only when opened.
- **Accessibility:** axe (WCAG 2.0 and 2.1, A and AA) ran on `main` and on this branch.
  - **New violations:** none, in any screen both builds have.
  - **What both builds share:** the same colour-contrast failures, 26 on the workspace screen, mostly from the
    app's shared grey (see Deferred).
  - **Targets:** chips and source buttons are at least 24 px (WCAG 2.2, 2.5.8).
  - **The demo note:** it is darker than the shared grey, at 5.2:1.
- **Phone width (400 px):** no screen scrolls sideways. The audit table keeps a minimum width and scrolls inside its
  frame.
- **Screenshots:** the seven worked-example screenshots and the two README workspace screenshots were re-taken. Answers
  now show chips, and demo documents no longer show a link.

## 2026-10-04 — The answer checker

- **Input:**
  - **The brief:** "Mitigate hallucination and the model 'filling in' content it wasn't given."
  - **The MVP must-haves:** "an output checker for hallucination".
  - **The 2 Oct review:** the old check kept only lines copied word for word. Faithful rewording was lost, the
    model's instructions had to forbid it, and a removed line left no trace for the asker or the audit.
- **How decided:** planned with its validation tests, then chosen explicitly in a planning session.

### D62 — Rules, not a second model, judge a reworded line
- **Options:**
  - **Rules:** every clause must be backed by one sentence of a passage the line cites.
  - **Rules plus a second model call:** a model judges each line the rules pass.
- **Chosen:** rules only.
  - **What a second model call would cost:** several seconds on answers that already take about 15, the free
    allowance used twice, and no verdict a test can pin down.
  - **What the rules give:** they are explainable and tested line by line, and each removal says what was wrong.
- **What a kept line must keep:** the numbers, next to the same words; the names, keys, dates and quantities; and the
  same status, order (before or after), comparison, negation and hedging. It may add no other word that carries
  meaning. Word forms and a short list of synonyms count as the same word.
- **Measured** (4 Oct, on the 26 demo passages):
  - **The rule set:** 54 lines, all right. The word lists and limits were set against these.
  - **Generated changes:** every sentence of every passage is kept as written, and each of 58 one-fact changes
    (number, key, name, negation, status, before or after) is left out.
  - **A held-out set:** 32 lines written before any tuning. Of 15 lines to remove, the checker keeps one (B15, two
    steps in the opposite order). Of 17 lines to keep, it removes three:
    - B5: "final wave" for "wave three";
    - B16: "every morning" for "each morning";
    - B23: "leave … out" for "do not include".
  - **One more line, B22,** found a hole in the old word-for-word rule: a copied part of a sentence could drop the
    "not" in front of it ("Include this channel" from "Do not include this channel"). That was fixed, so B22 no longer
    counts as unseen.
- **Known gaps:** each is a failing test (`it.fails`) that turns red once fixed.
  - who did what, swapped within one sentence;
  - cause and effect turned around;
  - a requirement read as done ("Complete SEC-44 …" becoming "SEC-44 is complete");
  - two steps in the opposite order;
  - a faithful line that uses a word the passage doesn't (the cost of strictness).

### D63 — The asker sees a count and a reason; the audit keeps the text
- **Options:** a count and a reason; the removed text too, struck through; or nothing.
- **Chosen:** a count and a reason, such as "2 lines left out: they had a name, number or date the source doesn't".
  The text, the reason and what was wrong go into the audit's `answer_returned` entry for compliance.
- **Why:** a removed line is model text that no source backs, so it never appears in an answer, even marked as
  removed.
- **After a fallback (D29):** the model's removed lines go to the audit only. Telling the asker about them would say
  which writer answered, which D57 left for later.

### D64 — The model may reword lightly
- **Options:** keep copy-exactly, or allow light rewording now that it's checked.
- **Chosen:** light rewording. The model may shorten a sentence or join two from one passage, keeping every name,
  number, date, issue key and status word exactly, and adding nothing.
- **Trade-off:** more lines may be left out, and so more answers may fall back. `pnpm llm:check` measures this on the
  real model, and the instruction can be reverted on its own.

### D65 — A branch of its own, on top of the UI fixes
- **Chosen:** `feat/answer-checker`, stacked on `fix/workspace-ui`. Both are pushed, and the UI one is merged first.

### Implementation details (the answer checker)
- **Where:** `checkAnswer` in `packages/retrieval/src/grounding.ts`. `groundedOutput` now wraps it, so every writer's
  reply goes through it, the built-in writer's included (all its lines are copied).
- **Each line:**
  1. Every citation marker must name a passage the writer was given.
  2. Each sentence is checked on its own, and a marker that backs nothing is dropped from the line.
  3. A sentence copied from a cited passage is kept as copied, if it means what its whole sentence means.
  4. Otherwise the sentence is split into clauses at commas, semicolons, colons and joining words. Each clause must be
     backed by one sentence of a cited passage.
- **Issue status:** a clause that only gives an issue's status ("DB-12 is blocked") must match the label the brain
  writes into that issue's text, or a status word next to the key.
- **The answer:** `QueryAnswer.check` gives each line its kind and the source sentences that back it, and only the
  reasons for what was left out. A no-result answer carries no check, so scenario 3's reply is unchanged.
- **The workspace:**
  - a reworded line carries a "reworded" tag, and its chip highlights the sentences that back it;
  - a note under the answer and the asker's trace give the count and the reason;
  - the audit console's line counts reworded and left-out lines.
- **Tests:** written first and seen failing, in `grounding.test.ts`, `brain.test.ts`, `llm-check.test.ts` and the
  web node checks.
- **Checked in the browser** with a stand-in model that mixes copied, reworded and invented lines:
  - the tag, the highlight and the note;
  - David's trace, without the removed text;
  - Nur's raw entry, with it;
  - no new axe violations.
- **`pnpm llm:check`:** prints the verdict on every line of a real model's replies, for the team to label.

## 2026-10-04 — Contrast and the workspace build

- **Input:** the two items left under Deferred by UI round 1, measured on 4 Oct.
  - **Contrast:** axe found 379 colour-contrast failures, all "serious", on 12 of 14 workspace screens. The earlier
    runs covered 7 screens; this one added Sync health, Admin, the connectors page, the asker's trace, the catch-up,
    the merge preview, and the empty lists a contractor and an intern see.
  - **The build:** three builds in a row left three nested copies, each adding 8 files, 354 KB and 10 characters to
    the longest path.
- **How decided:** the measurements and a before-and-after screenshot were laid out, and the user chose to fix both
  now, before the demo video.

### D66 — Secondary text uses the theme's muted grey
- **Options:**
  - darken each failing grey just enough, keeping eleven shades;
  - use the theme's own `--muted-foreground` (#61717f) wherever secondary text appears;
  - leave it.
- **Chosen:** the theme's grey, at 4.6–5.0:1 on every background the app uses. One shade replaces eleven, so a new
  rule is less likely to pick a faint one. The green section labels darken from #388065 to #33775d.
- **Trade-off:** secondary text is a little darker, so it recedes a little less. Size, weight and spacing still set
  it apart.

### D67 — The workspace build doesn't copy `public/`
- **Options:** `publicDir: false`; a separate folder for the workspace's own static files; or leave it.
- **Chosen:** `publicDir: false`. `public/` holds no tracked files, only the published workspace, so the copy only
  ever duplicated the last build.

### Implementation details (contrast and the workspace build)
- **The rules changed:**
  - in `apps/web/src/ui.css`: the brand subtitle, the project and persona labels, the search placeholder and shortcut
    key, the header's context label, the section labels, item and detail metadata, `.muted`, and the breadcrumb;
  - in `apps/web/styles.css`: the landing-view label, empty lists, Sync health's architecture notes, and the trace's
    times.
- **`styles.css` carries the grey as a fallback** (`var(--muted-foreground, #61717f)`), because `connectors.html`
  loads that file without `theme.css`.
- **The demo note's own darker grey,** added in UI round 1, is gone: the shared grey now passes on the panels' tints.
- **Checked in the browser:**
  - axe (WCAG 2.0 and 2.1, A and AA) finds no contrast failures, and no other violations, on the 14 screens;
  - the search placeholder, which axe doesn't check, goes from 2.83:1 to 4.68:1;
  - the UI fixes' 66 browser checks and R9's 24 still pass.
- **The build:** three builds in a row leave the one bundle, file for file the same as before. The first build after
  the change also clears the copies already there, because `scripts/publish-workspace.mjs` empties the folder first.
- **Screenshots:** six worked-example screenshots and the two README workspace screenshots were re-taken. The audit
  console's didn't change.

## 2026-10-04 — Tighter search

- **Input:** the generated dataset (about 500 items) will be full of status, blocker and project lines from other
  projects. Measured on the demo data with every test question:
  - **Scenario 1** sent three tangents to the writer. The payment master page and SETL-27 share only "migration" with
    the question, and the steering deck only "project".
  - **Scenario 2** sent two: #sec-incident, which shares only "incident", and #payments-cutover, which shares only
    "runbook".
- **How decided:** the user asked to tighten search on 4 Oct. The rules were planned from the measurements and chosen
  in a planning session. D49 isn't revisited.

### D68 — A question that names a project keeps to it
- **Options:**
  - search everything, as before;
  - scope only through the workspace's catch-up (R9);
  - scope any question that names a project the asker can open.
- **Chosen:** any question.
  - **When a project counts as named:** every distinctive word of its master page's title is in the question, and only
    one project matches.
  - **Access:** the master page goes through the normal, audited access check first. A project the asker can't open
    changes nothing, and its refusal stays out of their own trace.
- **Why not more:** when two projects are named there's no scope, rather than a guess.

### D69 — A match must cover at least half of what the best match covers
- **Options:**
  - drop matches that score under half the best score (planned in R10);
  - drop matches that cover fewer than half as many distinctive words, rounded up, as the best match;
  - both.
- **Chosen:** coverage.
  - **A score floor fails here:** at half the best score it would keep #sec-incident, at 0.68 of the best, because
    the score barely rewards matching more of the question.
  - **The coverage rule works:** it drops both scenario 2 tangents and keeps every required item. DB-15 covers 2 of 3
    words, the PAY-101 sources 1–2 of 2, and the catch-up's chargeback guide 1 of 2.
- **Where it applies:** outside a project scope only, and to search matches only. Linked items keep their own rule,
  and links are followed only from matches that stay. Superseded copies don't set the bar unless the question asks
  for history, since they're set aside later anyway.
- **No side channel:** the bar is computed only from matches the asker may open.
- **Matches by meaning:** one found by meaning alone stays if it is at least as close as the closest match that clears
  the bar. With no word in common anywhere, meaning decides alone. This isn't measured on real vectors yet, because the
  sandbox can't reach Cloudflare.

### D70 — Generic work words count less
- **Chosen:** a fixed list of words that name no topic, with their plurals: status, update, project, plan, team, issue,
  task, ticket, raised, need, note, progress, work, item, page, doc, document, file, channel, thread, new, first, read,
  help, info.
- **What they do:**
  - never make a match on their own, unless the question has nothing else;
  - count a quarter as much in the score;
  - don't count toward coverage.
- **Synonyms:** a word and its synonyms now count once. Before, "payment" counted as three topics.
- **Why a fixed list:** word statistics over the whole index would let restricted documents shape what others see
  (R10).
- **Trade-off:** the list is a judgment call. "Blocker" stays off it, because "blockers raised in Slack" is a real
  topic. A noise test guards the effect.

### Implementation details (tighter search)
- **Retrieval:** `queryConcepts`, `distinctiveWords` and the `GENERIC` list are in `packages/retrieval/src/index.ts`.
  Each hit reports `coverage` and, when it has one, `semantic`. Supabase results take theirs from the local hit.
- **Brain:** `namedProject` and `coveringHits` are in `apps/api/src/brain.ts`. Projects are counted the way
  `projectsFor` counts them, over the index.
- **Tests:**
  - **Retrieval:** synonyms count once, a generic word alone makes no match, the weighting, and the reported coverage
    and semantic score.
  - **Scenarios:**
    - the scope;
    - a hidden project, and two projects named;
    - scenario 2 sends the runbook alone;
    - a denied document can't raise the bar;
    - project items that match one word stay;
    - a noise test that adds another project's status, blocker and incident lines David can open.
  - **`coveringHits`:** unit tests. The one for matches by meaning was confirmed by breaking the rule on purpose.
- **Effects on the worked examples:**
  - Scenario 1 keeps its four cited lines and reads "kept to Database migration plan".
  - Scenario 2 cites the runbook alone.
  - Scenario 4 ends on the wave checklist instead of the payment master page.
  - Scenario 5 finds fewer entries.
  - `docs/worked-examples-model.md` was captured before this round.

## 2026-10-04 — The generated dataset

- **Input:** the 26 hand-written items can't show search, permissions or the workspace at a realistic size, and the
  brief describes a company with 50 spaces, about 12,000 pages and 600 colleagues. A CodeBuddy session was tried first
  and stopped after it went outside its task, so this set was built without it and doesn't count as CodeBuddy
  evidence.
- **How decided:** the specification was written and reviewed in planning sessions. On 4 Oct the user chose the dataset
  alone for this branch, with loading it into the demo next, and chose to skip the repeated-sentence limit at the
  brief's scale.

### D71 — A seeded generator, checked by the app's own rules
- **Chosen:** `data/generate.ts` builds the set from hand-written content banks with one seeded random generator.
  `validateCorpus` judges it with the app's own code, imported rather than copied: the access check (`FgaAdapter`),
  the link reader (`linksIn`, `linkFromUrl`), the search words (`terms`, `queryTerms`) and the workspace functions
  (`projectsFor`, `duplicatesFor`, `agreementSummary`, `tracked`).
- **Why:** rules written down in prose drift from the code; a validator that calls the code can't. If the app changes
  how it reads links, agreements or duplicates, `pnpm test` names the generated items that no longer fit.
- **Reproducible:** the same seed gives the same bytes on any machine. Lists are sorted by code unit, never by locale;
  nothing reads the clock or the time zone; dates are whole hours before 30 Sep 2026, as the hand-written fixtures are.
- **The test:** the committed files equal a fresh run (with CRLF read as LF), the validator finds nothing at either
  scale, and five deliberate breaks are caught.

### D72 — Six projects, five company areas, and who can open what
- **Sizes, demo scale:** 500 items: 149 Confluence pages, 140 Jira issues, 60 Slack channels and 151 Drive files (70
  Docs, 40 Sheets, 30 Slides and 11 PDFs).
- **Projects:** build pipeline upgrade (PLAT), mobile app 4.0 (MOB), customer data warehouse (DATA), KYC review
  automation (KYC), corporate card rewards (CARD) and partner API integration (VEND). Each has a master page, a Jira
  project, channels, and Drive files reached from the master page or an issue, so the workspace counts them. The other
  areas have no master page: engineering, legal, people, company and interns.
- **People:** the six personas, whose extra groups (platform, sre, mobile, data, eng-leads, risk and legal) come only
  from `persona-groups.json`; 55 colleagues in teams by fixed quotas, four of them interns and two of them mentors; and
  five contractors.
- **Contractors are in no team:** they reach an item only when it names them, so no team's list ever carries a
  contractor. The validator checks that a contractor appears only where named, and never on a restricted item.
- **Access:** native lists hold the granted teams' members plus the people named. Company items and the ten HR
  policies are public. Legal, pay and eight KYC audit items are restricted to legal, people-ops or risk. The examples:
  #plat-leads is private without David, a DATA page is restricted to risk, a VEND page is for eng-leads only, and
  #mob-war-room is private with Maya.
- **What each persona can open:** Ravi 194, Maya 283, Alex 39, David 267, Nur 107 and Wei Ming 17, all within the
  planned ranges.

### D73 — What the set never says
- **The hand-written story's words**, and the words search treats as them (switch, launch, outage, recovery), so no
  generated item enters a scenario's answer. They are checked with `terms()`, including each part of a hyphenated
  word. With both sets indexed, no generated item survives the search rules for any scenario question.
- **Months, dates, years and quarters**, because loading moves `updatedAt` to the demo day but can't move a date in
  the text.
- **A speaker's name at the start of a Slack line**, because agreements count only at the start of a sentence.
- **For Alex and Wei Ming:** none of the scenario 3 words (security, incident, report, breach, Q3, onboarding,
  notes), and no title, key, channel or project name of anything they can't open.
- **Statuses that disagree:** "KEY is ...", and lines starting Blocker, Done, In review, Planned and the like, must
  match the issue.
- **Repetition:** no sentence of six or more words appears in more than three items, apart from copies and the
  agreements issues quote. Plain sentences come first; openers such as "In practice," only once a plain sentence is
  used up, and never twice in one item. A thread quotes each colleague once.

### D74 — The brief's scale, in memory
- **Chosen:** `pnpm dataset --scale brief` adds 24 generated projects and 15 team spaces, for 19,703 items (11,999
  pages, 4,508 issues, 195 channels and 3,001 Drive files) and 600 colleagues. It is checked in memory and never
  written.
- **Checks at this scale:** everything except the persona ranges, the leak check, the pairwise duplicate check and the
  repeated-sentence limit. The user chose to skip the last one: the generated projects share sentence patterns, and
  holding the limit at this size would need 24 more hand-written banks.
- **Time:** about six seconds on the development machine. `pnpm test` runs it.

### Implementation details (the generated dataset)
- **Layout:** `data/dataset/` holds `random.ts` (mulberry32 and code-unit sorting), `rules.ts` (the fixed rules and
  word lists), `people.ts`, `types.ts`, `banks/` (one file per area), `write.ts` (ways to say a fact, and the repeat
  limit), `build.ts`, `generic.ts` (the brief's extra projects) and `validate.ts`. The plan had one file; it was split
  so each part can be reviewed alone.
- **Two passes:** every item's id, readers, date and links are planned before any text is written, so an item names
  another only when everyone who can read the first can read the second.
- **Duplicates on purpose only:** a superseded copy changes named facts, and a near-copy rewrites its first sentence.
  Drive files on one topic spread over its facts before reusing one, so no other pair reaches the workspace's 60%
  overlap.
- **Found while reading samples:**
  - Some facts said a change was made while its issue was still in progress, the analyst training guide existed while
    the issue to write it was open, and the mobile status had both platforms in store review while Android was rolling
    out. The banks were corrected so statuses agree in prose too.
  - Status lines that stated a rule rather than progress were replaced by a written status for each project channel.
  - A fact that repeats a decision, a step, a fixed sentence or a quoted agreement in the same item is left out.

---

## Deferred (not decided yet)
These are open. Pick them up in a later round and record the decision here.

- **The model's route:** settled: Groq on both APIs (D54, D55).
- **Hosted SSO next to local SSO work:** the audit chain allows one writer per organization. Either stop the hosted
  SSO API during local `pnpm dev:sso` work, or give it its own Supabase project.
- **Demo state:** the public demo shares one state across all visitors until it restarts. Scheduled restarts or
  per-visitor state aren't decided.
- **Additional features:** done in R9 (D40–D47), except a working duplicate merge, which stays a preview (D43).
- **Brain as an MCP server:** not started; to be written in Rust after submission.
- **Anchor repository:** not created yet; the tool is built (D50).
- **CodeBuddy/WorkBuddy evidence:** must be captured by someone using those products. The project isn't scored
  without it. The generated dataset was built without it.
- **The generated set in the demo:** loading it beside the hand-written items, the scenario tests on both, "Show
  more" for long lists, batched imports and a benchmark.
- **Directory caching:** `UserDirectory.bySub` re-reads the whole directory on every request, and every proxied
  workspace call now triggers it.
- **Ravi persona:** the README says "Head of payments", but the demo script has him as a junior engineer.
- **UI round 1's "not now":** a label for which writer answered, and "Show more" for long lists (D57).
- **Colour contrast:** settled: secondary text uses the theme's muted grey (D66).
- **Workspace build:** settled: the build no longer copies `public/` (D67).
- The other P1 items are also still open: whole-brain JSONB snapshot writes, independent Merkle root anchoring,
  source-specific FGA types, and webhooks. The snapshot write runs after every successful response, `/health`
  included, which matters once the SSO API is reachable from the internet.
