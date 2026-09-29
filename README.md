# Internal Brain

A permission-aware knowledge workspace over Slack, Jira, Confluence, and Drive data. Local fixtures are the default; opt-in live connectors read configured items from all four providers. It runs as a pnpm TypeScript workspace with a Node API and a Vite web app. The web header and navigation use React with shadcn components; the workspace views still use the existing JavaScript controller. The default search is an in memory sparse term vector, keyword, and freshness index. Optional Hunyuan embeddings add semantic vectors, and optional Supabase uses pgvector and Postgres full text search. A remote FGA adapter can also be selected with environment variables; the default path uses in process grants.

## Run

Use Node with `pnpm` 9.15.0.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

`pnpm dev` starts the API at `http://127.0.0.1:3000` with demo header authentication enabled. In another terminal:

```sh
pnpm --dir apps/web dev
```

Open `http://127.0.0.1:3001`. The web app calls the API at a fixed `127.0.0.1:3000` URL. `pnpm exec tsx data/seed.ts` prints fixture counts; it does not seed a database. `GET /health` reports local sync cursors, pending runs, and audit counts.

For a direct query without the web app:

```sh
curl -s http://127.0.0.1:3000/v1/query \
  -H 'content-type: application/json' -H 'x-demo-user: ravi' \
  -d '{"question":"What does PAY-101 need before cutover?"}'
```

## Demo users and scenarios

| User | Role | Useful scenario |
| --- | --- | --- |
| Ravi (`ravi`) | Member, payments/security/fraud groups | Ask about PAY-101, SEC-44, and the cutover plan; Maya can remove his Slack channel membership to show a live access change on the next query. |
| Maya (`maya`) | Admin | Edit mock source content, narrow a tier, revoke brain grants, remove a group or native Slack channel member, run sync, and preview access. |
| Alex (`alex`) | Intern | Try a security or restricted incident query; the fixed no-result reply conceals inaccessible results. The catch-up action cites only the open cutover steering deck. |
| David (`david`) | Member, payments/security | Compare accessible payment and security material with Ravi's view. |
| Nur (`nur`) | Compliance | Inspect and search audit events, seal a batch, inspect and verify a proof, view traces, and export CSV. |
| Wei Ming (`wei`) | Contractor | Confirm contractor default deny in workspace and query results. |

In the default demo, changes made through admin routes alter only the running mock process and reset on restart. Content edits increment a source version and sync immediately. A permission edit changes grants without rebuilding chunks. Sync also compares source IDs and tombstones deleted fixtures. Search finds candidate IDs before permission checks; the API checks selected documents against the source before building answer context and again after generation, before returning it. A revoked item causes a fixed no-result response on that query. In live mode, change source permissions and content at the provider.

With `HUNYUAN_EMBEDDING_API_KEY`, sync embeds changed document chunks and a query embeds its question. With `SUPABASE_URL` and `SUPABASE_SECRET_KEY` as well, sync writes documents and changed chunks to Supabase and queries its `hybrid_search` RPC. The RPC returns candidate document and chunk IDs and scores; local and optional remote authorization plus live mock source checks still run before content enters an answer. Query embedding or Supabase search failures fall back to the local index. Embedding or Supabase **sync write** failures fail that sync run for retry; a failure during startup sync prevents the API from starting. All cursors and retry checkpoints remain in memory.

## API routes

All `/v1` routes require either a valid bearer token configured as below or, in local demo mode, `x-demo-user`. The blank `apps/web/auth-config.json` selects the demo switcher and header. Filling all three public Auth0 fields selects browser Authorization Code + PKCE login. Filling the Supabase URL and publishable key selects the organisation sign-in page backed by Supabase mock users. `GET /health` does not require identity. See [Supabase sign-in and live sources](docs/live-sources-and-sign-in.md) for setup.

| Route | Purpose |
| --- | --- |
| `POST /v1/query` with `{ "question": "..." }` | Cited answer and `traceId`, or fixed no-result reply. |
| `GET /v1/me` | Validated fixture identity and role for the signed-in web UI. |
| `GET /v1/workspace` | Currently visible mock documents after indexed and live checks. |
| `GET /v1/trace?traceId=...` | Query actor's own trace or a compliance user's trace. |
| `POST /v1/admin/content` with `{ "docId": "...", "content": "..." }` | Admin mock source edit and sync. |
| `POST /v1/admin/permissions` with `{ "docId": "...", "permissions": { ... } }` | Admin narrowing of mock source permissions and sync. |
| `GET /v1/admin/permissions?docId=...` | Admin loads an accessible document's full source permissions for the web JSON editor. |
| `POST /v1/admin/tier` with `{ "docId": "...", "tier": "restricted" }` | Admin tier narrowing. |
| `POST /v1/admin/group` with `{ "userId": "ravi", "group": "fraud-ops" }` | Admin removal of a fixture user from a group. |
| `POST /v1/admin/channel-member` with `{ "userId": "ravi", "docId": "slack:fraud-private" }` | Admin removal of a mock Slack native member and sync. |
| `POST /v1/admin/sync` | Admin manual sync. |
| `GET /v1/admin/preview?user=alex` | Admin visible-document preview with access reasons. |
| `GET /v1/audit` | Compliance events, batches, and chain status. |
| `GET /v1/audit/search?q=denied` | Compliance token-based event search. |
| `POST /v1/audit/seal` | Compliance Merkle seal of unsealed events. |
| `GET /v1/audit/proof?sequence=1` | Compliance proof for a sealed event. |
| `POST /v1/audit/verify` with `{ "sequence": 1 }` | Compliance chain, batch, and proof verification. |

