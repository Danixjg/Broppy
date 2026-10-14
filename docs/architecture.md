# Architecture

Internal Brain answers questions across Slack, Jira, Confluence and Drive, using only what the person asking may see
in each platform, and records every decision in an audit trail that can't be quietly changed. This page explains how
the challenge brief's requirements are met, then walks through the pipeline. [Trust boundaries](trust-boundary.md)
covers hosting and sign-in, and [worked examples](worked-examples.md) shows each scenario running.

## What runs where

| Part | Code | Role |
| --- | --- | --- |
| Web host | [`apps/web`](../apps/web/AUTH0.md): Next.js 16 on Vercel | Sign-in through the Auth0 SDK, the public demo, the `/api/brain` proxy and the workspace pages. |
| API | `apps/api`: Node; `sso-api` and `demo-api` on Tencent Cloud Lighthouse, or `pnpm dev` and `pnpm dev:sso` locally | Sync, questions, admin actions and the audit routes. |
| Connectors | `packages/connectors` | Mock fixtures and live Slack, Jira, Confluence and Drive clients, with each platform's own permission rules. |
| Retrieval | `packages/retrieval` | The hybrid index, the built-in writer, the grounding check and the Supabase search client. |
| Access | `packages/fga-adapter` | Grants and tiers per document ID, and the optional remote OpenFGA check. |
| Audit | `packages/audit` | The hash chain, Merkle batches, signatures and proofs. |
| Data | Supabase ([migrations](../infra/supabase/migrations/004_durable_state.sql)) | The directory, state, audit rows, chunks and Vault tokens. |

## How the brief is met

