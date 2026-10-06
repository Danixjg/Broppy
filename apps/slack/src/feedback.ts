import { timingSafeEqual } from "node:crypto";
import { reconcileOperation, validIssueUrl } from "./actions.js";
import type { Deps } from "./config.js";
import type { SlackRequest, SlackResponse } from "./handler.js";
import { SlackDeliveryError } from "./slack.js";
import { mayDiscloseIssue } from "./disclosure.js";

export async function runCompletionFeedback(deps: Deps, limit = 25): Promise<{ observed: number; delivered: number; withheld: number }> {
  const bound = Math.min(50, Math.max(1, Math.trunc(limit)));
  const result = { observed: 0, delivered: 0, withheld: 0 };
  for (const link of await deps.store.listTasks(bound)) {
    try {
      const email = await deps.slack.userEmail(link.trackedBy);
      if (!email) continue;
      const issue = await deps.broppy.issueAccess(email, link.issueKey);
      if (!validIssueUrl(deps, issue.url)) continue;
      await deps.store.observeCompletion(link, issue);
      result.observed++;
    } catch { result.withheld++; }
  }
  for (const job of await deps.store.pendingFeedback(bound)) {
    try {
      if (!await mayDiscloseIssue(deps, job.link, "completion")) { result.withheld++; continue; }
      if (job.state === "sending" || job.state === "uncertain") {
        const ts = await deps.slack.findMessage?.(job.link.channel, job.link.threadTs ?? job.link.messageTs, job.id);
        if (ts && await deps.store.advanceFeedback(job.id, job.state, { state: "delivered", messageTs: ts })) result.delivered++;
        continue;
      }
      if (!await deps.store.advanceFeedback(job.id, "pending", { state: "sending" })) continue;
      try {
        const sent = await deps.slack.postMessage({ channel: job.link.channel, thread_ts: job.link.threadTs ?? job.link.messageTs,
          text: `Completed: <${job.link.issueUrl}|${job.link.issueKey}>.`, client_msg_id: job.id });
        await deps.store.advanceFeedback(job.id, "sending", { state: "delivered", ...(sent ? { messageTs: sent.ts } : {}) });
        result.delivered++;
      } catch (error) {
        await deps.store.advanceFeedback(job.id, "sending", { state: error instanceof SlackDeliveryError ? "pending" : "uncertain" });
      }
    } catch { result.withheld++; }
  }
  return result;
}

export async function handleMaintenance(deps: Deps, request: SlackRequest): Promise<SlackResponse> {
  const expected = deps.workerToken;
  const token = request.headers.authorization?.replace(/^Bearer /, "");
  if (!expected || expected.length < 32 || !token || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return { status: 401 };
  if (request.method !== "POST") return { status: 405 };
  let body: any;
  try { body = JSON.parse(request.rawBody || "{}"); } catch { return { status: 400 }; }
  if (request.path.endsWith("/feedback")) {
    if (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 50)) return { status: 400 };
    return { status: 200, body: await runCompletionFeedback(deps, body.limit ?? 25) };
  }
  if (request.path.endsWith("/recovery")) {
    if (typeof body.operationId !== "string" || typeof body.issueKey !== "string" || typeof body.actorSlackId !== "string") return { status: 400 };
    return { status: 200, body: { reconciled: await reconcileOperation(deps, body.operationId, body.issueKey, body.actorSlackId) } };
  }
  return { status: 404 };
}
