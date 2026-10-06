import { InactiveInstallationError, requireCurrent, sameTeam } from "./runtime.js";
import { NotLinkedError } from "./broppy.js";
import { answerBlocks, suggestionBlocks, type Suggestion } from "./blocks.js";
import { confirmProposal, destinationPolicy, proposalUrl, validDestinationPolicy, validIssueUrl } from "./actions.js";
import { proposalId, type Proposal } from "./store.js";
import { handleMaintenance } from "./feedback.js";
import type { Deps } from "./config.js";
import { fingerprint, tokens } from "./fingerprint.js";
import { scoreMessage } from "./score.js";
import { verifySignature } from "./slack.js";

export interface SlackRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface SlackResponse {
  status: number;
  body?: unknown;
}

const ok = (body?: unknown): SlackResponse => ({ status: 200, ...(body === undefined ? {} : { body }) });
const ephemeral = (text: string) => ({ response_type: "ephemeral", replace_original: false, text });

const openAsk = (deps: Deps, question: string) => `${deps.webUrl}/workspace/index.html?ask=${encodeURIComponent(question)}`;

export async function handleSlack(deps: Deps, request: SlackRequest): Promise<SlackResponse> {
  if (request.path.endsWith("/feedback") || request.path.endsWith("/recovery")) return handleMaintenance(deps, request);
  if (request.method !== "POST") return { status: 405 };
  if (!verifySignature(deps.signingSecret, request.rawBody, request.headers["x-slack-request-timestamp"],
    request.headers["x-slack-signature"], deps.now().getTime())) {
    return { status: 401 };
  }
  try {
    if (request.path.endsWith("/events")) return await events(deps, JSON.parse(request.rawBody));
    const form = new URLSearchParams(request.rawBody);
    if (request.path.endsWith("/commands")) return commands(deps, form);
    if (request.path.endsWith("/interactions")) return await interactions(deps, JSON.parse(form.get("payload") ?? "null"));
    return { status: 404 };
  } catch (error) {
    // The detail goes to the host's log; Slack and the user only learn that it failed.
    console.error("slack handler failed", error);
    return ok(ephemeral("Broppy could not finish this request. Any recorded Jira result is preserved; retry to check its progress."));
  }
}

async function offer(deps: Deps, input: { text: string; channel: string; ts: string; threadTs?: string; authorSlackId?: string; teamId?: string }, explicitUser?: string): Promise<void> {
  const scored = scoreMessage(input.text, deps.people, new Date(Number(input.ts) * 1000), deps.threshold, input.authorSlackId);
  if (!explicitUser && (!scored.suggest || !scored.assignee)) return;
  const id = proposalId(input.channel, input.ts, input.teamId);
  let proposal = await deps.store.getProposal(id);
  if (!proposal) {
    const s: Suggestion = { t: scored.title, a: scored.assignee?.slackId ?? "", p: deps.channelProjects[input.channel] ?? deps.defaultProject,
      c: input.channel, ts: input.ts, s: scored.sentence.slice(0, 500), ...(scored.due ? { d: scored.due } : {}), ...(input.threadTs ? { th: input.threadTs } : {}) };
    const reviewer = s.a || explicitUser!;
    const permalink = await deps.slack.permalink?.(input.channel, input.ts);
    proposal = { id, revision: 1, suggestion: s, status: "pending", reviewerSlackId: reviewer,
      ...(input.teamId ? { teamId: input.teamId } : {}), ...(input.authorSlackId ? { authorSlackId: input.authorSlackId } : {}), ...(permalink ? { permalink } : {}) };
    if (!await deps.store.saveProposal(proposal)) proposal = await deps.store.getProposal(id);
  }
  if (!proposal || !sameTeam(deps.workspace, proposal.teamId) || proposal.status !== "pending") return;
  const claim = `suggest:${id}:${proposal.revision}`;
  if (!explicitUser && !await deps.store.claim(claim)) return;
  try { await showProposal(deps, proposal); }
  catch (error) { await deps.store.release(claim); throw error; }
}

