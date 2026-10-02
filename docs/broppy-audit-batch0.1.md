> **History (30 Sep 2026).** This audit describes the repository as it stood then, and most of its items have since
> been resolved. The current design is in [Architecture](architecture.md); later choices are in
> [decisions.md](../decisions.md).

# Broppy (Internal Brain) — Repository Audit

**Repo:** github.com/Danixjg/Broppy
**Commit audited:** `a2d549b` — "feat: brain connection to sources. updates: UI now remastered" (29 Sep 2026)
**Audited:** 30 Sep 2026
**Method:** fresh clone, `pnpm install`, `pnpm typecheck`, `vitest run`, plus reading the source against our project plan.

**Summary:** the core pipeline is further along than our plan expected for week 1, but a clean clone does not build, and three things we agreed on (Auth0 login, onboarding history import, audit completeness) are not there yet. UI is not a priority in this audit.

---

## 1. Blockers (fix first)

### 1a. The live connectors were never pushed

`apps/api/src/server.ts` imports `@brain/connectors/live`, but `packages/connectors/src/live.ts` is not in the repo.

- **Cause:** `.gitignore` is the Visual Studio template. Its line `**/[Pp]ackages/*` (meant for NuGet) silently ignores every *new* file under `packages/`. Older package files only got in because they were committed earlier.
- **Result on a fresh clone:** `pnpm typecheck` fails and `server.test.ts` can't load. The other 63 tests pass. Whoever wrote the live connectors has them locally, but nobody else can run the API.

### 1b. `node_modules/` and `apps/web/dist/` are committed

1,170 files under `node_modules/` are tracked. Every `pnpm install` rewrites them, so every teammate's install shows up as changes and people end up committing each other's dependency trees.

### Fix for both (run by whoever has `live.ts`)

```sh
# replace the VS template with a Node one
printf "node_modules/\ndist/\n.env\n*.env\n*.log\ncoverage/\n" > .gitignore
git rm -r --cached node_modules apps/web/dist
git add .gitignore packages/connectors/src/live.ts
git commit -m "fix: track live connectors; stop tracking node_modules and dist; use Node .gitignore"
```

Then check nothing else under `packages/` is missing with `git status --ignored`.

---

## 2. What's done

### Connectors and data
- [x] Four connectors share one interface (list IDs, list updated since, fetch document, permissions, version, check access, subscribe).
- [x] Each keeps its native permission shape: Slack members/visibility, Jira project and issue viewers, Confluence space and page viewers, Drive owner and sharing.
- [x] Mock corpus: 12 documents and 6 users, including the restricted Q3 incident, SEC-44, `#fraud-ops-private` and a superseded duplicate cutover plan.
- [x] Live HTTP readers for all four platforms (exist locally only — see blocker 1a), using explicit item IDs.

### Sync and indexing
- [x] Resumable incremental sync with cursors, checkpoints and tombstones for deleted items.
- [x] Separate content and permission hashes, so a permission change doesn't re-embed anything.
- [x] Hybrid search (local, plus optional Supabase pgvector with full-text search) using the 0.65 / 0.25 / 0.10 weighting.
- [x] Hunyuan chat and embedding clients.

### Query pipeline (matches our corrected flow)
- [x] Candidate IDs → local grants, intersected with remote FGA when configured → every decision logged.
- [x] Zero allowed → fixed reply, with **no LLM call**.
- [x] Live source recheck per document, which also refreshes a newer version.
- [x] Second access recheck *after* generation, before returning anything (stricter than our plan).
- [x] Output checker keeps only sentences traceable to an authorised chunk.
- [x] Superseded docs excluded unless the question asks for older versions.

### Admin and audit
- [x] Mock admin routes: edit content, narrow permissions, remove a Slack member, narrow a tier, remove a group, preview a user's access. All can only narrow access.
- [x] Audit log with hash chain, Merkle batches, signed roots, per-entry proofs, verify, keyword search, trace view, CSV export.

### Auth
- [x] Auth0 JWT validation on the API and PKCE login code in the web app — groundwork only; not the active path (see section 4).

### Docs
- [x] Architecture diagram, trust-boundary diagram, five-stage plan.

---

## 3. To-dos, in priority order

### P0 — needed for the scored scenarios
1. **Push `live.ts`, fix `.gitignore`, untrack `node_modules` and `dist`** (section 1).
2. **Make Auth0 the login** (section 4).
3. **Audit completeness for scenario 5.**
   - Today questions are stored only as a hash, answers only as citation IDs, and documents as `sha256(docId)`. Nur can't reconstruct "what jdoe asked and was told", and can't filter by the payment-gateway space.
   - Store question text, answer text, doc ID, source and space/project (the audit is already compliance-only).
   - Add a date-range filter and a small step that turns the plain-English question into filters (user, source, space, dates).
