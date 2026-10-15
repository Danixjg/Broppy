# Add customer workspaces to the shared Slack app

A provisioned organization admin adds Broppy from the **Slack bot** card on Connectors. The separate Slack source connection remains delegated import access. Each person's Jira actions still use their own Jira connection.

## Prepare the deployment

The API's Vercel entry also answers `/slack/*` with the Slack gateway whenever `SLACK_APP_ID` is set, so a single
deployment can be both the customer API and the gateway: use the API's origin as the gateway origin below
(`https://API-HOST/slack/events`, `/slack/commands`, `/slack/interactions`). `SLACK_SERVICE_TOKEN` need not be set on
it; migration 017 generates the service secret in Supabase Vault and the API reads it at startup.

1. Keep the old environment-token Slack server and scheduler stopped during cutover. The new gateway and CLI require `SLACK_APP_ID` and a durable installed-workspace registry. They refuse unknown or disconnected workspaces.
2. Apply `infra/supabase/migrations/010_slack_installations.sql` after migrations 001–009. For a fresh project, run `infra/supabase/schema.sql` instead. This repository does not apply hosted migrations automatically.
3. Configure one Slack app with token rotation disabled and workspace installations enabled. Enterprise organization-wide installations and expiring bot grants are refused. Generate its manifest with the shared gateway's HTTPS origin and each customer's exact HTTPS callback URL.

   ```sh
   pnpm exec tsx scripts/slack-manifest.ts \
     https://slack.example.com \
     https://customer-api.example.com/v1/admin/slack-installation/callback
   ```

4. Register the manifest's event, command, interaction, and OAuth callback URLs with Slack. Configure `SLACK_APP_ID`, `SLACK_SIGNING_SECRET`, and the shared registry credentials on the gateway. Configure a separate `SLACK_WORKER_TOKEN` of at least 32 characters if maintenance HTTP hooks are needed. Keep public distribution disabled until the OAuth installation check below passes.
5. Provision each existing Auth0 organization, API, and active directory. Configure the customer API with `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `API_ORIGIN`, and `WEB_ORIGIN`. Both origins must be HTTPS origins without paths. Register the exact callback from step 3. Add the installing admin's email to `workspace_users.platform_identities.slack`; it must match their directory email and the Slack account consenting.
6. Configure real source OAuth using [live sources and sign-in](live-sources-and-sign-in.md), and have each acting person connect their delegated Jira account. Bot installation does not configure source imports or grant Jira authority. Configure the customer API's trusted runtime from `.env.example`. This includes its Supabase task store, `SLACK_SERVICE_TOKEN`, Jira origin and project, people, channel projects, disclosure audiences, and completion policy. The API publishes only its own configured organization and settings. Customer forms and Slack requests cannot supply routing destinations.
7. Deploy the configured gateway and your own organization's API. Sign in as an active directory admin and open Connectors. Click **Add to Slack** and select the workspace where you created the Slack app. Authorize the same Slack account and confirm that Connectors shows the connected workspace. Invite Broppy to a watched channel and verify that `/broppy` returns a private answer. Use this OAuth flow for your own workspace as well as customer workspaces. A token copied from Slack's **Install App** page does not create a Broppy installation record.
8. Before enabling public distribution, remove any workspace OAuth token literals or incoming-webhook URLs from application source and deployment configuration. The gateway reads each bot token from its Vault-backed OAuth installation record. Keep the app's client secret and signing secret in server-only deployment secrets. Registered HTTPS request and callback URLs remain required app configuration. Broppy uses Slack's Web API and needs no configured incoming webhook. In Slack app settings, open **Settings → Manage Distribution**, complete the checklist, and click **Activate Public Distribution**. Follow Slack's [distribution setup](https://docs.slack.dev/app-management/distribution/). Customers can then use **Add to Slack** in their own provisioned Broppy organizations. Real installation and distribution activation are operator actions.

`SLACK_REGISTRY_URL` and `SLACK_REGISTRY_SECRET_KEY` select an explicit shared control-plane Supabase project. Set both on every customer API and the gateway. If neither is set, the registry uses that process's `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. The customer API's task-store project may differ from the registry project. Both projects require the schema through 010. Registry service-role credentials and the shared gateway are trusted infrastructure and can read the Vault-backed runtime for all installations.

