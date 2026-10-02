> **History (30 Sep 2026).** These notes record audit batch 0.1. The current design is in
> [Architecture](architecture.md).

# Audit batch 0.1 implementation

Reference: `broppy-audit-batch0.1.md`. This batch addresses the repository blockers and the identity, audit, persistence and onboarding work in the audit's suggested order. No UI redesign or week 3 differentiator work was added.

| Audit item | Implementation / remaining boundary |
| --- | --- |
| 1: missing live connector; tracked generated files | Node ignore rules; live connector and tests included; dependency/build files removed from Git's index, retained locally. Changes have not been committed or pushed. |
| 2: Auth0 login | SSO login, `jose` cached JWKS, real subject lookup, active/org checks, Auth0 seed script, Supabase directory migration; old Supabase login removed. Tenant/app creation and real credentials must be supplied externally. |
| 3: audit completeness | Questions, answers, source doc IDs and space/project metadata; date controls, structured filters, deterministic plain-English filter extraction; matching traces include question and answer. |
| 4: durable audit | Ordered Supabase RPC writes with retry/conflict checks; immutable UPDATE/DELETE/TRUNCATE triggers; canonical JSONB-safe hashes; preceding root signed in each batch. Independent write-once root anchoring remains open as stated in the audit. |
| 5: durable state | Organization-scoped index/grant snapshot and mock source edits; structured cursor/run checkpoints; restored connections/jobs; checkpoint after every item. One API writer per org; semantic vectors are restored with the index. |
| 6: onboarding | Plain admin Connectors page; mock Company A action; background imports, counts, scopes, discovery pagination, Slack history/replies, retry/backoff, OAuth callback/Vault token support, disconnect purge. Live provider app setup and full end-to-end verification remain external. Revision histories, binary extraction, organization auto-provisioning and domain-wide delegation are not implemented. |
| 7: tenant IDs | Organization membership keys, state/audit/source/chunk columns, scoped persistence and remote tuple IDs, rejection of wrong-org tokens. Deploy one API process per organization; no multi-company router. |
| 8: contractors | Explicit brain user grant plus native source access permits sharing; public/group-only grants remain insufficient. Restricted tier still denies contractors. |
| 9: FGA | SDK client credentials replace environment static bearer token path. Native permission shapes still enforced locally. Source-specific remote schema remains a considered follow-up, rather than an untested model migration. |
| 10: webhooks | Deferred per audit priority; polling plus per-query live checks retained. |
| 11–12: demo consistency | Keep Alex=intern, Wei=contractor, Maya=admin; Ravi is the head-of-payments persona. Added security/vendor channels, chargeback guide and payment-gateway space; tuple fixtures updated. |
| 13: tiers | Existing `open/internal/restricted` semantics retained; the default tier is labeled Team in the admin selector; named expiring grants remain follow-up work. |
| 14: deploy/performance | Configurable web API URL and API host/port; cached JWKS; background initial sync. No Tencent deployment was performed. |
| 15–16 | Week 3 differentiators remain deferred as the audit specifies. Genuine CodeBuddy/WorkBuddy screenshots must be captured by someone using those products; none were fabricated. |

## Verification

- `pnpm typecheck`; also passes in a separate clean copy after an offline, frozen-lockfile install.
- `pnpm test`: 86 Vitest tests and 9 browser-module checks pass.
- `pnpm --filter @brain/web build`: workspace, SSO and connector pages build, including in the clean copy.
- Temporary embedded PostgreSQL run: migrations 002–004 metadata, directory keys, durable state RPC, audit idempotency/conflict checks, immutable triggers (including owner UPDATE rejection), and anonymous role rejection pass. This runtime does not ship pgvector or Vault; those extension-specific paths were not executed against Supabase.
- Auth0 signing/claim tests, OAuth state replay/offboarding tests, pagination/history tests, contractor sharing, restart/grant recovery, organization rejection and import/purge regressions run without live credentials.

See [configuration and limits](live-sources-and-sign-in.md) before enabling live services. The code does not claim the external services are deployed or verified.