4. **Persist the audit to Supabase as it happens.**
   - Today it's in memory or a local JSONL file; the `audit_entries` and `merkle_batches` tables exist but aren't used.
   - Add a trigger that blocks `UPDATE`/`DELETE`.
   - Include the previous batch's root in each batch's signed payload.
   - Anchor signed roots to a separate write-once location (still open).
5. **Persist state.** The index, cursors, grants and sync runs reset on restart. The `connector_state` and `sync_runs` tables exist but aren't used.

### P1 — needed for a believable product
6. **Onboarding with a full history import**, plus the **Connectors settings page** (section 5).
7. **Tenant ID.** Nothing is scoped by company. Add `org_id` to documents, chunks, sync state, audit and users before onboarding a second company.
8. **Contractors are blocked from everything.** `nativeAllows` returns `false` for any contractor, even on items shared with them. Our plan is default-deny *except* explicitly shared items; otherwise contractor Wei can't use the product at all. (Scenario 3 still works either way.)
9. **FGA model is generic.**
   - It only has document readers; native rules are enforced in code. The brief warns against flattening — consider source-specific types (`slack_channel#member`, `jira_project`, `confluence_space`, `drive_folder`).
   - The remote adapter uses a static bearer token. Auth0 FGA uses client credentials — switch to `@openfga/sdk` with the client ID, secret, token issuer and audience from the FGA dashboard.
10. **Webhooks.** Freshness relies on polling (every 5 min live, 30 s mock) plus the live recheck. That meets the brief's "minutes to ~1 hour" window, so lower priority.

### P2 — tidy-ups
11. **Persona mismatch.** Repo: Alex = intern, Wei = contractor, no head of payments. Our script: Alex = contractor, Maya = intern. Pick one and update the demo script.
12. **Missing mock content:** `#sec-incident`, `#vendor-integration` (shared with the contractor), chargeback docs for the intern catch-up, a payment-gateway Confluence space for scenario 5.
13. **Access tiers.** Repo uses `open/internal/restricted`, with "restricted" hard-coded to three groups. Our plan: Team as default, named restricted grants that expire. Fine for the demo; align naming.
14. **Deployment and performance:**
    - API URL hard-coded to `127.0.0.1:3000`; must change to deploy on Tencent Cloud.
    - JWKS keys fetched on every request; cache them.
    - Startup sync blocks the server (see section 5).
15. **Differentiators not started** (Slack "ok" → Jira, task → doc, latest-doc badge, merge) — expected, they're week 3.
16. **CodeBuddy proof.** The repo has `.agents/skills` from another tool. Make sure CodeBuddy/WorkBuddy screenshots are being captured — no score without them.

---

## 4. Integrating Auth0 as the SSO login

### Current state
- The API can validate Auth0 tokens (`apps/api/src/auth.ts`).
- The web app has PKCE code (`apps/web/auth.js`).

### Why it doesn't work yet
- The login page only has the Supabase email/password form.
- In Auth0 mode, users are matched against `users.json` by a fake `auth0Sub` like `auth0|ravi`, which never matches a real Auth0 user ID.
- Live sources need the Supabase user directory, but the code forces Auth0 *or* Supabase, not both.

### Approach
Split the two jobs: **Auth0 answers "who is this"; Supabase's `workspace_users` table holds their role, groups and platform identities.**

### Steps

**1. Set up the Auth0 tenant**
- Create an **API** (identifier e.g. `https://api.internal-brain`, RS256). Short access-token lifetime (5–15 min) so a blocked user loses access quickly.
- Create a **Single Page Application**. Callback and logout URL `http://127.0.0.1:3001/`, web origin `http://127.0.0.1:3001`; add the deployed URL later.
- Connections: a Database connection for the six demo users, plus Google or an enterprise SAML/OIDC connection to show real SSO.
- Turn on **Organizations** and create "Company A". This enables per-company onboarding and SSO later and puts `org_id` in the token.

**2. Database migration** — `infra/supabase/migrations/003_auth0_directory.sql`

```sql
alter table public.workspace_users
  drop constraint if exists workspace_users_auth_user_id_fkey,
  alter column auth_user_id drop not null,
  add column auth0_sub text unique,
  add column org_id text,
  add column active boolean not null default true;
```

(Or create a fresh `workspace_users` keyed by `auth0_sub` if nobody depends on the Supabase Auth data yet.)

**3. Seed script** — rewrite `data/seed-supabase-users.ts` as `seed-auth0-users.ts`:
- use a Machine-to-Machine app with the Management API to create the six users with the **same emails** as their `platformIdentities`;
- add them to the Organization;
- write their `auth0_sub` into `workspace_users`.

**4. API changes**
- Split `supabase-users.ts` into a `UserDirectory` that reads `workspace_users` with the server key (`bySub(sub)`, `list()`).
- `Auth0TokenValidator` looks users up through the directory instead of fixtures; reject if not `active` or `org_id` doesn't match.
- Replace the hand-rolled JWKS code with `jose` (`createRemoteJWKSet` + `jwtVerify`) — caches keys and handles rotation.
- In `server.ts`, remove the "choose Auth0 or Supabase" error; delete the `SUPABASE_AUTH_*` path.
- The existing "revalidate user before returning output" hook then covers offboarding: set `active = false`, or block the user in Auth0 and let the short token expire.