## Change or disconnect an installation

An app/organization remains pinned to its first Slack team, including after disconnect or uninstall. Reinstalling that same team replaces the owned Vault grant and increments its generation. A cross-organization claim, workspace change, failed grant, or older callback preserves the current installation. Workspace replacement requires a separately reviewed operator migration.

After changing customer deployment settings, an active admin clicks **Refresh workspace settings**. This replaces the Vault runtime snapshot and increments the generation. The gateway resolves fresh dependencies per request and checks the captured generation before new Slack or API effects. An external write already in flight can still finish; its known receipt remains durable under migration009.

**Disconnect from Broppy** disables routing locally, increments the generation, invalidates pending install attempts, and deletes the owned Vault secret. It keeps task and recovery history. It does not revoke Slack grants or uninstall the app. The Slack workspace administrator removes the app from Slack separately. Failed or colliding installs never remotely revoke a token because Slack can reuse a currently valid grant.

Uninstall and bot-token-revocation notifications probe the current token with `auth.test`. A valid current token leaves the installation active. A definitive invalid-token response deactivates only the captured generation. Transient failures remain retryable. User-token revocations do not remove the bot installation.

Historical proposals, actions, and links without a matching Slack team remain withheld from automated actions and feedback. History stays visible through the organization API. Bot queries filter by team before bounded work limits, so old teamless rows cannot starve current work.

## Run maintenance and verification

Maintenance requires the gateway worker bearer before any registry lookup and an explicit `teamId`.

```sh
curl -X POST https://slack.example.com/slack/feedback \
  -H 'Authorization: Bearer YOUR_WORKER_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"teamId":"T123","limit":25}'
pnpm exec tsx apps/slack/src/feedback-worker.ts T123 25
```

Recovery uses the same team selector plus `operationId`, `issueKey`, and `actorSlackId`. Its existing read-verified operation-marker rules still apply.

Run the focused deterministic checks with the installed dependencies.

```sh
pnpm exec vitest run --pool=forks \
  apps/api/src/slack-installation.test.ts apps/api/src/source-oauth.test.ts \
  apps/api/src/service-jira.test.ts apps/slack/src/gateway.test.ts \
  apps/slack/src/onboarding.test.ts apps/slack/src/handler.test.ts \
  apps/slack/src/feedback.test.ts apps/slack/src/store.test.ts
pnpm typecheck
node --import tsx tools/check-slack-onboarding.mjs
```

The browser harness serves the actual Connectors HTML/JS and uses the actual API installation routes. It controls Auth0 JWKS/session, Slack consent/provider responses, and registry storage through local HTTP boundaries. Browser hosting origins map to loopback; the actual callback status and configured return Location are asserted before a loopback browser redirect. It uses a plaintext in-memory registry adapter and makes no Vault encryption claim. The browser uses a provided in-memory Brain with mock source connectors; it does not prove live-source setup. It also sends signed HTTP for two organizations through one gateway using the actual scoped Slack, API, and task-store clients against controlled HTTP boundaries. It writes screenshots and a report to `SLACK_CHECK_ARTIFACTS`, defaulting to `/tmp/broppy-slack-onboarding/browser`. Set `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_BROWSERS_PATH` for your local Playwright installation. No live credentials are loaded, and no live Slack app is installed by this harness.

The scope and manifest source is [app-manifest.ts](../apps/slack/src/app-manifest.ts). Slack's [OAuth v2 documentation](https://docs.slack.dev/authentication/installing-with-oauth/), [auth.test reference](https://docs.slack.dev/reference/methods/auth.test/), and [token rotation guide](https://docs.slack.dev/authentication/using-token-rotation/) describe the provider boundary. A real Slack development-workspace install and signed delivery remain activation checks after operator credentials and hosted migration are ready.
