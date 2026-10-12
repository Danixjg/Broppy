# Rust domain core

Broppy's retrieval, authorization, answer checking, audit algorithms, task parsing, workspace summaries, and audit search run in Rust. The existing TypeScript entry points call a required native Node-API module. A missing module fails startup with the build command to run.

The Rust workspace contains `brain-core` and the existing `brain-anchor` tool. [Cargo.lock](../Cargo.lock) pins their dependencies. [rust-toolchain.toml](../rust-toolchain.toml) pins the compiler, formatter, and linter.

| Rust module | Responsibility | TypeScript adapter |
| --- | --- | --- |
| `retrieval` | Tokenization, sparse vectors, chunking, index updates, semantic vectors, ranking, fallback writer, SHA-256 | `packages/retrieval` |
| `policy` | Native source permissions, tiers, blocks, expiring exceptions, grant snapshots | `packages/connectors`, `packages/fga-adapter` |
| `links` | Source URL and issue-key parsing, link merging | `packages/connectors` |
| `grounding` | Sentence and clause evidence checks, normalization, citations, rejection reports | `packages/retrieval` |
| `audit` | Hash chains, Merkle roots and proofs, batch checks, JSONL record ordering | `packages/audit` |
| `tasks` | Slack task scores, owners, titles, due dates | `apps/slack` |
| `query` | Source planning, relative time windows, context balancing | `apps/api` |
| `workspace` | Projects, duplicate detection, file scores, agreement suggestions, catch-up and audit summaries | `apps/api` |
| `audit_search` | Query filters, date planning, trace expansion, audit matching | `apps/api` |

The index and local grants each have one authoritative Rust owner. Document reads return defensive snapshots through a `ReadonlyMap` view. Writes use `upsert`, `restore`, `remove`, and `updateLinks`. Asynchronous embedding completions carry a generation number. Rust rejects a completion after the document changes, disappears, or is restored.

Production API queries use `searchAsync`. Rust scans and ranks the stored corpus in a Node-API worker task, with concurrent readers sharing an index read lock. Synchronous helpers remain available for diagnostics and callers that require them. Mutations take the write lock. This moves ranking off the request thread; it does not establish a measured throughput improvement or change the one-writer-per-organization persistence contract. See [Node-API worker tasks](https://napi.rs/docs/concepts/async-task).

Node retains HTTP, Auth0, provider requests, OAuth, Supabase and OpenFGA transport, signing keys, flushed file writes, and persistence queues. JavaScript serializes the exact bytes used by historical audit and document hashes. Rust computes the digests. This preserves JavaScript numeric-key ordering, floating-point formatting, and audit locale ordering across saved state.

Two indexing defects found during the port are corrected. Long unbroken tokens retain every character, and chunks do not split Unicode surrogate pairs. Reimporting an unchanged tombstoned document rebuilds its searchable chunks. Restored sparse vectors with invalid or overflowing weights are rejected before they can reach ranking or replace the live corpus. These behaviors have regression tests in [rust.test.ts](../packages/retrieval/src/rust.test.ts).

Host adapters retain JavaScript date parsing and locale ordering where those behaviors are part of the existing contract. Audit search returns indices into the original entries, preserving their identity and unknown fields. Workspace and task regexes retain the original ASCII case-folding behavior.

Bulk project assignment builds the linked-issue index once per batch. The dataset validator submits all threads together and uses native batch authorization, avoiding repeated full-corpus serialization inside its project loop.

Build and verify from the repository root:

```sh
rustup show
pnpm install --frozen-lockfile
pnpm rust:build
pnpm rust:check
pnpm test
pnpm typecheck
pnpm rust:smoke
pnpm dev
```

Install [Rust with rustup](https://rust-lang.org/tools/install/) if `rustup` is absent. `rustup show` installs the pinned toolchain. The native build needs the platform's C linker and produces `packages/rust-core/brain-core.node`. Generated binaries and Cargo targets are ignored. The build replaces the native artifact atomically so a running process can keep its loaded library.

The API [Dockerfile](../infra/tencent/Dockerfile) builds Rust on Debian Bookworm, then copies the native library into a Node Bookworm runtime. The Slack [Vercel configuration](../apps/slack/vercel.json) builds Rust for its host and includes the library in the function. Enable source files outside the Slack project root as described in [Slack setup](../apps/slack/README.md). The browser application communicates over HTTP and does not load Rust binaries.

Docker startup, Vercel deployment and live Auth0, provider, Supabase and OpenFGA services are covered by mocked behavior tests only. Browser UI and platform transports remain TypeScript; the migrated domain modules run in Rust with no JavaScript fallback.
