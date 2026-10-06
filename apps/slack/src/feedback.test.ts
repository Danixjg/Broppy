import { describe, expect, it } from "vitest";
import { NotLinkedError } from "./broppy.js";
import { runCompletionFeedback } from "./feedback.js";
import { handleSlack } from "./handler.js";
import { SlackDeliveryError } from "./slack.js";
import { buttonValue, click, setup, suggestion } from "./test-fixtures.js";

async function tracked() {
  const ctx = setup(); await click(ctx, buttonValue(await suggestion(ctx))); ctx.calls.messages.length = 0;
  let category: "new" | "indeterminate" | "done" = "new"; let version = 1;
  ctx.deps.broppy.issueAccess = async (_email, key) => ({ key, url: `https://x.atlassian.net/browse/${key}`, statusCategory: category, providerVersion: String(version) });
  return { ...ctx, done: () => { category = "done"; version++; }, reopen: () => { category = "new"; version++; } };
}

describe("bounded completion feedback", () => {
  it("posts one approved completion statement in the original thread after a terminal transition", async () => {
    const ctx = await tracked(); await runCompletionFeedback(ctx.deps); expect(ctx.calls.messages).toHaveLength(0);
    ctx.done(); await runCompletionFeedback(ctx.deps); await runCompletionFeedback(ctx.deps);
    expect(ctx.calls.messages).toHaveLength(1); expect(ctx.calls.messages[0]).toMatchObject({ channel: "CDB", thread_ts: "1791195720.000100", text: "Completed: <https://x.atlassian.net/browse/DB-77|DB-77>." });
    expect(ctx.calls.messages[0].client_msg_id).toMatch(/^[a-f0-9-]{36}$/); expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.comments).toHaveLength(0);
    ctx.reopen(); await runCompletionFeedback(ctx.deps); ctx.done(); await runCompletionFeedback(ctx.deps); expect(ctx.calls.messages).toHaveLength(1);
  });
  it("initializes a done baseline without inventing a transition", async () => {
    const ctx = await tracked(); ctx.done(); await runCompletionFeedback(ctx.deps); expect(ctx.calls.messages).toHaveLength(0);
  });
  it("delivers once to each independently reviewed source thread sharing a reserved issue", async () => {
    const ctx = setup(); await click(ctx, buttonValue(await suggestion(ctx)));
    const second = await suggestion(ctx, undefined, "1791195999.1");
    await click(ctx, buttonValue(second, "link_task"), "UMAYA", "link_task");
    ctx.calls.messages.length = 0; await runCompletionFeedback(ctx.deps);
    ctx.deps.broppy.issueAccess = async (_email, key) => ({ key, url: `https://x.atlassian.net/browse/${key}`, statusCategory: "done", providerVersion: "2" });
    await runCompletionFeedback(ctx.deps); await runCompletionFeedback(ctx.deps);
    expect(ctx.calls.messages).toHaveLength(2); expect(ctx.calls.messages.map(m => m.thread_ts).sort()).toEqual(["1791195720.000100", "1791195999.1"]);
    expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.comments).toHaveLength(0);
  });
  it("serializes concurrent delivery of duplicate terminal observations", async () => {
    const ctx = await tracked(); await runCompletionFeedback(ctx.deps); ctx.done();
    await Promise.all([runCompletionFeedback(ctx.deps), runCompletionFeedback(ctx.deps)]); expect(ctx.calls.messages).toHaveLength(1);
  });
  it("retries a confirmed Slack rejection without a Jira write", async () => {
    const ctx = await tracked(); await runCompletionFeedback(ctx.deps); ctx.done();
    const post = ctx.deps.slack.postMessage; let fail = true;
    ctx.deps.slack.postMessage = async a => { if (fail) { fail = false; throw new SlackDeliveryError("ratelimited"); } return post(a); };
    await runCompletionFeedback(ctx.deps); expect(ctx.calls.messages).toHaveLength(0);
    await runCompletionFeedback({ ...ctx.deps }); expect(ctx.calls.messages).toHaveLength(1); expect(ctx.calls.created).toHaveLength(1);
  });
  it("reconciles uncertain delivery without a blind repost", async () => {
    const ctx = await tracked(); await runCompletionFeedback(ctx.deps); ctx.done(); let posts = 0;
    ctx.deps.slack.postMessage = async () => { posts++; throw new Error("timeout after accept"); };
    await runCompletionFeedback(ctx.deps); await runCompletionFeedback(ctx.deps); expect(posts).toBe(1);
    ctx.deps.slack.findMessage = async () => "posted-ts"; await runCompletionFeedback(ctx.deps);
    expect(posts).toBe(1); expect(await ctx.deps.store.pendingFeedback()).toHaveLength(0);
  });
  it.each(["policy", "membership", "active actor", "missing email", "site"])("withholds feedback when %s is not approved", async reason => {
    const ctx = await tracked(); await runCompletionFeedback(ctx.deps); ctx.done();
    if (reason === "policy") ctx.deps.completionPolicies = [];
    if (reason === "membership") ctx.deps.slack.members = async () => ["UMAYA", "UDAVID"];
    if (reason === "active actor") { ctx.deps.completionPolicies![0].allowedSlackIds.push("UDAVID"); ctx.deps.slack.members = async () => ["UMAYA", "UDAVID"]; const access = ctx.deps.broppy.issueAccess; ctx.deps.broppy.issueAccess = async (email, key) => { if (email === "david@x.test") throw new NotLinkedError(); return access(email, key); }; }
    if (reason === "missing email") { ctx.deps.completionPolicies![0].allowedSlackIds.push("UNOBODY"); ctx.deps.slack.members = async () => ["UMAYA", "UNOBODY"]; }
    if (reason === "site") ctx.deps.jiraBaseUrl = "https://foreign.atlassian.net";
    await runCompletionFeedback(ctx.deps); expect(ctx.calls.messages).toHaveLength(0); expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.comments).toHaveLength(0);
  });
  it("excludes this app's bot from recipients, and rechecks recipients before a pending retry", async () => {
    const ctx = await tracked(); ctx.deps.slack.botUserId = async () => "UAPP"; ctx.deps.slack.members = async () => ["UMAYA", "UAPP"];
    await runCompletionFeedback(ctx.deps); ctx.done(); const policies = ctx.deps.completionPolicies; ctx.deps.completionPolicies = [];
    await runCompletionFeedback(ctx.deps); expect(ctx.calls.messages).toHaveLength(0);
    ctx.deps.completionPolicies = policies; await runCompletionFeedback(ctx.deps); expect(ctx.calls.messages).toHaveLength(1);
  });
  it("requires a worker secret and a bounded batch for its executable HTTP hook", async () => {
    const ctx = await tracked();
    const request = { method: "POST", path: "/slack/feedback", headers: {}, rawBody: "{}" };
    expect((await handleSlack(ctx.deps, request)).status).toBe(401);
    const authenticated = { ...request, headers: { authorization: `Bearer ${ctx.deps.workerToken}` } };
    expect((await handleSlack(ctx.deps, { ...authenticated, rawBody: '{"limit":1000}' })).status).toBe(400);
    expect((await handleSlack(ctx.deps, authenticated)).body).toMatchObject({ observed: 1, delivered: 0 });
  });
});
