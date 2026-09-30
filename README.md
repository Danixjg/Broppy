> **Current sign-in setup:** The official Auth0 Next.js SDK now replaces browser PKCE and public auth configuration. Start at [Auth0 setup, checklist and troubleshooting](apps/web/AUTH0.md). The website requires SSO: run the API with `pnpm dev:sso`, which reads the root `.env.local`. `pnpm dev` still explicitly enables demo authentication for direct local API testing. Project decisions are logged in [decisions.md](decisions.md).

# Internal Brain

A permission-aware knowledge workspace over Slack, Jira, Confluence, and Drive data. Local fixtures are the default; opt-in live connectors read configured items from all four providers. It runs as a pnpm TypeScript workspace with a Node API and a Next.js web host. Vite builds the existing workspace UI served by that host. The web header and navigation use React with shadcn components; the workspace views still use the existing JavaScript controller. The default search is an in memory sparse term vector, keyword, and freshness index. Optional Hunyuan embeddings add semantic vectors, and optional Supabase uses pgvector and Postgres full text search. A remote FGA adapter can also be selected with environment variables; the default path uses in process grants.

## Run

Use Node with `pnpm` 9.15.0.

```sh
pnpm install
pnpm typecheck
pnpm test
```

**Website (SSO).** Copy `.env.example` to `.env.local` at the repository root and fill it in; see [Auth0 setup](apps/web/AUTH0.md). Then, in two terminals:

```sh
pnpm dev:sso               # API at http://127.0.0.1:3000 in Auth0 mode, reads .env.local
pnpm --dir apps/web dev    # web host at http://127.0.0.1:3001
```

Open `http://127.0.0.1:3001`. The web host forwards API requests server-side with the signed-in user's Auth0 token.

**API only (demo headers).** `pnpm dev` starts the API at `http://127.0.0.1:3000` with demo header authentication enabled and loads no env file. Use it with curl as shown below; the website cannot use this mode. `pnpm exec tsx data/seed.ts` prints fixture counts; it does not seed a database. `GET /health` reports local sync cursors, pending runs, and audit counts.

For a direct query without the web app:

```sh
curl -s http://127.0.0.1:3000/v1/query \
  -H 'content-type: application/json' -H 'x-demo-user: ravi' \
  -d '{"question":"What does PAY-101 need before cutover?"}'
```

## Demo users and scenarios

| User | Role | Useful scenario |
| --- | --- | --- |
| Ravi (`ravi`) | Head of payments (member), payments/security/fraud groups | Ask about PAY-101, SEC-44, and the cutover plan; Maya can remove his Slack channel membership to show a live access change on the next query. |
| Maya (`maya`) | Admin | Edit mock source content, narrow a tier, revoke brain grants, remove a group or native Slack channel member, run sync, and preview access. |
| Alex (`alex`) | Intern | Try a security or restricted incident query; the fixed no-result reply conceals inaccessible results. Catch up on the open steering deck and chargeback guide. |
| David (`david`) | Member, payments/security | Compare accessible payment and security material with Ravi's view. |
| Nur (`nur`) | Compliance | Inspect and search audit events, seal a batch, inspect and verify a proof, view traces, and export CSV. |
| Wei Ming (`wei`) | Contractor | Access explicitly shared vendor integration material; payment/security material remains denied. |

In the default demo, changes made through admin routes alter only the running mock process and reset on restart. Content edits increment a source version and sync immediately. A permission edit changes grants without rebuilding chunks. Sync also compares source IDs and tombstones deleted fixtures. Search finds candidate IDs before permission checks; the API checks selected documents against the source before building answer context and again after generation, before returning it. A revoked item causes a fixed no-result response on that query. In live mode, change source permissions and content at the provider.

With `HUNYUAN_EMBEDDING_API_KEY`, sync embeds changed document chunks and a query embeds its question. With `SUPABASE_URL` and `SUPABASE_SECRET_KEY` as well, sync writes documents and changed chunks to Supabase and queries its `hybrid_search` RPC. The RPC returns candidate document and chunk IDs and scores; local and optional remote authorization plus live mock source checks still run before content enters an answer. Query embedding or Supabase search failures fall back to the local index. Embedding or Supabase **sync write** failures fail that sync run for retry; initial sync runs in the background. Supabase configuration enables durable index/grant snapshots, cursors, checkpoints, connections and import jobs.

## API routes