async function showProposal(deps: Deps, proposal: Proposal): Promise<void> {
  if (!sameTeam(deps.workspace, proposal.teamId)) return;
  await requireCurrent(deps.workspace);
  const s = proposal.suggestion;
  const reviewer = proposal.reviewerSlackId ?? s.a;
  if (!reviewer) return;
  const policy = destinationPolicy(deps, proposal);
  const candidates = [];
  const email = await deps.slack.userEmail(reviewer);
  if (email) {
    const exact = await deps.store.findTask(s.p, fingerprint(s.p, s.t), tokens(s.t), deps.workspace?.teamId);
    const seen = new Set<string>();
    for (const candidate of [exact, ...await deps.store.candidates(s.p, fingerprint(s.p, s.t), tokens(s.t), deps.workspace?.teamId)].filter((c): c is NonNullable<typeof c> => Boolean(c))) {
      if (!sameTeam(deps.workspace, candidate.teamId) || seen.has(candidate.issueKey)) continue;
      seen.add(candidate.issueKey);
      try { const issue = await deps.broppy.issueAccess(email, candidate.issueKey); if (validIssueUrl(deps, issue.url)) candidates.push({ issueKey: issue.key, issueUrl: issue.url }); }
      catch {}
    }
  }
  await requireCurrent(deps.workspace);
  await deps.slack.postEphemeral({ channel: s.c, user: reviewer, text: `Review this commitment: ${s.t}`,
    blocks: suggestionBlocks(s, (deps.people.find(p => p.slackId === s.a)?.name ?? s.a) || "Owner unknown", proposalUrl(deps, proposal.id),
      { id: proposal.id, revision: proposal.revision }, candidates,
      validDestinationPolicy(policy) && policy!.disclosureFields.includes("permalink") ? proposal.permalink ?? `Slack channel ${s.c}, message ${s.ts}` : undefined,
      validDestinationPolicy(policy) ? policy!.allowedSlackIds : []), ...(s.th ? { thread_ts: s.th } : {}) });
}

async function events(deps: Deps, payload: any): Promise<SlackResponse> {
  if (payload?.type === "url_verification" && typeof payload.challenge === "string") return ok({ challenge: payload.challenge });
  const event = payload?.event;
  if (payload?.type !== "event_callback" || event?.type !== "message") return ok();
  if (event.bot_id || event.subtype || typeof event.text !== "string" || typeof event.channel !== "string" || typeof event.ts !== "string") return ok();
  await offer(deps, { text: event.text, channel: event.channel, ts: event.ts, threadTs: event.thread_ts, authorSlackId: event.user, teamId: payload.team_id });
  return ok();
}

/** /broppy <question>: acknowledged at once, answered through response_url, visible only to the asker. */
function commands(deps: Deps, form: URLSearchParams): SlackResponse {
  const question = (form.get("text") ?? "").trim();
  if (!question) return ok(ephemeral("Ask me something, for example `/broppy what's blocking wave three?`"));
  const user = form.get("user_id") ?? "";
  const responseUrl = form.get("response_url") ?? "";
  deps.defer(answer(deps, user, question, responseUrl));
  return ok({ response_type: "ephemeral", text: "Asking Broppy..." });
}

async function answer(deps: Deps, slackUser: string, question: string, responseUrl: string): Promise<void> {
  try {
    await requireCurrent(deps.workspace);
    const email = await deps.slack.userEmail(slackUser);
    if (!email) throw new NotLinkedError();
    const result = await deps.broppy.ask(email, question);
    await requireCurrent(deps.workspace);
    await deps.slack.respond(responseUrl, {
      response_type: "ephemeral", replace_original: true, text: result.text.slice(0, 200),
      blocks: answerBlocks(question, result, openAsk(deps, question))
    });
  } catch (error) {
    if (error instanceof InactiveInstallationError) return;
    await requireCurrent(deps.workspace);
    if (error instanceof NotLinkedError) {
      await deps.slack.respond(responseUrl, { ...ephemeral("Your Slack account isn't linked to a Broppy user yet. Ask an admin to add your Slack ID to your Broppy profile."), replace_original: true });
      return;
    }
    console.error("broppy answer failed", error);
    await deps.slack.respond(responseUrl, { ...ephemeral("Broppy couldn't answer that just now."), replace_original: true });
  }
}

