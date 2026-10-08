import { InactiveInstallationError, requireCurrent, sameTeam } from "./runtime.js";
import { JiraRefusedError, NotLinkedError } from "./broppy.js";
import { trackedLine } from "./blocks.js";
import type { Deps } from "./config.js";
import { destinationPolicy, validDestinationPolicy, validIssueUrl, mayDiscloseIssue } from "./disclosure.js";
export { destinationPolicy, validDestinationPolicy, validIssueUrl } from "./disclosure.js";
import { fingerprint, tokens } from "./fingerprint.js";
import { SlackDeliveryError } from "./slack.js";
import { commitmentFingerprint, type Proposal, type TaskLink, type TaskOperation } from "./store.js";

export const taskUrl = (deps: Deps, issueKey: string) => `${deps.webUrl}/workspace/index.html?task=${encodeURIComponent(`jira:${issueKey}`)}`;
export const proposalUrl = (deps: Deps, id: string) => `${deps.webUrl}/workspace/index.html?proposal=${encodeURIComponent(id)}`;
async function activeEmail(deps: Deps, user: string) {
  const email = await deps.slack.userEmail(user);
  if (!email) throw new NotLinkedError();
  await deps.broppy.actor(email);
  return email;
}
const pending = "Jira may have accepted this action. It is waiting for reconciliation; no second issue will be created.";
const unavailable = "Your account must be active in Broppy, and your administrator must have connected Jira to Broppy.";