## Environment

| Variable | Use |
| --- | --- |
| `ALLOW_DEMO_AUTH=true` | Allows `x-demo-user` outside `NODE_ENV=production`; the root `pnpm dev` script sets it. |
| `AUTH0_ISSUER`, `AUTH0_AUDIENCE` | Together enable API bearer JWT validation against the issuer's JWKS. Issuer must be an HTTPS origin with trailing `/`; the JWT subject must match a fixture user's `auth0Sub`. Required at startup when demo auth is disabled or `NODE_ENV=production`. Configure the public web fields separately in `apps/web/auth-config.json`; see [web sign-in setup](apps/web/AUTH0.md). |
| `HUNYUAN_API_KEY`, `HUNYUAN_MODEL` | Together select the Hunyuan chat client instead of deterministic local excerpts. Setting either one alone causes startup configuration failure. |
| `HUNYUAN_EMBEDDING_API_KEY` | Enables 1024-dimensional Hunyuan embeddings for changed chunks and questions. With no Supabase variables, semantic ranking runs in the local index. It is separate from the Hunyuan chat key. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Together select the server-side Supabase document/chunk writer and pgvector/full text `hybrid_search` RPC. They require `HUNYUAN_EMBEDDING_API_KEY` and an existing project with `infra/supabase/migrations/001_initial.sql` applied. Partial configuration fails startup. Keep the secret key server-side. |
| `SUPABASE_AUTH_URL`, `SUPABASE_AUTH_SECRET_KEY`, `SUPABASE_AUTH_PUBLISHABLE_KEY` | Select Supabase Auth with server-side `workspace_users` profiles. Apply migration `002_workspace_users.sql`, seed the six mock users, and configure the web publishable key. These are independent of optional Supabase search. |
| `LIVE_SOURCES_JSON` | Selects real HTTP readers for configured Slack channels, Jira issues, Confluence pages, and Google Drive files. All four source entries, provider credentials, and Supabase or Auth0 sign-in are required. See [setup and limits](docs/live-sources-and-sign-in.md). |
| `AUDIT_LOG_PATH`, `AUDIT_SIGNING_KEY_FILE` | Together select a flushed JSONL audit file and load a PEM private signing key for Merkle batches. With neither, audit data and roots are in memory. Setting a log path without a key fails startup. |
| `WEB_ORIGIN` | API `Access-Control-Allow-Origin` value; defaults to `http://127.0.0.1:3001`. CORS allows the demo and Authorization headers. This variable does not change the web app's hard-coded API URL. |
| `FGA_API_URL`, `FGA_STORE_ID`, `FGA_MODEL_ID`, `FGA_API_TOKEN` | Any of these selects the remote FGA adapter in the API. URL, store ID, and model ID are required together; token is optional. Partial configuration fails startup. The API reconciles document grants during sync and intersects remote checks with local decisions. Supply an existing reachable FGA service and installed model; `pnpm dev` does not provision them. |

## Security and persistence limits

This is a loopback demo, not a production deployment. With the blank web auth configuration, the user switcher sends a caller-controlled identity header. Auth0 PKCE and Supabase password sign-in are optional. The admin web view offers a JSON editor for narrowing mock source permissions; live provider permissions must be changed at the provider. Live source connectors use real provider HTTP APIs and delegated user credentials, with explicit item IDs. They do not implement app consent, discovery, token refresh, or webhooks. Optional Supabase and remote FGA require existing external services; neither is provisioned by `pnpm dev`. Local sync state, sparse and semantic index, grants, and mock edits reset on restart. The SQL tables for connector state and audit are not used by the running API.

No real Auth0, Hunyuan, Supabase, source-provider, or remote FGA credentials were available for an end-to-end exercise. The optional paths have code and mock-based tests, not a validated external deployment.

The default audit store resets on restart. The optional file store validates a hash chain and signed Merkle batches, but its roots remain in the same writable local file; no independently controlled append-only root store exists. The answer checker keeps only one-sentence excerpts that appear in an authorized cited chunk; paraphrases are dropped, and this does not establish that the source itself is true. Audit exports and some audit events can contain sensitive identifiers. Keep signing keys and audit files server-side.

See the [architecture diagram](docs/architecture.md), [trust-boundary diagram](docs/trust-boundary.md), and [five-stage plan](internal-brain-five-stage-plan.md). The monorepo outline takes structural inspiration from [Better T Stack](https://www.better-t-stack.dev/) only; this project does not use its scaffolded framework stack.
