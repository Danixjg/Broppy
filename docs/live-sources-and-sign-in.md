# Supabase sign-in and live sources

The default demo still runs from local fixtures. To use real source data, configure Supabase Auth and all four source entries before starting the API. The API polls explicitly listed source IDs every five minutes and checks the requesting user's delegated source credential again during retrieval and before returning an answer.

## Supabase users

1. Apply `infra/supabase/migrations/002_workspace_users.sql` to the chosen Supabase project after migration `001_initial.sql` if using Supabase search. Auth alone requires only migration `002`.
2. Set `SUPABASE_AUTH_URL` to the HTTPS project origin, `SUPABASE_AUTH_SECRET_KEY` to the server secret key, and `SUPABASE_AUTH_PUBLISHABLE_KEY` to the browser publishable key. Keep the secret key on the API host.
3. Set `MOCK_USER_PASSWORDS_JSON` to a JSON object mapping `ravi`, `maya`, `alex`, `david`, `nur`, and `wei` to distinct passwords of at least 12 characters. Run `pnpm exec tsx data/seed-supabase-users.ts`. This creates or updates the six demo profiles in Supabase Auth and `workspace_users`. The seed is idempotent for existing email addresses; it does not reset existing passwords.
4. Set `apps/web/auth-config.json` to `{ "issuer": "", "clientId": "", "audience": "", "supabase": { "url": "https://YOUR-PROJECT.supabase.co", "publishableKey": "YOUR-PUBLISHABLE-KEY" } }` and open `/login.html`. The browser uses the publishable key. Auth0 configuration and Supabase configuration are mutually exclusive.

The API reads roles, groups, and source identity mappings from the server-only profile table on token validation, including a final validation before returning generated text. The browser cannot query that table. Existing browser sessions can be invalidated by removing their profile; new accounts added after API startup require a restart so ingestion can evaluate them. Source permission grants still require a valid delegated source credential.

## Live source configuration

Set `LIVE_SOURCES_JSON` on the API host to a JSON object with **all four** keys: `slack`, `jira`, `confluence`, and `drive`. Each entry has `ids`, `serviceAuthorization`, and `userAuthorizations`, keyed by the six workspace user IDs. Jira and Confluence also need an HTTPS `baseUrl` such as `https://example.atlassian.net`. The service credential reads content during ingestion; each user's credential is used for a fresh provider read to establish access. Use secrets from a server-side secret store or protected environment file; never put these values in `auth-config.json`.

```json
{
  "slack": {
    "ids": ["C0123456789"],
    "serviceAuthorization": "Bearer SERVICE_TOKEN",
    "userAuthorizations": { "ravi": "Bearer RAVI_TOKEN" }
  },
  "jira": {
    "baseUrl": "https://example.atlassian.net",
    "ids": ["PAY-101"],
    "serviceAuthorization": "Bearer SERVICE_TOKEN",
    "userAuthorizations": { "ravi": "Bearer RAVI_TOKEN" }
  },
  "confluence": {
    "baseUrl": "https://example.atlassian.net",
    "ids": ["123456789"],
    "serviceAuthorization": "Bearer SERVICE_TOKEN",
    "userAuthorizations": { "ravi": "Bearer RAVI_TOKEN" }
  },
  "drive": {
    "ids": ["GOOGLE_FILE_ID"],
    "serviceAuthorization": "Bearer SERVICE_TOKEN",
    "userAuthorizations": { "ravi": "Bearer RAVI_TOKEN" }
  }
}
```

Each Authorization value must be a complete provider-supported header value, such as `Bearer ...`. Create provider apps and grant the required read permissions in each organization. Slack needs `conversations.info` and `conversations.history` access for the listed channels; Jira needs issue read access; Confluence needs page read access; Drive needs file metadata plus text export or media access. Google Docs and `text/*` Drive files are indexed; other binary files are skipped. Slack indexes the latest 100 returned messages per listed channel. IDs are explicit: discovery, pagination, OAuth consent and token refresh are not implemented. Credentials must be maintained outside the app. Access checks fail closed if the provider denies access or a request fails. Do not enable live mode until the four entries and delegated credentials are ready.

The application does not change permissions at these providers. Change access in Slack, Jira, Confluence, or Drive. The next query consults the provider again, and the final response check repeats access validation after generation. A provider change during the final network check can still race the return; the app cannot make an external ACL update and its HTTP response atomic.

## OpenFGA

If `FGA_*` variables select a remote OpenFGA service, install `infra/fga/model.fga` in that store and set `FGA_MODEL_ID` to the installed version. The model now contains `public_reader`; existing model versions must be updated before enabling this code. The local tier rule and source checks also apply.
