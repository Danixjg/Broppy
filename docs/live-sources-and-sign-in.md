> **Web authentication update:** Follow [Auth0 Next.js SDK setup](../apps/web/AUTH0.md) for the current Regular Web Application and server-managed sessions. The API directory, persistence and source connector setup below still applies.

# Auth0, durable storage and live sources

Auth0 validates identity; Supabase `workspace_users` supplies active status, organization, role, groups and platform identities. Supabase password login has been removed. The local demo remains available only with the explicit demo switches.

## Setup

1. Create an Auth0 RS256 API and Regular Web Application, enable Organizations, create Company A, and enable the required database and SSO connections. Use access tokens lasting 5–15 minutes. Register callback `http://127.0.0.1:3001/auth/callback`, logout `http://127.0.0.1:3001` (the exact `APP_BASE_URL` value, which the SDK sends as `returnTo`), and web origin `http://127.0.0.1:3001` for local use. Set `APP_BASE_URL` in the web host environment for other deployments.
2. Apply SQL migrations `001` through `005` in order to Supabase. Migration `003` retains nullable legacy Supabase Auth IDs and keys memberships by organization and `user_id`. Migrations `004` and `005` require pgvector and Vault respectively. Existing indexed demo rows are assigned `demo-company-a`; reimport under the actual Auth0 organization before live use. Existing persisted audit rows without complete payloads require a separately verified migration; startup refuses to silently invent their history.
3. Set `AUTH0_ISSUER`, `AUTH0_AUDIENCE`, `AUTH0_ORG_ID`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `AUDIT_SIGNING_KEY_FILE` (an Ed25519 PEM private key) in the root `.env.local` (template: `.env.example`), and start the API with `pnpm dev:sso`, which loads that file. Keep keys on the API host. The directory and persistence work without an embedding service. Adding Cloudflare embeddings (`EMBEDDING_PROVIDER=cloudflare`, `EMBEDDING_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`) enables the Supabase hybrid search index.
4. Provision the six identities with `pnpm exec tsx --env-file=.env.local data/seed-auth0-users.ts` (full command in [Auth0 setup](../apps/web/AUTH0.md#3-supabase-checklist)). Also set `AUTH0_MANAGEMENT_CLIENT_ID`, `AUTH0_MANAGEMENT_CLIENT_SECRET`, `AUTH0_DATABASE_CONNECTION`, and `MOCK_USER_PASSWORDS_JSON`. The M2M application needs Management API permissions to read/create users and add organization members. Existing accounts are reused; passwords are not reset. The `.example` fixture emails must be replaced with real matching platform emails for live integration.
5. Configure the web host's values in the same root `.env.local` as described in [Auth0 SDK setup](../apps/web/AUTH0.md), start it with `pnpm --dir apps/web dev`, open `http://127.0.0.1:3001/` and choose **Sign in with SSO**. The [troubleshooting table](../apps/web/AUTH0.md#6-symptom--cause) maps each failure to its cause.
6. Configure `HOST`, `PORT`, `API_ORIGIN` and `WEB_ORIGIN` for deployment. Set `BRAIN_API_URL` in the Next.js server environment to the API origin.

Each API process serves the company in `AUTH0_ORG_ID`. Tokens for another organization are rejected unless self-signup is switched on (`SELF_SIGNUP`, see `docs/self-signup.md`), in which case companies that signed up are served too, each with its own workspace. Directory reads, storage and FGA tuple IDs are organization scoped. Keep one writer per organization.

Directory validation runs again before an answer is returned. Setting `active=false` therefore blocks existing browser tokens immediately at the API. New directory identities require a restart to join the live ingestion user list. OAuth connection callbacks also revalidate the initiating administrator.

## Connect sources

The admin view links to `/connectors.html`. It shows connection status, counts, last sync, scope, import progress and missing directory identity mappings. The local **Onboard Company A** action imports all four mock sources in the background. Imports checkpoint after each item, report indexed/skipped/failed counts, resume failed pending IDs during polling, and emit connection/import audit events. Answers carry an import completeness notice.

`SOURCE_OAUTH_JSON` enables live OAuth connections, for example:

```json
{
  "drive": {
    "clientId": "GOOGLE_CLIENT_ID",
    "clientSecret": "SERVER_SECRET",
    "scopes": ["openid", "email", "https://www.googleapis.com/auth/drive.readonly"]
  },
  "jira": {
    "clientId": "ATLASSIAN_CLIENT_ID",
    "clientSecret": "SERVER_SECRET",
    "scopes": ["read:jira-work", "write:jira-work", "read:me", "offline_access"]
  }
}
```

Atlassian sites are found at sign-in: after the admin connects Jira or Confluence, Broppy asks Atlassian which sites the account can reach and stores the site (base URL and cloud ID) with the token. If exactly one site is reachable it is used automatically. If several are, set `cloudId` (or `baseUrl`) in that source's configuration to choose one; a person-level picker is not built yet. Configuration values also still work and take effect when no site was discovered. People connecting their own Atlassian account must be able to reach the organization's site.

Register `${API_ORIGIN}/v1/admin/connections/SOURCE/callback` with each provider. Confluence uses an Atlassian app with Confluence read scopes and its `cloudId`. Slack uses a Slack OAuth v2 app and **user** read scopes for conversations, history, replies and `users:read.email`; only channels visible to that credential are imported. The callback verifies the connected account email against the administrator's directory identity. Tokens and refresh tokens are stored in Supabase Vault; API responses and state snapshots contain no tokens. Source OAuth state expires after ten minutes and is single use; pending flows survive API restarts because their single-use state is persisted. Google uses PKCE. Tokens with no refresh capability require reconnecting when expired.

Only the company admin connects a source; everyone works from that one shared connection, and the shared connection is also used to ask each source who may see an item (see Shared connection below). The settings people-matching list checks directory identity mappings, not credential availability. Domain-wide Google delegation and Auth0 Token Vault are not implemented. Do not infer that installing one app authorizes every employee.

### Shared connection

Only the admin connects Slack, Jira, Confluence and Drive (Connectors page). There is no per-person connection and no "My accounts" page. Imports, answers and the Slack app's Jira writes all use the admin's connection. Register only `${API_ORIGIN}/v1/admin/connections/SOURCE/callback` per provider (the `/v1/connections/SOURCE/callback` URIs from the old per-person flow are no longer used). Connecting a source clears any personal connection left from before (`remove_user_source_tokens`); migration 007's table stays but is unused.

- **Who may see an item** is read from the source with the shared connection, then cached for 30 seconds: Slack private channel members (public channels: anyone in the workspace), a Drive file's own user, domain and anyone shares (Google groups are not expanded, so group-only access shows nothing), Jira "browse" permission for that issue (so issue security counts), and Confluence's read check. A person is matched to the source by the email in their directory entry (`platformIdentities`), and Jira/Confluence additionally need that email to resolve to exactly one Atlassian account (through the Jira connection). Anything unclear is a no; a source outage is reported, not treated as a no. Not yet exercised against live providers: the Jira user-search and permission calls, Confluence's `/permission/check`, and Slack's `users.lookupByEmail` need `read:jira-user` (Jira), `users:read.email` and `channels:read`/`groups:read` (Slack, admin's user scopes), and the admin's Drive account must be able to list permissions on the files.
- **Slack is one step.** When the Slack entry in `SOURCE_OAUTH_JSON` uses the same app as `SLACK_CLIENT_ID`, the admin's Connect on Slack asks for the bot scopes and the admin's own user scopes in one consent, installing Broppy in the workspace and storing the admin's Slack token as the shared source connection. The redirect URI is `${API_ORIGIN}/v1/admin/slack-installation/callback`. With different apps it stays two steps.
- **Jira from Slack** ("Track in Jira", repeat comments): made with the shared Jira connection, so Jira shows the admin as creator; the text names the Broppy user it was made for and the audit log (`jira_issue_created_from_slack`, `jira_comment_added_from_slack`) records them. The person must be able to browse the issue to see its status.
- For other services, `SourceOAuth.authorization(source)` returns the shared `Authorization` header (refreshing when needed).

For explicitly managed credentials, use `LIVE_SOURCES_JSON` with all four source keys. Each entry accepts `ids`, `serviceAuthorization`, `userAuthorizations` keyed by workspace user ID, optional `discover: true`, and, for Atlassian, `baseUrl` and optional `cloudId`. Optional `linkOrigins` maps source names to trusted HTTPS origins. Cross-source Jira, Confluence and Slack URLs create relationships only for those configured origins; Drive URLs must use Google's document or Drive origins. Authorization values include the scheme, e.g. `Bearer ...`. Use either this mode or `SOURCE_OAUTH_JSON` per API process.

Scope supports native item IDs, container IDs (Slack channels, Jira project keys, Confluence space IDs, shared Drive IDs), and a history start date. Empty scope means everything the credential can discover. Discovery paginates; Slack reads all history pages and thread replies. Jira imports current issue descriptions, Confluence current page bodies, and Drive Google Docs/text files. The date applies to Slack messages and to other items' last-updated timestamps; revision history, Jira comments and binary OCR are not imported. Jira polling reads bounded `updated` metadata and compares a persisted provider checkpoint before fetching changed content. Every twelfth poll reconciles full records. Other providers retain their existing polling strategy. Map Slack IDs to active directory users with `SLACK_USERS_JSON` entries containing `brainUserId` on both API and Slack deployments. Directory source identities remain email credentials; without an explicit Slack ID mapping, first-person owners remain unknown. Slack records exact message author, source timestamps and provider permalinks when available; legacy fixtures remain explicitly labeled as thread evidence. Temporary delegated access failures withhold current content and preserve confirmed records and grants for retry. A source sync failure still allows healthy sources to sync before an aggregate error is reported. Retryable rate limits use bounded backoff; long delays leave a resumable error rather than claiming completion. Unreadable, empty and unsupported documents count as skipped. Disconnect purges local documents, grants, remote tuples, Supabase document/chunk rows and Vault credentials.

## Persistence and audit

The API checkpoints its index, grants, mock edits, source connections, import jobs and sync state. Structured cursor/run rows are updated alongside the state snapshot. Semantic vectors are restored with the index and rebuilt when absent or changed. Startup loads state, then starts polling/import work in the background; it does not await the initial full sync.

Audit entries retain questions, answers, document IDs, source and space/project. Compliance search accepts `user`, `source`, `space`, `from`, `to`, or a plain-English query containing known user names, source/space names and ISO dates. Space/source filters include the related query and answer trace. This is a deterministic filter parser, not unrestricted language understanding.

Supabase audit writes are ordered, idempotent and reject conflicting sequences. A failed audit flush prevents a successful query response. The database rejects UPDATE, DELETE and TRUNCATE of entries/batches. New hash entries use canonical data ordering to survive JSONB reordering. Signed Merkle batches include the preceding root. Independent write-once root anchoring remains the open infrastructure decision identified in the audit; signatures and triggers do not protect against a database owner replacing the entire database.

## OpenFGA

Install `infra/fga/model.fga` and set `FGA_API_URL`, `FGA_STORE_ID`, `FGA_MODEL_ID`, `FGA_CLIENT_ID`, `FGA_CLIENT_SECRET`, `FGA_API_TOKEN_ISSUER`, `FGA_API_AUDIENCE`. The OpenFGA SDK obtains and refreshes client-credentials tokens. Tuple subjects and objects include the organization namespace. Native Slack/Jira/Confluence/Drive permission shapes remain enforced in the connector layer, alongside tiers and fresh delegated source checks. A source-specific remote FGA schema remains a follow-up consideration; the current remote schema is the generic document intersection described in the audit.

Sign-in state (`oauth_flows`, migration `008_oauth_flows.sql`) lives in Supabase rather than in API memory, so the provider's redirect can reach any API instance (Vercel runs several). Each provider's differences from the common flow are one entry in `apps/api/src/oauth-providers.ts`; connectors receive an `AuthorizationProvider` (`@brain/types`) and never see tokens.
