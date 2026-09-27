# Trust boundaries

| Boundary | MVP behavior | Production replacement |
| --- | --- | --- |
| Browser to API | Loopback demo identity header | Validate Auth0 JWT, audience, issuer, and expiry |
| API to source | Mutable mock connector | Source OAuth credentials held server-side |
| API to FGA | In-process tuple adapter | Auth0 FGA batch check of document IDs |
| API to index | In-memory sparse index | Postgres FTS plus pgvector |
| API to LLM | Local deterministic client | Hunyuan API behind `LlmClient` |
| Audit to root store | In-memory Merkle roots | Signed roots in append-only external storage |

The browser receives only documents authorized by both indexed FGA state and live source checks. Query candidates may contain restricted IDs inside the API, but candidate titles, metadata, and content are never sent to the LLM before authorization. The LLM receives selected chunk text and opaque chunk citation IDs. Denied candidate lists do not cross that boundary.

The no-result message is identical for absent, denied, and deleted material. Query audit events contain a hash of the question rather than the question text. Compliance access is separate from workspace access.

The mock admin can edit native permission fixtures to simulate a source change. It cannot grant access through the brain's tier policy. A tier change only moves from `open` to `internal` or `restricted`, or from `internal` to `restricted`. Live source checks remain mandatory.

This is a local MVP, not a deployed security boundary. The demo identity header must never be enabled on a network-facing deployment.
