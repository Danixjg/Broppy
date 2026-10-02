---
title: "Onyx-Inspired Five-Stage Plan — The Internal Brain"
subtitle: "Aspire FinTech Track · Tencent Cloud Hackathon Singapore 2026"
date: "2026-09-26"
audience: "Internal Brain team — shareable brief"
---

> **History (26 Sep 2026).** This is the original design plan, kept as a record. The current design is in
> [Architecture](architecture.md).

> **Context:** Your team is competing in the Aspire FinTech track of the *AI CAN DO IT — Tencent Cloud Hackathon Singapore 2026*, building **The Internal Brain** — a permission-aware enterprise knowledge system across Slack, Jira, Confluence, and Google Drive. This document captures the Onyx-inspired five-stage implementation plan, drawing on the design patterns from [`onyx-dot-app/onyx`](https://github.com/onyx-dot-app/onyx) (connectors, permission-aware retrieval, hybrid indexing, sync workers) while preserving your original query workflow.

---

## Core principle

**Local hybrid index retrieves → authorize candidate document IDs → check selected documents' source versions → fetch changed content → generate.**

This preserves the original query workflow. The Onyx sync patterns **reduce how often** the live check finds a surprise; they cannot **eliminate** the need for it (e.g., the 2:05 PM runbook case).

## Permission architecture choice

**One TypeScript gateway, four source-specific mappings, FGA batch checks, then the original live source recheck.**

The final decision respects both your tier / block rules **and** the source's native restrictions — for example, marking an item "open" inside the brain must not make a Confluence page readable if Confluence still restricts it.

---

# Stage 1 — Project Skeleton, Data Model & Mock Corpus

> **Objective.** Build a stable foundation that can carry four platforms, permissions, indexing, and audit.
>
> **Repo structure.** Recommended: **pnpm monorepo + Node/TypeScript**.

```
internal-brain/
├── apps/
│   ├── web/                    # Next.js Web App
│   └── api/                    # Node/Fastify API
├── packages/
│   ├── connectors/             # Slack/Jira/Confluence/Drive mock connectors
│   ├── fga-adapter/            # source permission → Auth0 FGA tuples
│   ├── retrieval/              # hybrid search, ranking, context builder
│   ├── audit/                  # audit log + merkle verification
│   └── types/                  # shared domain types
├── data/
│   ├── mock/                   # all 4 platform datasets
│   ├── users.json
│   ├── permissions/
│   └── seed.ts
├── infra/
│   ├── supabase/migrations/
│   └── fga/model.fga
└── docs/
    ├── architecture.md
    ├── trust-boundary.md
    └── diagram-source.mmd
```

**Core domain models** — `User`, `SourceDocument`, `SourceChunk`, `SourcePermission`, `ConnectorState`, `SyncRun`, `AuditEntry`, `MerkleBatch`, `AccessDecision`, `SearchCandidate`.

**Key fields every indexed item should carry** — `docId`, `source`, `sourceNativeId`, `title`, `content`, `url`, `version`, `contentHash`, `permissionHash`, `updatedAt`, `deletedAt`, `metadata`, `permissions`.

**Mock dataset** — Slack channels, Jira `PAY/SETL`, Confluence Payment master page + restricted Q3 incident report, Drive cutover plan + duplicate + recon sheet + steering deck + API specs.

**Permission fixtures** — 6 users (Ravi, Maya, Alex, David, Nur, Wei Ming) each with Auth0 identity, platform identities by email, group memberships, FGA tuples, platform-native permissions.

### Stage 1 acceptance criteria

- Mock data can be loaded locally.
- Each document has content, metadata, version, source URL, and native permissions.
- Each platform answers `listItems` / `fetchContent` / `getPermissions` / `checkAccess` / `subscribeToChanges`.

---

# Stage 2 — Resumable Sync, Permission Sync & Hybrid Index

> **Objective.** Build the Onyx-like knowledge layer: local index, resumable sync, deletion detection, and permission updates without unnecessary re-embedding.

**Connector abstraction** — each connector implements `listIds`, `listUpdatedSince`, `fetchDocument`, `fetchPermissions`, `checkAccess`, `subscribe`.

**Resumable incremental sync** — tables:

- `connector_state` (cursor, lastSuccessfulSyncAt)
- `sync_runs` (checkpoint)
- `source_documents` (contentHash, permissionHash, deletedAt)

Behaviours:

| Event | Action |
|---|---|
| Content changed | Re-fetch + re-chunk + re-embed |
| Permission changed only | Update FGA, **do not re-embed** |
| Metadata changed only | Update metadata, no re-embedding unless ranking-relevant |
| Source item deleted | Mark tombstone, remove from retrieval candidates |
| Sync interrupted | Resume from last successful cursor |

**Lightweight ID pass for deletions** — for each source/scope: list current source IDs only → compare against known indexed IDs → if missing → mark tombstone → remove from candidates → audit deletion event. Especially useful for deleted Drive files, Confluence page moves/restrictions/deletes, Slack history removals, Jira deletions.

**Permission sync without re-embedding** — separate `contentHash` (controls embedding refresh), `permissionHash` (controls FGA tuple refresh), `metadataHash` (controls metadata update). So removing Ravi from `#fraud-ops-private` updates access facts **without touching embeddings**.

**Hybrid search index** — pgvector (semantic) + Postgres FTS (keyword / issue keys / filenames / acronyms). Initial ranking:

```
score = 0.65 × vectorScore
      + 0.25 × keywordScore
      + 0.10 × freshnessBoost
```

**Ranking never overrides permissions.**

### Stage 2 acceptance criteria

- Permission updates do not trigger embedding refresh.
- Deleted items stop appearing in candidates.
- Keyword search finds `PAY-101`, `SEC-44`, `cutover`, `failover`.
- Vector search finds semantically related content.
- Hybrid returns doc IDs + chunk IDs **before** authorization.

---

# Stage 3 — Access-Aware Retrieval & Query Pipeline

> **Objective.** Implement the competition core: unified NL query, permission filtering, live permission change handling, data freshness, LLM safety.

**Query pipeline** — 9 steps:

1. Validate Auth0 token → audit `query_received`
2. Hybrid search local index → top candidate doc IDs
3. Auth0 FGA batch check → audit `allow/deny` per doc → drop denied silently
4. If zero allowed → return fixed no-result response and skip LLM
5. Live source re-check selected docs
6. Refresh newer versions if needed
7. Build context from **authorized fresh chunks only**
8. Hunyuan
9. Output checker → return with citations + last synced/edited times → audit `answer_returned`

**Important security invariant** — the LLM must never receive:

- denied document content
- denied metadata that reveals existence
- private channel names the user cannot access
- restricted document titles
- raw failed candidate list

The no-access branch always returns the same fixed message regardless of whether the doc:

- does not exist
- exists but the user lacks access
- had all candidates denied

**Live source re-check** — for each selected allowed doc:

```
connector.checkAccess(user, doc)
connector.fetchVersion(doc)
```

| Situation | Action |
|---|---|
| FGA says allow, live source says deny | Drop doc, update FGA, audit |
| Source version is newer | Fetch → re-chunk → re-embed → update index → continue with fresh content |

**Output checker** — after LLM: every sentence must cite at least one authorized chunk, otherwise remove or rewrite as uncertainty. Addresses the LLM-hallucination / fill-in-restricted-content concern.

### Stage 3 acceptance criteria

- Ravi gets a multi-source cited answer.
- Alex gets the fixed no-result response for security material.
- Removing Ravi from a private channel affects the next query immediately.
- Fresh runbook edit appears without restarting the app.
- All retrieval and authorization decisions are logged.

---

# Stage 4 — Web Application: Workspace, Admin & Compliance

> **Objective.** Build the visible product — stop looking like just another RAG chatbot.

**Workspace home base** — top: project / search / user switcher · left: Slack threads + today's Jira tasks · centre: working doc/page/sheet with Confluence-master breadcrumb · right: AI Brain chat (minimisable).

**Project source-of-truth UI** — each project shows one Confluence master page, linked Drive files, file status (`draft` / `in review` / `final` / `superseded`), and key conclusions written back to the master page. Reinforces **Slack-talks / Jira-tracks / Drive-works / Confluence-tells-truth** positioning.

**Mock admin panel**:

| Function | Constraint |
|---|---|
| Edit source content | Fires fake webhook |
| Change native permissions | Updates source mock, then FGA |
| Remove user from group/channel | Immediate live query effect |
| Apply access tier | Can only **narrow** access |
| New-hire preview | Shows what access the user gets and why |

**Constraint:** admin actions inside our app **cannot grant access beyond what the source platform allows.**

**Compliance console** (for Nur):

- Natural-language audit query
- Table of events (query, candidates, allow/deny, answer, permission changes)
- Merkle proof path
- Verify button
- CSV export

**Additional features UI**:

| Feature | Build depth |
|---|---|
| Slack → Jira suggestion card | Functional |
| Jira task → relevant doc section | Functional |
| Latest doc badge | Functional scoring, simple weights |
| Intern catch-up summary | Functional |
| Duplicate doc merge suggestion | Clickable mockup first |
| Landing page customization | Lightweight preference UI |

### Stage 4 acceptance criteria

- User can log in and see a permission-filtered workspace.
- Chat answers use the backend retrieval pipeline.
- Admin can simulate content / permission changes.
- Compliance officer can inspect and verify audit logs.
- UI clearly communicates source, freshness, and access decisions.

---

# Stage 5 — Hardening, Architecture Diagram & Product Polish

> **Objective.** Make the system coherent, explainable, and competition-ready as a product.

**Architecture diagram revision** — current diagram has the right broad shape, but needs these additions:

| Gap | Fix |
|---|---|
| Auth0 FGA not visible enough | Add explicit FGA batch-check layer before context building |
| Audit / Merkle absent | Add audit sink + Merkle sealer + compliance console |
| Trust boundaries missing | Add separate trust-boundary diagram |
| LLM shown as self-hosted | Change to Hunyuan API behind `LLMClient` interface |
| Output checker missing | Add post-LLM groundedness checker |
| Admin panel unclear | Show mock admin as separate UI firing webhooks |
| Permission-only updates unclear | Show ACL sync path separate from content embedding path |
| Keyword search missing | Show hybrid retrieval: vector + keyword |
| Deletion detection missing | Add lightweight ID pass / tombstone worker |
| Access tiers missing | Add tier policy layer that narrows platform permissions |

**Trust-boundary diagram** — boundaries:

- browser / user device
- web app
- API server
- source platforms
- Supabase
- Auth0
- Auth0 FGA
- Hunyuan LLM
- server signing key
- append-only Merkle root store

> **LLM boundary:** receives only authorized, fresh, cited chunks — **never raw denied candidates**.

**Reliability and observability**:

- Sync run dashboard
- Connector health status
- Failed sync retry
- Last indexed / last permission sync timestamp
- Per-query trace view: candidates → FGA allow/deny → live re-check → chunks passed to LLM → citations returned

**Security hardening** — tests for:

- Denied document title not leaked
- Private channel name not leaked
- Zero-allowed branch skips LLM
- Permission change takes effect on next query
- Deleted document cannot be retrieved
- Output checker removes uncited claim
- Admin cannot broaden access
- Contractor default-deny

**Final polish**:

- Empty states
- Loading states
- Citation display
- "Why this result?" drawer
- Latest-doc explanation
- Access-tier explanation
- Compliance verify-path visualization

### Stage 5 acceptance criteria

- Architecture diagram matches actual implementation.
- Trust-boundary diagram is accurate.
- All five challenge scenarios work end-to-end.
- Security tests pass.
- Product feels like an integrated enterprise workspace, not just a chatbot.

---

# Recommended build order within the five stages

1. Mock data + connector contracts
2. Sync / index layer
3. Hybrid retrieval + FGA filtering
4. Live re-check + output checker
5. Audit / Merkle
6. Workspace UI
7. Admin + compliance UI
8. Additional features

> **The most important thing to get right is the retrieval security path:**
>
> *Candidate chunks are allowed to be messy; authorized context must be clean.* Retrieve broadly from the local index, but **authorize before context assembly**, and the LLM must never see denied content.

---

# Architecture feedback in one line

Your current architecture diagram is directionally correct, but the revised version should make these five things **visually unavoidable**:

1. **Hybrid search happens before authorization.**
2. **FGA authorizes document IDs only, not content.**
3. **Permission updates do not trigger re-embedding.**
4. **Live source re-check protects against stale access.**
5. **Audit + Merkle is a first-class pipeline, not an afterthought.**

If those five are obvious in the final diagram, it will strongly reflect your group's actual discussion and hit the Aspire criteria cleanly.

---

*Reference: [github.com/onyx-dot-app/onyx](https://github.com/onyx-dot-app/onyx)*