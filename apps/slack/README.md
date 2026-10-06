# Broppy for Slack

Broppy stores one reviewable commitment per Slack message. Passive rules and the `track_broppy` message shortcut propose a summary, owner, date, and project. First-person commitments use the source author. The owner reviews the proposal privately, edits its draft, dismisses it, creates an issue, or chooses a visible existing candidate. Buttons contain only the stored proposal ID and revision. A dismissal survives restarts. Pending edits and dismissals are blocked while an action is reserved, creating, uncertain, or already has a persisted result. A definite refusal can be retried or edited, which releases its no-effect reservation.

Jira writes require an active mapped Broppy actor and their connected Jira account. The shared Jira account is never used. The destination must explicitly declare its channel, project, complete recipient scope, and allowed disclosure fields. Review shows all outbound fields. Jira receives the approved summary and optionally its approved source pointer, without the private source excerpt. Exact title matches require an explicit Link existing choice and never add comments. Similarity only proposes a candidate for review.

Concurrent confirmations reserve one exact project/title operation in Supabase before creation. Each source retains its own commitment record. Another source stays pending until its reviewer explicitly links the recorded issue. A returned Jira identity is persisted before task recording and Slack delivery. Retry after task-recording failure uses that identity. A channel announcement requires every current human channel member to belong to the declared audience and have an active Broppy mapping with delegated Jira read access. A denied member withholds the announcement while keeping the Jira receipt. A confirmed Slack delivery rejection retries notification alone. A timed-out Jira or Slack write stays unresolved until reconciliation proves its result. No unknown outcome automatically creates or posts again.

## Slack setup

| Slack setting | URL |
| --- | --- |
| Message events | `https://<host>/slack/events` |
| Slash command `/broppy` | `https://<host>/slack/commands` |
| Interactivity and shortcuts `ask_broppy`, `track_broppy` | `https://<host>/slack/interactions` |

Bot scopes include `chat:write`, `commands`, `users:read`, `users:read.email`, `channels:history`, `groups:history`, `channels:read`, and `groups:read`. Invite the app to each watched channel. Bot events are `message.channels` and `message.groups`. Bots and message subtypes do not trigger proposals. Slack's [thread read API](https://docs.slack.dev/reference/methods/conversations.replies/) must permit the app to read the original thread for uncertain-delivery reconciliation. If that read is unavailable, the delivery remains unresolved.

`/broppy` and the Ask Broppy shortcut return permission-filtered answers privately. Deep links use the `/workspace/index.html` route and an exact proposal or Jira document identity.

## Settings

| Variable | Use |
| --- | --- |
| `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` | Slack app credentials. |
| `SLACK_USERS_JSON` | People used for name matching and Jira assignee mapping, such as `[{"slackId":"U123","name":"Maya","jiraAccountId":"account-id"}]`. |
| `SLACK_SERVICE_TOKEN` | The same service secret of at least 32 characters configured on the API. |
| `SLACK_CHANNEL_PROJECTS_JSON`, `JIRA_DEFAULT_PROJECT` | Channel/project suggestions and fallback project. |
| `JIRA_BASE_URL` | The approved HTTPS Jira site. Shared email/API-token credentials are unnecessary. |
| `SLACK_JIRA_DESTINATIONS_JSON` | Explicit disclosure policy, such as `[{"channel":"C123","project":"DB","allowedSlackIds":["U123","U456"],"disclosureFields":["summary","permalink"]}]`. The administrator declares the complete Jira destination audience. Every declared recipient and the reviewer must still be a source-channel member. `summary` approval is required, and source pointers are omitted unless `permalink` is approved. Empty by default, which refuses creation and linking. |
| `SLACK_COMPLETION_POLICY_JSON` | Completion recipients, such as `[{"channel":"C123","project":"DB","allowedSlackIds":["U123","U456"]}]`. Empty by default. |
| `SLACK_WORKER_TOKEN` | Optional bearer secret of at least 32 characters for the maintenance HTTP hooks. Without it those hooks refuse every request. |
| `BROPPY_API_URL`, `BROPPY_WEB_URL` | API and web origins. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AUTH0_ORG_ID` | Durable organization-scoped server store. Apply migration `006_slack_tasks.sql`, then `009_slack_action_recovery.sql` after the existing migrations. Production requires Supabase. |
| `TASK_SCORE_THRESHOLD` | Passive suggestion threshold, default `0.6`. |

The API must expose authenticated service routes `POST /v1/service/actor` and `POST /v1/service/jira/access` in addition to its existing issue and query routes. The access route reads Jira as the active person and returns only the authorized key, URL, category, provider version, and an optional operation marker.

## Completion worker and recovery

An external scheduler can call `POST /slack/feedback` with `Authorization: Bearer <SLACK_WORKER_TOKEN>` and `{"limit":25}`. The limit must be 1 through 50. No scheduler is deployed by this change. Run a bounded local pass from the repository root with `node --env-file=.env.local --import tsx apps/slack/src/feedback-worker.ts 25`.

The worker polls already-linked issues through delegated read credentials. Its first observation initializes a baseline. A later transition to `done` schedules one lifetime completion notice per source commitment. Delivery requires an approved recipient policy, current Slack membership, and an active Broppy actor with Jira read access for every human recipient. The app's own bot is excluded. Other bots and unmapped recipients cause refusal. The notice contains only the approved issue reference and completion statement. Feedback never calls a Jira write route.

Slack messages carry a stable `client_msg_id`. Successful delivery records Slack's timestamp. Confirmed rejection stays pending. An ambiguous result reconciles by finding that ID in the source thread; absence never proves failure and never causes a blind repost.

For uncertain Jira creation, an operator supplies an issue that contains the exact `Broppy operation: <UUID>` marker. Call authenticated `POST /slack/recovery` with `{"operationId":"...","issueKey":"DB-12","actorSlackId":"U123"}`. The server verifies the original active actor's delegated issue read and marker, then records the remote identity. Retry the original approval to finish recording and notification. A missing search result cannot reset an uncertain operation.

Stop the old confirmation handler before applying the migration and starting this version. An old process bypasses the new reservations. The store retains existing `slack_task_links`, backfills legacy links as reviewed proposals, and treats old `track:*` claims without a recorded issue as unresolved legacy operations. Legacy writes have no operation marker and require operator investigation before any durable manual reconciliation. Original channel/message fields are immutable. Repeated sightings are separate deduplicated rows. The application currently supports one configured Jira site per organization. Policy declarations must accurately describe the complete Jira audience; this implementation checks declared users against current Slack membership and does not enumerate Jira project permission schemes. Destination policy declarations are capped at 100 recipients and Slack membership checks at 1,000 recipients. Candidate search is bounded to 500 recent links; exact issue lookup uses its own index.

## Verification

Run `pnpm exec vitest run apps/slack/src` and `pnpm exec tsc --noEmit`. After applying the migrations to an isolated local PostgreSQL database with the Supabase roles, `psql -v ON_ERROR_STOP=1 -f apps/slack/verify-recovery.sql` exercises revision conflicts, source immutability, operation reservation, retry state, repeat origins, organization isolation, and completion deduplication. It rolls its fixture transaction back.

Deploy Slack as its own Vercel project with root directory `apps/slack`. Enable **Include source files outside of the Root Directory in the Build Step**. Its build command compiles the Rust task parser for the deployment host and includes the native module in the function. See [Vercel monorepo settings](https://vercel.com/docs/monorepos/monorepo-faq). No deployment or provider write is part of these local checks.