async function interactions(deps: Deps, payload: any): Promise<SlackResponse> {
  const user: string = payload?.user?.id ?? "";
  if (payload?.type === "message_action" && payload.callback_id === "ask_broppy") {
    const question = String(payload.message?.text ?? "").trim().slice(0, 1000);
    if (!question) return ok();
    deps.defer(answer(deps, user, question, payload.response_url));
    return ok();
  }
  if (payload?.type === "message_action" && payload.callback_id === "track_broppy") {
    const text = String(payload.message?.text ?? "").trim().slice(0, 5000);
    const channel = payload.channel?.id;
    const ts = payload.message?.ts;
    if (!text || typeof channel !== "string" || typeof ts !== "string") return ok();
    await offer(deps, { text, channel, ts, threadTs: payload.message.thread_ts, authorSlackId: payload.message.user, teamId: payload.team?.id }, user);
    return ok();
  }
  if (payload?.type === "view_submission" && payload.view?.callback_id === "edit_commitment") return editSubmission(deps, payload, user);
  if (payload?.type !== "block_actions") return ok();
  const action = payload.actions?.[0];
  if (!["track_task", "dismiss_task", "edit_task", "link_task"].includes(action?.action_id)) return ok();
  let reference: any;
  try { reference = JSON.parse(action.value); } catch { return ok(); }
  if (typeof reference?.id !== "string" || !Number.isInteger(reference.revision)) return ok();
  const proposal = await deps.store.getProposal(reference.id);
  if (!proposal || !sameTeam(deps.workspace, proposal.teamId)) return ok(ephemeral("This proposal is unavailable."));
  if (user !== (proposal.reviewerSlackId ?? proposal.suggestion.a)) {
    await deps.slack.respond(payload.response_url, ephemeral(`Only <@${proposal.reviewerSlackId ?? proposal.suggestion.a}> can decide on this task.`)); return ok();
  }
  if (reference.revision !== proposal.revision && !proposal.operationId) {
    await deps.slack.respond(payload.response_url, ephemeral("This proposal changed. Review its latest revision.")); return ok();
  }
  if (action.action_id === "dismiss_task") {
    const saved = proposal.status === "pending" && await deps.store.saveProposal({ ...proposal, status: "dismissed", revision: proposal.revision + 1,
      reviewedBy: user, reviewedAt: deps.now().toISOString() }, proposal.revision);
    await deps.slack.respond(payload.response_url, saved ? { delete_original: true } : ephemeral("This proposal has already been reviewed or is being processed.")); return ok();
  }
  if (action.action_id === "edit_task") {
    if (proposal.status !== "pending" || !deps.slack.openView) return ok();
    await deps.slack.openView(payload.trigger_id, editView(proposal)); return ok();
  }
  if (action.action_id === "link_task" && typeof reference.issueKey !== "string") return ok();
  try {
    const line = await confirmProposal(deps, proposal, user, action.action_id === "link_task" ? reference.issueKey : undefined);
    await deps.slack.respond(payload.response_url, { ...ephemeral(line), replace_original: true });
    const current = await deps.store.getProposal(proposal.id);
    if (current?.status === "pending" && /choose Link existing/.test(line)) await showProposal(deps, current);
  } catch (error) {
    if (error instanceof NotLinkedError) { await deps.slack.respond(payload.response_url, ephemeral("Your Slack account must map to an active Broppy user. No shared Jira account is used.")); return ok(); }
    throw error;
  }
  return ok();
}

function editView(proposal: Proposal): Record<string, unknown> {
  const input = (id: string, label: string, initial: string, optional = false) => ({ type: "input", block_id: id, optional, label: { type: "plain_text", text: label },
    element: { type: "plain_text_input", action_id: "value", ...(initial ? { initial_value: initial } : {}) } });
  return { type: "modal", callback_id: "edit_commitment", private_metadata: JSON.stringify({ id: proposal.id, revision: proposal.revision }),
    title: { type: "plain_text", text: "Review commitment" }, submit: { type: "plain_text", text: "Save proposal" },
    blocks: [input("summary", "Summary sent to Jira", proposal.suggestion.t), input("owner", "Owner Slack ID", proposal.suggestion.a, true),
      input("due", "Due date (YYYY-MM-DD)", proposal.suggestion.d ?? "", true), input("project", "Jira project", proposal.suggestion.p)] };
}

async function editSubmission(deps: Deps, payload: any, user: string): Promise<SlackResponse> {
  let ref: any; try { ref = JSON.parse(payload.view.private_metadata); } catch { return ok(); }
  const proposal = typeof ref?.id === "string" ? await deps.store.getProposal(ref.id) : undefined;
  if (!proposal || !sameTeam(deps.workspace, proposal.teamId) || user !== (proposal.reviewerSlackId ?? proposal.suggestion.a) || proposal.revision !== ref.revision || proposal.status !== "pending") {
    return ok({ response_action: "errors", errors: { summary: "This proposal changed or is unavailable." } });
  }
  const values = payload.view.state?.values ?? {};
  const title = String(values.summary?.value?.value ?? "").trim();
  const owner = String(values.owner?.value?.value ?? "").trim();
  const due = String(values.due?.value?.value ?? "").trim();
  const project = String(values.project?.value?.value ?? "").trim().toUpperCase();
  const errors: Record<string, string> = {};
  if (!title || title.length > 255) errors.summary = "Enter a summary of at most 255 characters.";
  if (owner && !/^[UW][A-Z0-9]+$/.test(owner)) errors.owner = "Enter a Slack user ID.";
  if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due)) errors.due = "Enter a valid YYYY-MM-DD date.";
  if (!/^[A-Z][A-Z0-9_]{1,20}$/.test(project)) errors.project = "Enter a Jira project key.";
  if (Object.keys(errors).length) return ok({ response_action: "errors", errors });
  const { d: _oldDue, ...suggestion } = proposal.suggestion;
  const next = { ...proposal, revision: proposal.revision + 1, suggestion: { ...suggestion, t: title, a: owner, p: project, ...(due ? { d: due } : {}) } };
  if (!await deps.store.saveProposal(next, proposal.revision)) return ok({ response_action: "errors", errors: { summary: "This proposal changed. Reopen it." } });
  await showProposal(deps, next);
  return ok();
}
