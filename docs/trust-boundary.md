# Trust boundaries

Where each part runs, what crosses between them, and what never does. The hosted setup follows
[infra/tencent/README.md](../infra/tencent/README.md). Locally, the same processes run on `127.0.0.1`:
`pnpm dev` (the demo, with personas chosen by a header) and `pnpm dev:sso` (Auth0 and Supabase). The query pipeline
itself is in [Architecture](architecture.md).

## Hosting

Rendered image: [docs/images/diagram-deployment.png](images/diagram-deployment.png).

<!-- diagram: docs/diagrams/deployment.mmd -->
```mermaid
flowchart TB
  classDef store fill:#edf2f7,stroke:#4a5568,color:#1a202c
  classDef guard fill:#fff4d6,stroke:#b7791f,stroke-width:2px,color:#1a202c
  classDef missing fill:#ffffff,stroke:#a0aec0,stroke-dasharray:5 5,color:#4a5568

  Visitor["Browser: a person,<br/>or a demo visitor"]

  subgraph Vercel["Vercel: Next.js web host"]
    Session["Auth0 SDK session:<br/>encrypted HttpOnly<br/>cookie; only the host<br/>reads the tokens"]
    Proxy["/api/brain proxy:<br/>same-origin check,<br/>API paths only"]
  end

  Auth0["Auth0: organization<br/>login, signing keys"]

  subgraph Lighthouse["Tencent Cloud Lighthouse"]
    Caddy["Caddy: HTTPS"]
    Usage[("Usage volume: token<br/>and answer counts")]
    SsoAPI["sso-api: checks the<br/>token, organization<br/>and directory; holds<br/>the audit signing key"]
    DemoAPI["demo-api: PUBLIC_DEMO,<br/>fictional data only"]
  end

  Supabase[("Supabase: directory,<br/>state, chunks, Vault<br/>tokens, audit rows with<br/>no updates or deletes")]
  Sources["Sources: mock in both<br/>APIs; live Slack, Jira,<br/>Confluence and Drive<br/>for SSO only"]
  Groq["Groq free plan: no<br/>card on file; question<br/>and authorized passages<br/>only; a daily allowance<br/>per API"]
  Anchor["External write-once<br/>root anchor"]

  Visitor -->|"HTTPS and a cookie"| Session
  Session --> Proxy
  Session -.->|"sign-in"| Auth0
  Proxy -->|"Bearer token,<br/>or a demo persona"| Caddy
  Caddy --> SsoAPI
  Caddy --> DemoAPI
  Usage --- SsoAPI
  Usage --- DemoAPI
  SsoAPI -.-> Groq
  SsoAPI --> Supabase
  SsoAPI --> Sources
  DemoAPI --> Sources
  DemoAPI -.-> Groq
  Supabase -.->|"not implemented"| Anchor

  class Session,Proxy,SsoAPI,DemoAPI guard
  class Supabase,Usage store
  class Anchor missing
```

## Sign-in and the demo

Rendered image: [docs/images/diagram-sign-in.png](images/diagram-sign-in.png).

<!-- diagram: docs/diagrams/sign-in.mmd -->
```mermaid
sequenceDiagram
  autonumber
  actor P as Person
  participant W as Next.js web host
  participant A as Auth0
  participant S as SSO API
  participant D as Demo API

  rect rgb(235, 244, 255)
    note over P,S: Sign in with SSO
    P->>W: /auth/login
    W-->>P: Redirect to Auth0 with the organization and API audience
    P->>A: Log in
    A-->>P: Redirect to /auth/callback with a code
    P->>W: /auth/callback
    W->>A: Exchange the code, with the client secret
    A-->>W: ID, access and refresh tokens
    W-->>P: Encrypted HttpOnly session cookie: the page can't read the tokens
    P->>W: /api/brain/v1/query with the cookie
    note right of W: Same-origin check, then the<br/>access token is read on the server
    W->>S: POST /v1/query with the Bearer token
    S->>A: Signing keys (cached)
    note right of S: RS256, issuer, audience, expiry,<br/>org_id, active directory entry.<br/>Checked again before replying.
    S-->>W: Answer with citations
    W-->>P: Answer
  end

  rect rgb(255, 248, 230)
    note over P,D: Try the demo
    P->>W: /demo
    W-->>P: brain_demo cookie: the mode only, never an identity
    P->>W: /api/brain/v1/query with x-demo-user: david
    note right of W: Same-origin check, and the<br/>persona must be a short ID
    W->>D: POST /v1/query with x-demo-user only: no cookies, no tokens
    D-->>W: Answer from fictional data
    W-->>P: Answer
  end
```