export async function confirmProposal(deps: Deps, proposal: Proposal, user: string, selectedIssueKey?: string): Promise<string> {
  if (!sameTeam(deps.workspace, proposal.teamId)) return "This proposal is unavailable in this Slack workspace.";
  await requireCurrent(deps.workspace);
  if (proposal.status === "dismissed") return "This proposal was dismissed.";
  const email = await activeEmail(deps, user);
  const members = await deps.slack.members?.(proposal.suggestion.c);
  if (!members?.includes(user)) return "You must still be a member of the source channel to review this commitment.";
  const policy = destinationPolicy(deps, proposal);
  if (!validDestinationPolicy(policy)) return "This channel and Jira project have no complete approved audience and disclosure policy. Ask an admin to configure the destination.";
  if (policy!.allowedSlackIds.some(id => !members.includes(id))) return "The declared Jira audience includes someone outside this source channel. No Jira content was sent.";
  let op = proposal.operationId ? await deps.store.getOperation(proposal.operationId) : undefined;
  if (!op && proposal.status !== "pending") return proposal.issueKey ? `Already linked to ${proposal.issueKey}.` : "This proposal has already been reviewed.";
  if (!op) {
    const s = proposal.suggestion;
    let existing = await deps.store.findTask(s.p, fingerprint(s.p, s.t), tokens(s.t), deps.workspace?.teamId);
    if (selectedIssueKey) {
      existing = [existing, ...await deps.store.candidates(s.p, fingerprint(s.p, s.t), tokens(s.t), deps.workspace?.teamId)].find(l => l?.issueKey === selectedIssueKey);
      if (!existing) return "That candidate is no longer available. Review the current proposal.";
    }
    if (existing && !sameTeam(deps.workspace, existing.teamId)) return "The existing task has no matching Slack workspace provenance. Contact an administrator.";
    if (existing) {
      const access = await deps.broppy.issueAccess(email, existing.issueKey);
      if (!validIssueUrl(deps, access.url)) return "The Jira destination is outside the configured site.";
      existing = { ...existing, issueUrl: access.url };
      if (!selectedIssueKey) return "An existing issue is available. Review the proposal and choose Link existing.";
    }
    op = existing ? await deps.store.reserveLinkOperation(proposal, user, existing) : await deps.store.reserveOperation(proposal, user);
    if (!op) return "The proposal changed. Review its latest revision.";
  }
  if (!sameTeam(deps.workspace, op.proposal.teamId)) return "This action is unavailable in this Slack workspace.";
  if (op.proposalId !== proposal.id && proposal.operationId !== op.id && selectedIssueKey !== op.issueKey) return "This title already has an approved operation. Review and choose Link existing after its issue is recorded.";
  if (op.state === "creating" || op.state === "uncertain") return pending;
  if (op.proposalId !== proposal.id && (op.state === "reserved" || op.state === "refused")) return "The original approval is pending. Retry after it is recorded.";
  if (op.state === "reserved" || op.state === "refused") {
    const claimed = await deps.store.advanceOperation(op.id, op.state, { state: "creating" });
    if (!claimed) return "This action is being processed. Retry to see its result.";
    op = claimed;
    const s = op.proposal.suggestion;
    const person = deps.people.find(p => p.slackId === s.a);
    try {
      const source = policy!.disclosureFields.includes("permalink") ? `\nSource: ${op.proposal.permalink ?? `Slack channel ${s.c}, message ${s.ts}`}` : "";
      await requireCurrent(deps.workspace);
      const created = await deps.broppy.createIssue(email, { project: s.p, summary: s.t, assigneeAccountId: person?.jiraAccountId, dueDate: s.d,
        description: `Approved summary: ${s.t}${source}\nBroppy operation: ${op.id}` });
      if (!created) {
        await deps.store.advanceOperation(op.id, "creating", { state: "refused" });
        return unavailable;
      }
      const saved = await deps.store.advanceOperation(op.id, "creating", { state: "remote_succeeded", issueKey: created.key, issueUrl: created.url });
      if (!saved) return pending;
      op = saved;
    } catch (error) {
      const refused = error instanceof NotLinkedError || error instanceof JiraRefusedError || error instanceof InactiveInstallationError;
      await deps.store.advanceOperation(op.id, "creating", { state: refused ? "refused" : "uncertain" }).catch(() => undefined);
      if (refused) return unavailable;
      console.error("Jira action needs reconciliation", { operationId: op.id });
      return pending;
    }
  }
  if (!op.issueKey || !op.issueUrl || !validIssueUrl(deps, op.issueUrl)) return pending;
  if (op.proposalId !== proposal.id) {
    const access = await deps.broppy.issueAccess(email, op.issueKey);
    if (!validIssueUrl(deps, access.url)) return "The Jira destination is outside the configured site.";
  }
  if (op.state === "remote_succeeded") {
    const s = op.proposal.suggestion;
    const link: TaskLink = { fingerprint: commitmentFingerprint(op.proposalId), titleFingerprint: op.fingerprint, project: op.project, title: s.t, tokens: tokens(s.t), issueKey: op.issueKey, issueUrl: op.issueUrl,
      assigneeSlackId: s.a, trackedBy: op.actorSlackId, channel: s.c, messageTs: s.ts, threadTs: s.th ?? s.ts, mentionCount: 1,
      teamId: op.proposal.teamId, authorSlackId: op.proposal.authorSlackId, permalink: op.proposal.permalink, operationId: op.id };
    await deps.store.saveTask(link);
    const advanced = await deps.store.advanceOperation(op.id, "remote_succeeded", { state: "linked" });
    if (!advanced) return "This action is being recorded. Retry to see its result.";
    op = advanced;
  }
  const current = await deps.store.getProposal(proposal.id);
  if (!current || (current.status !== "pending" && current.operationId !== op.id)) return "This proposal has already been reviewed.";
  if (current?.status === "pending") {
    if (!await deps.store.completeProposal(current.id, proposal.revision, op.id, user, deps.now().toISOString())) return "This proposal changed while the issue was recorded. Review its current state.";
  }
  if (op.proposalId !== proposal.id) {
    const s = proposal.suggestion;
    await deps.store.saveTask({ fingerprint: commitmentFingerprint(proposal.id), titleFingerprint: fingerprint(s.p, s.t), project: s.p, title: s.t, tokens: tokens(s.t),
      issueKey: op.issueKey!, issueUrl: op.issueUrl!, assigneeSlackId: s.a, trackedBy: user, channel: s.c, messageTs: s.ts, threadTs: s.th ?? s.ts, mentionCount: 1,
      teamId: proposal.teamId, authorSlackId: proposal.authorSlackId, permalink: proposal.permalink, operationId: op.id });
  }
  const originalLink = await deps.store.findTask(op.project, op.fingerprint, [], deps.workspace?.teamId);
  if (originalLink && sameTeam(deps.workspace, originalLink.teamId) && originalLink.issueKey === op.issueKey) await deps.store.recordRepeat(originalLink, proposal.suggestion.c, proposal.suggestion.ts);
  if (op.proposalId !== proposal.id) return `Linked to <${op.issueUrl}|${op.issueKey}>. The original source is preserved.`;
  return notifyTracking(deps, op);
}

