# Broppy commitment workflow implementation

The parallel build implements the six bounded batches proposed in the other Codex window's repository audit. The starting revision was `6e3f97a612e43ec2875c5bff5c0c205cc6e6de99`. Work ran in isolated checkouts and was merged with the other window's completed Rust migration. The narrower A1/A2 Slack patch was compared before integration; its unknown legacy-outcome fence and confirmed-no-effect reservation rules are retained in the broader canonical proposal model.

## Resulting behavior

| Batch | Implemented behavior |
| --- | --- |
| Authorized, recoverable Jira actions | Active mapped actors use personal Jira credentials. No shared fallback. An atomic normalized project/title reservation protects creation; separate source-scoped link operations permit different same-title work and deduplicate each source acknowledgement; known issue receipts survive storage and notification failures. Unknown writes stay blocked until positive reconciliation. |
| Faithful evidence and source outages | Native grounding checks actor/recipient roles, negation and planned/current/completed timing. Temporary source failures preserve confirmed records and grants while withholding current access; healthy sources finish independently. |
| Workspace controls and navigation | The UI identifies live or demo mode, exposes supported actions, preserves exact Slack proposal/task/question links, reapplies links after identity changes and sends selected project scope to the API. Audit summaries include connection and Slack Jira events. |
| Durable commitment triage | Slack and web share revision-checked proposals. Reviewers can edit, dismiss, link an authorized issue or approve creation in the supported flow. First-person authors require explicit active identity mappings. Source author, channel, thread/message timestamps and provider permalink remain distinct evidence. |
| Terminal Jira feedback | A bounded read-only worker observes linked issues and posts one permitted completion notice per source. Each current human recipient must have delegated issue access. Delivery recovery never replays an unknown post blindly and never mutates Jira. |
| Incremental sync and repeatable checks | Jira compares bounded `updated` metadata against a durable checkpoint before reading unchanged content. Every twelfth poll reconciles full records. CI runs native, TypeScript, web and actual browser checks. |

Possible untracked commitments state the accessible imported scope, freshness and failed-source coverage. Missing owners or dates remain unknown. Similarity proposes candidates; explicit review establishes a link. Foreign Jira/Confluence/Slack URL origins cannot impersonate connected sources, and Drive links require Google's origins. The dataset validator explicitly supplies its fictional source origins and normalizes its two fictional Drive hosts only for fixture-format validation; the production link parser retains the Google-only rule.

The content index, native permission checks and existing source ACL boundaries remain in use. Live workspace creation and completion controls accurately reflect the current read-only API: Jira writes run through Slack's reviewed delegated service workflow. The demo create path also retains a persisted receipt across injected post-create failures and restarts.

## Configuration and cutover

1. Stop old Slack confirmation handlers before applying `infra/supabase/migrations/009_slack_action_recovery.sql` after migrations 001–008. Old running code bypasses the new reservations. Fresh projects use `infra/supabase/schema.sql`, whose appended 009 section matches the migration. Do not apply the competing narrower 009 schema.
2. Configure the API and Slack service secret, organization-scoped Supabase store, approved Jira site and personal Jira OAuth access. Actor resolution remains through directory email credentials. Add `brainUserId` alongside each `slackId` in `SLACK_USERS_JSON` on both deployments to resolve live first-person authors; missing mappings leave ownership unknown.
3. Explicitly configure `SLACK_JIRA_DESTINATIONS_JSON` for each source channel/project, its complete Jira recipient audience and approved `summary`/optional `permalink` disclosure fields. The private preview displays the declaration and outbound fields. An empty or invalid policy refuses writes. **The administrator must attest that this declaration covers every actual Jira reader. Jira permission schemes are not enumerated by this implementation.** A mistaken declaration can disclose source-derived text on creation even though subsequent Slack announcements check every current recipient's delegated read access.
4. Configure `SLACK_COMPLETION_POLICY_JSON` and `SLACK_WORKER_TOKEN`, then schedule bounded calls to `POST /slack/feedback` or run the documented worker command. No scheduler or deployment is installed by this change.
5. Reconcile an uncertain new Jira write only with an authorized issue containing its exact `Broppy operation: <UUID>` marker via `POST /slack/recovery`. A missing search result does not prove failure. Unmarked legacy claims require investigation and durable operator reconciliation; separate legacy fences survive an overlapping operation's definite refusal.

See [Slack setup and recovery](../apps/slack/README.md), [live sources and sign-in](live-sources-and-sign-in.md), and [Rust migration](rust-migration.md).

## Verification

`pnpm test`, `pnpm typecheck`, `pnpm rust:check`, `pnpm rust:smoke` and `node tools/check-workspace.mjs` cover this work and run in CI. `apps/slack/verify-recovery.sql` checks the recovery migration against a local PostgreSQL database; see [Slack setup and recovery](../apps/slack/README.md).

The browser harness runs the real API and Next server with a sanitized demo environment. It verifies edit/save/reload/create, authorized exact issue navigation, identity-switch access denial and recovery, and scoped/unscoped questions. It makes no provider writes. Vitest uses isolated process workers: the native thread pool completed cases but stalled during worker teardown, while the process pool exits normally.

## Practical limits

No live SSO/provider session, hosted database migration, scheduler, deployment, Docker or Vercel release was exercised. The destination audience is an explicit administrative trust boundary. Slack membership verification is bounded to 1,000 members and configured destination audiences to 100; recent candidate discovery is bounded to 500 links, while exact lookup is indexed. One Jira site per organization is supported. Completion notices occur once per source lifetime, without reopen/close comment synchronization. Missing reconciliation identifiers remain unresolved. Rule-based grounding is conservative and still has known cause/order/synonym limits; it is not a general semantic parser. Provider checkpoints reduce configured Jira reads; they do not implement provider-wide webhooks or incremental imports for every source.