| Requirement | How | Proof |
| --- | --- | --- |
| **Heterogeneous sources, without flattening permissions** | Each document keeps its platform's own permission shape: Slack channel members, Jira project and issue viewers, Confluence space and page viewers, Drive owner and shared users. [`nativeAllows`](../packages/connectors/src/index.ts) applies that shape on top of brain grants and the tier. Contractors see only what is shared with them by name. | [Connector tests](../packages/connectors/src/index.test.ts): "applies native permission changes without changing content and reports changes". [FGA tests](../packages/fga-adapter/src/remote.test.ts): "denies when native source or local tier denies, even if remote allows". [Scenario 4](worked-examples.md#scenario-4-access-changes-apply-to-the-next-question). |
| **Permission-aware retrieval** | Search returns IDs only, and access is decided on document IDs before any text is read (① ②). Each document is checked again at its source before its text enters the context (④). When nothing is allowed, every asker gets the same fixed reply. | [Brain tests](../apps/api/src/brain.test.ts): "never sends denied titles or private channel names to the LLM", "applies a live permission revocation on the next query". [Scenario 3](worked-examples.md#scenario-3-no-hint-that-restricted-content-exists). |
| **Context across platforms** | The [query plan](../apps/api/src/query-plan.ts) reads the platforms and time window a question names, and a question that names a project the asker can open keeps to its items. Outside a project, a match must cover at least half as many of the question's distinctive words as the best match. Links the sources make themselves (Jira issue links and attachments, Confluence page links, and issue keys and links in text) bring in a ticket's linked thread, page and files, one hop from the documents the asker may open. Platforms with a clearly relevant match take turns, Jira passages state the issue status, and the context holds up to 8 passages. | [Scenario tests](../apps/api/src/scenarios.test.ts): scenario 1, and "Context assembly: linked items", such as "never follows links from a document the asker may not open". [Query plan tests](../apps/api/src/query-plan.test.ts). [Scenario 1](worked-examples.md#scenario-1-one-question-across-platforms). |
| **Audit trail: tamper-evident, complete, queryable** | Every step of sync and of each question appends an event to a hash chain (⑤). Merkle batches are sealed on every sync and signed in SSO mode, and Supabase rejects updates and deletes. Compliance search reads plain-English questions and answers "who retrieved this document". | Brain tests: "produces a verifiable Merkle inclusion proof". [Audit tests](../packages/audit/src/index.test.ts). [Scenario 5](worked-examples.md#scenario-5-the-audit-trail-answers-compliance-questions), including the tamper checks. |
| **LLM safety** | A writer sees only the question and passages the asker may see, freshly checked. The answer checker keeps a line only when a passage it cites backs it: copied word for word, or reworded with the same facts, status, negation and hedging. Lines it leaves out are counted for the asker and recorded, with their text, for compliance. A model runs behind a usage meter, and the built-in writer takes over when it can't answer. | [Checker tests](../packages/retrieval/src/grounding.test.ts): the rule set, one-fact changes to every demo sentence, a held-out set and the known gaps. Brain tests: "removes uncited output", "The answer checker" and the "When the language model can't answer" suite. [Usage meter tests](../apps/api/src/llm-budget.test.ts). |

Freshness, the brief's scenario 2, comes from the same live check: a document whose version changed at the source is
refreshed before it is used ([scenario 2](worked-examples.md#scenario-2-fresh-content)).

## The pipeline

The five points the [five-stage plan](internal-brain-five-stage-plan.md) asked to make "visually unavoidable" are
numbered ① to ⑤. The rendered image is [docs/images/diagram-pipeline.png](images/diagram-pipeline.png).

<!-- diagram: docs/diagrams/pipeline.mmd -->
```mermaid
flowchart TB
  classDef point fill:#fff4d6,stroke:#b7791f,stroke-width:3px,color:#1a202c
  classDef store fill:#edf2f7,stroke:#4a5568,color:#1a202c
  classDef stop fill:#fde8e8,stroke:#c53030,color:#1a202c

  subgraph SyncLane["Sync: every 30 s with mock sources, every 5 min with live ones"]
    Sources["Sources: Slack, Jira,<br/>Confluence, Drive<br/>(mock or live)"] --> Sync["Sync: changed IDs (mock)<br/>or every ID (live)"]
    Sync -->|"content changed"| Rechunk["Re-chunk<br/>and re-embed"]
    Sync -->|"permissions only"| Grants["③ Update grants only:<br/>no re-chunk, no re-embed"]
    Sync -->|"gone at the source"| Tomb["Tombstone: drop<br/>chunks and grants"]
  end

  Rechunk --> Index[("Search index:<br/>local, or Supabase")]
  Tomb --> Index
  Grants --> Permissions[("Grants per<br/>document ID")]
  Tomb --> Permissions

  subgraph QueryLane["Query"]
    Question["Question from a<br/>signed-in person"] --> Plan["Plan: platforms, time<br/>window, project named"]
    Plan --> Search["① Hybrid search over the<br/>whole index: keywords,<br/>vectors and freshness;<br/>returns IDs only"]
    Search --> Check["② Access check on<br/>document IDs only"]
    Check --> Links["Follow links one hop,<br/>from allowed documents<br/>only, then ② again"]
    Links --> Live["④ Live check at the source:<br/>permission and version"]
    Live --> Context["Context: up to 8 passages,<br/>platforms take turns"]
    Context --> Writer["Writer: built-in,<br/>or a metered model"]
    Writer --> Ground["Checker: every line must<br/>say only what its<br/>cited passage says"]
    Ground --> Recheck["④ Recheck the person<br/>and every cited source"]
    Recheck --> Answer["Answer with citations"]
    Check -->|"nothing allowed"| Fixed["Fixed reply: no<br/>accessible information"]
    Live -->|"nothing usable"| Fixed
    Recheck -->|"access changed"| Fixed
  end

  Index --> Search
  Permissions --> Check
  Sources --> Live

  subgraph AuditLane["⑤ Audit: every sync and query step appends an event"]
    Events["Events"] --> Chain["Hash chain"]
    Chain --> Merkle["Merkle batches,<br/>signed in SSO mode"]
    Merkle --> Rows[("Supabase: no updates,<br/>deletes or truncates")]
    Rows --> Compliance["Compliance search,<br/>proofs, verify"]
    Events --> Own["The asker's own trace:<br/>only what they could see"]
  end

  Permissions ~~~ Events
  SyncLane -.-> Events
  QueryLane -.-> Events

  class Search,Check,Grants,Live,Recheck point
  class Index,Permissions,Rows store
  class Fixed stop
  style AuditLane fill:#fffaf0,stroke:#b7791f,stroke-width:3px
```

| | Point | In the code | Test |
| --- | --- | --- | --- |
| ① | **Hybrid search happens before authorization.** Search ranks the whole index by keywords, vectors and freshness, and returns document and chunk IDs. The Supabase `hybrid_search` RPC returns IDs and scores only. | `HybridIndex.search` in [`retrieval`](../packages/retrieval/src/index.ts); `Brain.query` in [`brain.ts`](../apps/api/src/brain.ts) | "finds an authorized result beyond thirty higher ranked denied hits"; "persists semantic chunks, searches IDs through Supabase, and leaves embeddings alone on permission edits" |
| ② | **Authorization sees document IDs only, not content.** `FgaAdapter.batchCheck(user, docIds)` decides each candidate. With remote FGA set, both must allow. | [`fga-adapter`](../packages/fga-adapter/src/index.ts) | "never sends denied titles or private channel names to the LLM"; "chunks unique document checks at 50 and maps out of order results by correlation ID" |
| ③ | **Permission updates don't trigger re-embedding.** The index hashes content, permissions and metadata separately, so a permission change updates grants only. | `HybridIndex.upsert`; `Brain.persistSearch` | "does not re-embed permission-only changes"; "keeps cached vectors on permission updates and invalidates them on content, title, and deletion" |
| ④ | **A live check at the source protects against stale access.** Before its text is used, each document's permission and version are checked at the source and refreshed if they changed. After writing, the person and every cited source are checked again. | `Brain.liveAuthorizedDocument`, `Brain.refreshLive` | "applies a live permission revocation on the next query"; "refreshes a newer source version before context assembly"; "rechecks the signed-in user's groups before returning generated text" |
| ⑤ | **Audit and Merkle are a pipeline of their own.** Sync and every query step append events; batches are sealed, signed and stored where they can't be changed. | [`audit`](../packages/audit/src/index.ts); [migration 004](../infra/supabase/migrations/004_durable_state.sql) | "produces a verifiable Merkle inclusion proof"; scenario 5 |

## Sync and freshness

- **Schedule:** the API syncs all four platforms at startup, then every 30 seconds with mock sources and every 5
  minutes with live ones. Each run also seals new audit events into a Merkle batch and saves the state.
- **Changes:** a run reads the IDs a mock source reports as changed, or every ID of a live source, plus any indexed
  ID the source no longer lists.
  - A content or title change re-chunks the document, and re-embeds it when embeddings are on. A refused or failed
    embedding never stops the run: the document keeps keyword search, the provider rests for five minutes, and a
    later run embeds whatever still lacks vectors.
  - A permission-only change updates grants.
  - An ID that is gone at the source becomes a tombstone: its chunks, grants and remote tuples are removed.
- **Imports:** they checkpoint after each item and resume after a failure. Connections, import jobs and cursors are
  saved with the state.
- **Freshness between runs:** the live check in each question refreshes a document whose version changed, so an edit
  made at the source shows up in the next answer, before the next sync.

## The query path

1. **Plan:** the question's platform names and time window shape the search ("Slack last week").
   - **Project:** a question that names a project keeps to that project's items. Every distinctive word of the master
     page's title must be in the question, and exactly one project must match.
   - **Access:** the master page is checked like any document. The scope applies only if the asker may open it, so a
     hidden project's name changes nothing and never reaches their trace.
2. **Search:** the local index ranks every chunk. With Supabase and embeddings set, the `hybrid_search` RPC can
   reorder chunks that also pass the local relevance check.
   - **Words:** a word and its synonyms count once.
   - **Generic words:** status, update, project, plan, team, issue, task, raised and a few more name no topic. They
     count a quarter as much, and make no match on their own unless the question has nothing more specific.
3. **Access check on IDs:** local grants, native rules and the tier decide each candidate document. Contractors are
   denied unless a document is shared with them by name, and remote FGA must agree when it is set. With nothing
   allowed, the API returns the fixed reply.
4. **Keep what covers the question:** outside a project, a match must cover at least half as many distinctive words,
   rounded up, as the best allowed match.
   - **No side channel:** the bar comes from allowed matches only, so a denied document can't move it.
   - **A named issue:** a question that names an issue key, such as "Why is DB-15 blocked?", keeps to the matches that
     name it once an allowed match does, along with any match covering two or more distinctive words (D79).
   - **Meaning:** a match found by meaning alone stays if it is at least as close as the closest match that clears
     the bar.
   - **History:** superseded copies don't set the bar unless the question asks for history.
5. **Follow links:** links are followed one hop, in either direction, from the matches that stay and clearly match
   (at least half the best of them, up to eight).
   - A denied document's links are never followed, so nothing hidden can steer an answer.
   - A linked item scores half the item it came through, keeps to the question's time window and passes the same
     access check.
   - It never takes the places of a platform the question named, nor makes a platform count as clearly relevant.
6. **Choose passages:** superseded documents are set aside unless the question asks for history ("old",
   "previous"). Platforms with a clearly relevant match take turns.
7. **Live check:** each passage's document is checked at the source once before its text is used, up to 8 passages.
   A linked item counts only while the item it came through passes too.
8. **Write and check:** the writer answers from those passages. A line is kept only when a passage it cites backs it,
   copied word for word or reworded with the same facts, status, negation and hedging. The asker learns how many lines
   were left out and why; the audit keeps their text.
9. **Recheck:** the person and every cited document are checked again. Any change returns the fixed reply.
10. **Answer:** citations carry the title, link, version, edit time and index time, and the item a link came through.
   Answers also say which platforms and dates were searched, and which project they kept to.

The fixed reply, "No accessible information was found for this query.", is the same for a denied document and for
one that doesn't exist. The asker's own trace of such a question is a single event.

## The workspace

Everything the workspace shows is built in [`workspace.ts`](../apps/api/src/workspace.ts) from the documents the
person may open, and nothing else, so nothing hidden can show up. Each document lists only the linked items the
person may also open.

- **Projects:** a Confluence page labelled "master" defines a project. A project holds:
  - what the page links to;
  - the issues, pages and channels tagged with its key;
  - the files and threads those issues link to.

  It is listed only to people who can open its master page.
- **Latest:** each project's latest Drive file, with the reason for every point: status, a recent edit, the version,
  and a link from the master page. Superseded files never count.
- **Duplicates:** files with the same title where one is superseded, or sharing at least 60% of their words. The
  merge is a preview that changes nothing.
- **From conversation to task:** sentences such as "Agreed: …" or "Decision: …" in a thread become a suggested Jira
  task in the thread's project.
  - On mock sources, the task's text comes from the agreed sentence alone. It links back to the thread and copies the
    permissions of the issue it is modelled on.
  - With live sources and Jira connected, Create and Mark done go to the company's Jira through the shared connection,
    for a person whose own Jira account may create in that project, or see and move that issue. Jira receives the
    reviewed summary and an operation marker only, never the thread's text or name. Each attempt is reserved first; one
    whose result is unknown is blocked until it is reconciled, so a task is never created twice. Who can see the new
    issue is up to the Jira project, which the page says before creating.
- **Catch-up** (`/v1/catch-up`): chosen by role and groups, and asked like any question.
  - Interns get what a new hire should read first.
  - People in no group see what is shared with them.
  - Everyone else gets a project's status, blockers and recent decisions, kept to that project's items.
  - Compliance gets the last 7 days of the audit trail instead.

## Writers

- **The built-in writer** ([`LocalGroundedLlm`](../packages/retrieval/src/index.ts)) is code, not a model.
  - It quotes the most relevant source in full (up to six sentences), then the best sentence of the next three.
  - It needs no key or network, and it is the default.
- **A language model** is optional: Groq's `openai/gpt-oss-120b` (D54, D55).
  - [`llm.ts`](../apps/api/src/llm.ts) is one client for OpenAI-style APIs. Its `tokenhub` and `hunyuan` presets, for
    Tencent's services, aren't used.
  - [`llm-budget.ts`](../apps/api/src/llm-budget.ts) puts it behind a usage meter: a token budget, a daily
    allowance, room held for calls still running, and a 60-second timeout.
  - A model receives the question and the authorized passages with their citation IDs, and nothing else.
  - Its instructions ask it to answer every part of the question from every passage that helps, and to keep status
    labels and steps. It may copy sentences or reword them lightly, keeping every fact, with one citation-marked
    sentence per line (D64).
  - [`grounding.ts`](../packages/retrieval/src/grounding.ts) checks each line against the passage it cites and keeps
    only what that passage backs (D62). Lookalike characters (a non-breaking hyphen, curly quotes, special spaces)
    don't count as differences, and a copied line shows the source's own text.
- **Fallbacks:** the built-in writer answers when the model is over a limit, rate limited or failing, or when the
  checker keeps none of its lines. The audit records `llm_fallback` with the reason. See decisions D27 to D31, D54
  and D55.

## Audit

- **Events:** every step appends one, from the question, plan and candidates through each access decision, the
  passages sent, any fallback and the answer.
- **Hash chain:** each entry includes the hash of the one before it, computed over a canonical form of its data.
- **Merkle batches:** sealed on every sync, and on demand from the Compliance view. Each batch links to the previous
  root.
- **Signatures:** a stored audit, in Supabase or in an `AUDIT_LOG_PATH` file, signs every batch with Ed25519, and the
  API won't start without `AUDIT_SIGNING_KEY_FILE`. The public demo keeps its audit in memory, unsigned.
- **Storage:** Supabase receives entries and batches in order, and triggers reject updates, deletes and truncates.
  At startup the API verifies the chain, every batch root and every signature.
- **Compliance:** `/v1/audit/search` reads plain-English questions (person, platform, space, dates, document), and
  `/v1/audit/proof` and `/v1/audit/verify` check a Merkle proof. The Compliance view exports CSV.
- **The asker's view:** `/v1/trace` shows the asker only the documents they were allowed.

## Persistence and organizations

- **One workspace per company:** a token's organization decides which company's workspace answers. The company set up
  by hand (`AUTH0_ORG_ID`) is always served; with `SELF_SIGNUP` on or closed, so is every company listed in
  `organizations` (see `docs/self-signup.md`). A token from any other organization is refused. Each company has its own
  directory, saved state, audit chain, source connections and remote tuples, built when its first request arrives.
- **One writer per organization:** two APIs writing one organization's audit chain break each other.
- **Saved state:** the index, grants, mock edits, connections, jobs and cursors are saved to Supabase after every sync
  and every successful request. Semantic vectors are restored with the index.
- **Without Supabase:** as in the public demo, everything lives in memory and resets on restart.

## The demo's data

- **Two sets:** [`data/mock/`](../data/mock/documents.json) holds the 26 hand-written items the scenarios and tests
  are built on. [`data/generated/`](../data/generated/documents.json) holds a 500-item company from a seeded generator,
  checked by the app's own access check, link reader, search words and workspace functions (D71 to D74).
- **Who serves what (D75):** the demo API (`pnpm dev` and the public demo) serves both, and `MOCK_DATA=curated` gives
  it the hand-written items alone. The SSO API keeps the hand-written items: its people come from the directory, which
  doesn't have the generated company's groups.
- **Checked on both:** every scenario test runs on each set with the same cited documents, and so do the worked
  examples. A leak test asks about all eight projects as each of the six people, and checks that nothing they can't
  open reaches the writer or their own trace.
- **At the brief's scale:** `pnpm bench` builds about 20,000 items in 30 generated projects in memory, indexes them
  with the same `Brain`, and times 20 questions for each person. Its numbers are in the [README](../README.md#speed-and-memory).

## Limits

- **No webhooks:** freshness comes from polling plus the live check in each question.
- **Anchoring isn't running:** `tools/anchor` can copy the signed roots of a file-based audit log into a separate
  repository and check the log against them, but that repository isn't set up, and roots kept in Supabase aren't read
  yet. Until then, someone holding both the database and the signing key could rewrite history undetected.
- **Remote FGA:** it uses a generic per-document schema. Each platform's own permission shape is enforced in the
  connector layer.
- **Embeddings:** optional, from Cloudflare Workers AI's `bge-m3` (D56). The provider sees the text of every chunk,
  and `SEMANTIC_MIN` (0.51) was tuned on the mock items (`pnpm llm:calibrate`). Related and unrelated pairs overlap
  (the most similar unrelated pair scored 0.61), so about one unrelated pair in twenty still passes on similarity
  alone; keyword matches are unaffected.
- **Demo identities:** they are fixtures chosen with a header, and only the public demo API accepts them.
- **People who can open little:** the coverage bar comes from their own best match, so a question about something
  hidden from them can be answered from an unrelated item that shares a word. At the brief's scale, most of the answers
  the contractor and the intern get are like that (D76). Nothing hidden is used or named.
- **Audit volume:** every ranked candidate and every access decision is an audit entry. At the brief's scale a broad
  question writes up to about 25,000 entries: the slowest took 1.0 seconds, and 0.4 without writing them.
- **Live imports:** they read current text only: no revision history, Jira comments or text from images.
- **Workspace writes:** with live sources, creating a task and Mark done need Jira connected, and act with the admin's
  shared connection after checking the person's own Jira permission. Slack, Confluence and Drive stay read-only.
- **Links by path:** a link is recognised by its path, whatever the host. A link to another company's Jira issue with
  the same key would point at ours, though that item still passes every access check.
- **Saved demo data:** an API that saves its state to Supabase keeps the mock data it first saved, with its dates.
  Newer demo data, such as links, appears only once that saved state is reset.

## More

- [Trust boundaries](trust-boundary.md): hosting, sign-in and what crosses each boundary.
- [Worked examples](worked-examples.md): the five scenarios, with real output.
- [Decisions](../decisions.md): every choice and its trade-offs.
- Setup: [Auth0 sign-in](../apps/web/AUTH0.md), [live sources and persistence](live-sources-and-sign-in.md) and
  [hosting](../infra/tencent/README.md).