All `/v1` routes require either a valid bearer token configured as below or, in local demo mode, `x-demo-user`. The website uses the official Auth0 Next.js SDK with server-managed sessions. Set the Regular Web Application credentials in `.env.local`; Supabase holds the server-only user directory. Browser API requests go through `/api/brain/*`, which attaches the SDK access token server-side. `GET /health` does not require identity. See [Auth0 sign-in and live sources](docs/live-sources-and-sign-in.md) for setup.

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
| `GET /v1/audit/search` | Compliance query and filters: `q`, `user`, `source`, `space`, `from`, `to`. |
| `GET /v1/admin/connections`, `GET /v1/admin/import-jobs` | Admin connector status and progress. |
| `POST /v1/admin/onboard` | Background full mock Company A import. |
| `POST /v1/admin/connections/:source/authorize`, `GET .../callback` | Start OAuth and complete its single-use callback. |
| `PUT /v1/admin/connections/:source/scope`, `POST .../import`, `DELETE /v1/admin/connections/:source` | Scope, reimport, disconnect and purge. |
| `POST /v1/audit/seal` | Compliance Merkle seal of unsealed events. |
| `GET /v1/audit/proof?sequence=1` | Compliance proof for a sealed event. |
| `POST /v1/audit/verify` with `{ "sequence": 1 }` | Compliance chain, batch, and proof verification. |

## Environment

| Variable | Use |
| --- | --- |
| `ALLOW_DEMO_AUTH=true` | Allows `x-demo-user` outside `NODE_ENV=production`; the root `pnpm dev` script sets it. |
| `AUTH0_ISSUER`, `AUTH0_AUDIENCE`, `AUTH0_ORG_ID` | Auth0 SSO with cached JWKS, active directory lookup and organization validation. Requires Supabase directory/persistence and an audit signing key. See [setup](docs/live-sources-and-sign-in.md). |
| `HUNYUAN_API_KEY`, `HUNYUAN_MODEL` | Together select the Hunyuan chat client instead of deterministic local excerpts. Setting either one alone causes startup configuration failure. |
| `HUNYUAN_EMBEDDING_API_KEY` | Enables 1024-dimensional Hunyuan embeddings for changed chunks and questions. With no Supabase variables, semantic ranking runs in the local index. It is separate from the Hunyuan chat key. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Server-only directory, audit and state persistence. With embeddings, also enables pgvector search. Apply migrations 001–005. |
| `LIVE_SOURCES_JSON` | Selects real HTTP readers for configured Slack channels, Jira issues, Confluence pages, and Google Drive files. All four source entries, provider credentials, and Auth0 sign-in are required. See [setup and limits](docs/live-sources-and-sign-in.md). |
| `AUDIT_LOG_PATH`, `AUDIT_SIGNING_KEY_FILE` | Together select a flushed JSONL audit file and load a PEM private signing key for Merkle batches. With neither, audit data and roots are in memory. Setting a log path without a key fails startup. |
| `WEB_ORIGIN` | API `Access-Control-Allow-Origin` value; defaults to `http://127.0.0.1:3001`. CORS allows the demo and Authorization headers. Set server-side web `BRAIN_API_URL` separately. |
| `FGA_API_URL`, `FGA_STORE_ID`, `FGA_MODEL_ID`, `FGA_CLIENT_ID`, `FGA_CLIENT_SECRET`, `FGA_API_TOKEN_ISSUER`, `FGA_API_AUDIENCE` | OpenFGA SDK client credentials; install the model before enabling. |
| `SOURCE_OAUTH_JSON`, `API_ORIGIN` | OAuth app configuration and API callback origin. Tokens use Supabase Vault. |
| `HOST`, `PORT` | API bind address and port; default loopback port 3000. |

## Deployment status and remaining audit items

Local demo mode remains ephemeral without Supabase configuration. Live identity, provider OAuth, Supabase Vault, pgvector and OpenFGA require externally provisioned services. No live credentials were used in verification. Run one API writer per organization; see [setup and current limits](docs/live-sources-and-sign-in.md).

The compliance audit contains question/answer text and source identifiers. Keep audit access and signing keys restricted. Merkle signatures link consecutive batch roots; an independent write-once root anchor remains an open infrastructure decision. Source-specific remote FGA types, expiring restricted grants and webhooks remain follow-ups identified in the audit. Week 3 differentiators and CodeBuddy/WorkBuddy evidence were not fabricated or implemented as part of this repair batch.

See [audit implementation notes](docs/audit-batch0.1-implementation.md), [architecture](docs/architecture.md), [trust boundary](docs/trust-boundary.md) and [project plan](internal-brain-five-stage-plan.md).