async function notifyTracking(deps: Deps, op: TaskOperation): Promise<string> {
  const s = op.proposal.suggestion;
  const name = deps.people.find(p => p.slackId === s.a)?.name ?? `<@${s.a}>`;
  const line = trackedLine(op.issueKey!, op.issueUrl!, op.actorSlackId, name, s.d, taskUrl(deps, op.issueKey!), op.existing);
  const sourceLink: TaskLink = { fingerprint: commitmentFingerprint(op.proposalId), project: op.project, title: s.t, tokens: [], issueKey: op.issueKey!, issueUrl: op.issueUrl!, assigneeSlackId: s.a,
    trackedBy: op.actorSlackId, channel: s.c, messageTs: s.ts, threadTs: s.th ?? s.ts, mentionCount: 1, teamId: op.proposal.teamId };
  if (!await mayDiscloseIssue(deps, sourceLink, "tracking")) return "The Jira link is saved. Its channel announcement is withheld until every approved recipient can read the issue. Retry checks notification only.";
  if (op.state === "notified") return line;
  if (op.state === "notifying") {
    const ts = await deps.slack.findMessage?.(s.c, s.th ?? s.ts, op.id);
    if (ts) { await deps.store.advanceOperation(op.id, "notifying", { state: "notified", messageTs: ts }); return line; }
    return "The Jira link is saved. The Slack notification is waiting for reconciliation.";
  }
  if (op.state !== "linked") return line;
  const claimed = await deps.store.advanceOperation(op.id, "linked", { state: "notifying" });
  if (!claimed) return "The Jira link is saved. Its notification is being processed.";
  try {
    await requireCurrent(deps.workspace);
    const sent = await deps.slack.postMessage({ channel: s.c, thread_ts: s.th ?? s.ts, text: line, client_msg_id: op.id });
    await deps.store.advanceOperation(op.id, "notifying", { state: "notified", ...(sent ? { messageTs: sent.ts } : {}) });
    return line;
  } catch (error) {
    if (error instanceof SlackDeliveryError || error instanceof InactiveInstallationError) await deps.store.advanceOperation(op.id, "notifying", { state: "linked" });
    return "The Jira link is saved. Retry to check or deliver its Slack notification.";
  }
}

export async function reconcileOperation(deps: Deps, id: string, issueKey: string, actorSlackId: string): Promise<boolean> {
  const op = await deps.store.getOperation(id);
  if (!op || !sameTeam(deps.workspace, op.proposal.teamId) || !["uncertain", "creating"].includes(op.state) || op.actorSlackId !== actorSlackId) return false;
  await requireCurrent(deps.workspace);
  const email = await activeEmail(deps, actorSlackId);
  const issue = await deps.broppy.issueAccess(email, issueKey);
  if (issue.operationMarker !== op.id || !validIssueUrl(deps, issue.url)) return false;
  return Boolean(await deps.store.advanceOperation(op.id, op.state, { state: "remote_succeeded", issueKey: issue.key, issueUrl: issue.url }));
}
