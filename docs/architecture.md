# Internal Brain MVP architecture

## Run locally

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

The API binds to `127.0.0.1:3000`. In another terminal, run `pnpm --dir apps/web dev` and open `http://127.0.0.1:3001`.

## Core path

The MVP uses one TypeScript gateway and four implementations of one connector contract. Source IDs, content, permissions, and versions stay separate. A headless sync orchestrator consumes changed IDs and compares live IDs with indexed IDs to detect deletions. The index hashes content, permissions, and metadata separately; only content-hash changes refresh chunks and embeddings.

Retrieval returns document and chunk IDs before authorization. The FGA adapter checks document IDs before context construction. The gateway then performs a live source access/version re-check for selected documents. Newer source versions are indexed before their chunks can be sent to the LLM boundary. The tier policy can only narrow native source permissions. The fixed no-result response covers absent, denied, and deleted material.

`LlmClient` is the boundary for a future Hunyuan client. The local implementation is deterministic and emits cited excerpts. The output checker removes uncited or unauthorized claims.

The audit log is hash-chained and can seal Merkle batches. Proofs verify against a trusted batch root. The current root store is process memory; an external append-only root store and signing key are needed before claiming tamper resistance across restarts.

## API

- `GET /health`
- `POST /v1/query` with `{ "question": "..." }`
- `GET /v1/workspace`
- `POST /v1/admin/content`
- `POST /v1/admin/permissions`
- `POST /v1/admin/tier`
- `POST /v1/admin/sync`
- `GET /v1/admin/preview?user=alex`
- `GET /v1/audit`
- `POST /v1/audit/seal`
- `GET /v1/audit/proof?sequence=1`

Set `x-demo-user` to one of `ravi`, `maya`, `alex`, `david`, `nur`, or `wei`. Admin actions require Maya. Audit actions require Nur.

## Assumptions

Mock identities represent Auth0 subjects but are trusted only on the loopback development server. The server refuses to start with `NODE_ENV=production`. Source permission changes made through the mock admin endpoint simulate source-side changes. Sync and audit data are lost on restart.
