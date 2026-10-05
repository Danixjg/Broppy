# Broppy for Slack

Mirrors the "How Broppy works in Slack" mockup:

1. **Spot a task.** Each channel message is scored by fixed rules (`src/score.ts`: an "Agreed:"/"Action:" cue +0.45, a named owner +0.2, an action verb +0.15, a date +0.15, commitment wording +0.1, a question -0.4, hedging -0.3; clamped to 0..1). At 0.6 or more with a named owner, Broppy shows *Looks like a task* privately to that owner with **Track in Jira**, **Open in Broppy ↗** and **Not a task**. No model is involved, so the same message always scores the same.
2. **Only the receiver decides.** A click from anyone other than the owner is refused privately. **Track in Jira** creates the issue with the confirming person's own Jira connection (their "My accounts" connection in Broppy), or the shared `JIRA_*` account if they haven't connected; a failure on their own connection is reported, not retried with the shared account. It then replies in the thread with *Tracked as DB-16*.
3. **Repeats update, not duplicate.** Before creating, the task is looked up in Supabase (`slack_task_links`) by fingerprint (project plus stemmed, sorted title words) and by 75% word overlap. A match gets a Jira comment and a bumped `mention_count`.
4. **Ask without leaving.** `/broppy <question>` and the **Ask Broppy** message shortcut answer with a short cited reply visible only to the asker, as that person: the app looks up the Slack user's email, sends it with a shared secret, and the API maps it to a Broppy user through its directory (`platform_identities.slack`, which already holds that email), so existing permissions apply. No per-user token is needed because Slack's company SSO only signs people into Slack; Slack gives the app a signed user ID, not an Auth0 token.

## Endpoints (one Vercel function, `api/index.ts`)

| Slack setting | URL |
| --- | --- |
| Event Subscriptions: Request URL | `https://<host>/slack/events` |
| Slash Commands: `/broppy` | `https://<host>/slack/commands` |
| Interactivity: Request URL, and the message shortcut `ask_broppy` ("Ask Broppy") | `https://<host>/slack/interactions` |

Bot scopes: `chat:write`, `commands`, `users:read`, `users:read.email`, `channels:history`, `groups:history` (private channels), `channels:read`. Bot events: `message.channels`, `message.groups`. Invite the bot to each channel it should watch.

## Settings (environment variables)

| Variable | Use |
| --- | --- |
| `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` | From the Slack app (Basic Information, OAuth & Permissions). |
| `SLACK_USERS_JSON` | `[{"slackId":"U123","name":"Maya","jiraAccountId":"..."}]`. How people are named in messages, and their Jira account. Broppy identity no longer comes from here. |
| `SLACK_SERVICE_TOKEN` | A random secret of 32+ characters, set the same on the Slack app and on the API. The API accepts it on `POST /v1/query` and `POST /v1/service/jira/issue|comment` only, together with `x-act-as-slack-email`. The Jira routes need `SOURCE_OAUTH_JSON` with the `write:jira-work` scope. |
| `SLACK_CHANNEL_PROJECTS_JSON` | Optional `{"C0123":"DB"}`, Slack channel ID to Jira project. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DEFAULT_PROJECT` | Jira Cloud site, an API-token account, and the project for unmapped channels. |
| `BROPPY_API_URL`, `BROPPY_WEB_URL` | The Broppy API and the web app, for the Open in Broppy links. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AUTH0_ORG_ID` | The cache. Apply `infra/supabase/migrations/006_slack_tasks.sql`. Without `SUPABASE_URL` an in-memory store is used (not allowed when `NODE_ENV=production`). |
| `TASK_SCORE_THRESHOLD` | Optional, default `0.6`. |

Deploy as its own Vercel project with root directory `apps/slack`.

## Not built yet

- Each person's Slack email must match their directory `platform_identities.slack`.
- `SLACK_USERS_JSON` is still needed to match names in messages to Slack IDs. Reading names from the directory would remove it.
- The web app doesn't read the `?task=` and `?ask=` links yet, so Open in Broppy lands on the workspace.
- Slack message permalinks aren't added to Jira issues; they carry the sentence and channel ID.