## What crosses each boundary

| Boundary | What crosses | What never crosses | Limits |
| --- | --- | --- | --- |
| **Browser ↔ web host** | HTTPS requests. The Auth0 SDK's session cookie (encrypted, HttpOnly, SameSite=Lax). In demo mode, the `brain_demo` cookie, which selects the mode only, and the chosen persona's ID. | Tokens the page can read: the SDK's access-token endpoint is off, and only the host can decrypt the session. API addresses and keys. | A demo visitor picks any fictional persona; that is the point of the demo. |
| **Web host ↔ Auth0** | The sign-in redirect, with the organization and API audience. The code exchange, made by the server with the client secret. | The client secret, outside the host's server environment. | Tenant settings are checked by `pnpm doctor:sso`, not by the sandbox. |
| **Web host ↔ SSO API** | `/v1` requests carrying the Bearer access token, after a same-origin check. Bodies are capped at 100 kB, and calls time out after 60 seconds. | The session cookie. Paths outside `/v1` and `/health`. A rejected token's details: every API 401 becomes one generic "did not accept your account" message. A link, project, file or suggestion naming an item the person can't open: the workspace is built only from what they may open. | The host trusts `BRAIN_API_URL`; HTTPS comes from Caddy. |
| **Web host ↔ demo API** | `/v1` requests with `x-demo-user` only: a short lowercase ID, sent only to `DEMO_API_URL`. | Cookies and tokens. Demo traffic never reaches the SSO API, and a signed-in session always wins over the demo cookie. | The demo API trusts the header by design. It serves fictional data only. |
| **SSO API ↔ Auth0** | Signing keys (JWKS), cached. Tokens must be RS256 and match the issuer, audience and expiry, carry `sub`, `exp` and the expected `org_id`, and map to an active directory entry in that organization. | Anything about the question or answer. | The person is checked again before an answer is returned, so a deactivated account stops at once. |
| **API ↔ Supabase** | The server-only secret key. Directory reads, the state snapshot, ordered audit appends, the `hybrid_search` RPC (which returns IDs and scores), and Vault calls for source tokens. | The secret key, outside the API host. Source tokens in API responses or snapshots. | Triggers reject audit updates and deletes, but not a database owner replacing the database. One audit writer per organization. |
| **API ↔ sources** | Mock connectors run inside the API. Live connectors use OAuth tokens kept in Vault (or `LIVE_SOURCES_JSON`); each person needs their own delegated credential, and no credential means no access. | Content from one organization to another: each API serves one organization. | Polling only, no webhooks. Live imports read current text only. Workspace actions (creating a task, Mark done) change mock sources only; live connectors keep read-only scopes, so the app links to Jira instead. |
| **API ↔ model provider** | The question, and the authorized, freshly checked passages with their citation IDs, to Groq, from both APIs, each within its own daily allowance (D55). | Denied documents' titles, metadata or text. Identities, tokens or keys. | The provider sees the passages it is sent. Groq's free plan has no card on file, so it can't bill; both APIs share its limits. |
| **API ↔ embeddings** (optional) | None since Tencent's were dropped (D55). With a provider: changed chunk text at sync, restricted documents included, and question text at query. | Permission data. | The provider sees the text of every chunk, not only what one person may read. |
| **API ↔ remote FGA** (optional) | Organization-scoped tuples at sync; batch checks of document IDs at query. | Document content. | Remote failures deny. Platform permission shapes stay in the connector layer. |
| **Lighthouse host** | Caddy terminates HTTPS for two host names. `sso-api` reads `sso.env` and the audit signing key (mounted read-only). Both APIs share the usage-count volume. | Real settings in `demo-api`: it refuses to start with any Auth0, Supabase, live-source, source OAuth or remote FGA setting. | `docker compose down -v` deletes the usage counts. |
| **Audit store and keys** | Ed25519-signed Merkle batches that link each root to the previous one. At startup, the chain, roots and signatures are checked. | The signing key, outside the API host. | No external write-once anchor is running yet (`tools/anchor` covers file-based logs, not Supabase): someone holding both the database and the key could rewrite history. |
| **Compliance view ↔ audit** | For the compliance role: listing, plain-English search, proofs, verification and CSV export. Anyone else sees only their own trace, which never names what they couldn't see. | Audit data, to other roles. | The audit holds questions, answers and document IDs, so access to it must stay narrow. |

A question with nothing the asker may see gets the fixed reply, "No accessible information was found for this
query.", and no writer is called. Denied documents' titles, metadata and text never reach a writer, a model or the
asker's own trace.