**5. Web changes**
- Replace the form in `login.html` with one **"Sign in with SSO"** button that calls the existing PKCE flow in `auth.js` (or switch to `@auth0/auth0-spa-js` for silent token refresh).
- Fill `issuer`, `clientId`, `audience` in `auth-config.json`; remove the `supabase` block.
- Delete `supabase-auth.js` and its check.

**6. Environment**
- Keep/add: `AUTH0_ISSUER`, `AUTH0_AUDIENCE`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (directory).
- Remove: `SUPABASE_AUTH_URL`, `SUPABASE_AUTH_SECRET_KEY`, `SUPABASE_AUTH_PUBLISHABLE_KEY`.

**7. Tests** — update `auth.test.ts` to use a fake directory; add cases for inactive users and wrong organisation.

**8. Optional: per-user source tokens.** Live access checks use per-user tokens pasted into `LIVE_SOURCES_JSON`. Auth0's Token Vault (part of Auth0 for AI Agents) is designed to store each user's connected Slack/Google/Atlassian tokens and could replace that JSON. Check availability on your plan first. Mock connectors don't need it.

---

## 5. Onboarding: import each company's full history

Currently the live connectors only read IDs typed into an environment variable — no discovery, no pagination, only the latest 100 Slack messages. A new company would start with an empty brain, so this step must be explicit.

### Flow, as a company admin sees it
1. Admin signs in with SSO; the Auth0 Organization is created and they become org admin.
2. **Connect sources** via OAuth: Slack app install, Atlassian 3LO (Jira + Confluence), Google OAuth (or domain-wide delegation for a whole Workspace).
3. **Choose scope:** which channels, projects, spaces and drives, and how far back (e.g. 12 months). Private channels and restricted spaces are included only if the connected app can see them.
4. **Initial import** runs in the background with progress per source.
5. **Map people:** match users across platforms by email; flag anyone unmatched. Unmatched people get no access to that source (fails safe).
6. **Ready:** each source switches to incremental sync (cursors, webhooks later).

### What the import job does, per source
- Discover all item IDs in scope, with pagination and rate-limit backoff.
- For each item: fetch content and native permissions, chunk, embed, write to Supabase, write FGA tuples, audit-log it. (Same `syncSource` logic that already exists — the job feeds it every ID instead of changed ones.)
- Checkpoint after each batch into `sync_runs`, so a crash or rate limit resumes rather than restarts.
- Record counts: found, indexed, skipped (e.g. binary files), failed with reason.

### Code changes
- Add `discover(scope)` to the connector interface (mocks return everything; live connectors paginate).
- New tables:
  - `organizations`
  - `source_connections` (org, source, status, scope, encrypted tokens in Supabase Vault, connected by, connected at)
  - `import_jobs` (org, source, status, totals, progress, started, finished, error)
- Move the startup `brain.syncAll()` out of server boot into a job runner — a real import can take hours and must not block the API.
- While an import is running, answers say e.g. "Import 64% complete — answers may be missing older material".
- Audit events: `connection_created`, `import_started`, `import_completed` (with counts), `connection_removed`.
- **Disconnecting** a source deletes its documents, chunks and FGA tuples, and logs it.

### API routes
| Route | Purpose |
| --- | --- |
| `GET /v1/admin/connections` | Status of all four sources |
| `POST /v1/admin/connections/:source/authorize` | Start OAuth redirect |
| `GET /v1/admin/connections/:source/callback` | OAuth callback |
| `PUT /v1/admin/connections/:source/scope` | Set scope |
| `POST /v1/admin/connections/:source/import` | Start or re-run the import |
| `GET /v1/admin/import-jobs` | Import progress |
| `DELETE /v1/admin/connections/:source` | Disconnect and purge |

### Settings / Connectors page (admin only; keep it plain)
- One row per source: status (Not connected / Connected / Importing x% / Live / Error), last sync, item counts, scope summary.
- Buttons: Connect, Edit scope, Re-sync, Disconnect.
- "People matching" section listing unmatched users.

### For the demo
Add an **"Onboard Company A"** action that runs the full import from the mock connectors with visible progress. It answers "how does a new company start?" without real OAuth apps.

---

## 6. Suggested order (this week and next)

1. Push `live.ts`, fix `.gitignore`, untrack `node_modules`/`dist` (today).
2. Auth0 login plus the user directory.
3. Audit persisted to Supabase with question and answer text, space and date filters (scenario 5).
4. Persist the index, sync state and grants.
5. `org_id`, the import job, and a bare connectors page.
6. Then FGA model types, contractor sharing, and the week 3 differentiators.
