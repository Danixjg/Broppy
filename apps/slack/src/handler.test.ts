import { describe, expect, it } from "vitest";
import { reconcileOperation } from "./actions.js";
import { NotLinkedError } from "./broppy.js";
import { handleSlack } from "./handler.js";
import { SlackDeliveryError, verifySignature } from "./slack.js";
import { MemoryTaskStore } from "./store.js";
import { AGREED, NOW, SECRET, buttonValue, click, interaction, message, setup, signed, suggestion } from "./test-fixtures.js";

describe("signed Slack intake", () => {
  it("rejects bad, stale, and missing signatures", async () => {
    const { deps } = setup();
    expect((await handleSlack(deps, signed("{}", "/slack/events", "wrong"))).status).toBe(401);
    expect((await handleSlack(deps, { method: "POST", path: "/slack/events", rawBody: "{}", headers: {} })).status).toBe(401);
    expect(verifySignature(SECRET, "{}", "1", "v0=00", NOW.getTime())).toBe(false);
  });
  it("answers URL verification", async () => {
    const { deps } = setup();
    expect((await handleSlack(deps, signed(JSON.stringify({ type: "url_verification", challenge: "abc" }), "/slack/events"))).body).toEqual({ challenge: "abc" });
  });
  it("registers a stable proposal and posts privately to its owner", async () => {
    const ctx = setup(); const eph = await suggestion(ctx);
    expect(eph.user).toBe("UMAYA"); expect(eph.blocks[0].text.text).toContain("Jira project DB");
    const ref = JSON.parse(buttonValue(eph)); expect(Object.keys(ref).sort()).toEqual(["id", "revision"]);
    const stored = await ctx.deps.store.getProposal(ref.id);
    expect(stored).toMatchObject({ revision: 1, status: "pending", authorSlackId: "UMAYA", teamId: "TONE", suggestion: { t: "Raise replica storage quota", d: "2026-10-16" } });
    expect(stored?.permalink).toContain("/archives/CDB/p1791195720000100");
  });
  it("ignores ordinary messages, bot notices, and repeated events", async () => {
    const ctx = setup();
    await handleSlack(ctx.deps, signed(message("The backfill job times out."), "/slack/events"));
    await handleSlack(ctx.deps, signed(message(AGREED, "1.1", { bot_id: "B1" }), "/slack/events"));
    expect(ctx.calls.ephemeral).toHaveLength(0);
    await suggestion(ctx); await suggestion(ctx); expect(ctx.calls.ephemeral).toHaveLength(1);
  });
  it("preserves first-person authorship for explicit tracking intake", async () => {
    const ctx = setup();
    await handleSlack(ctx.deps, interaction({ type: "message_action", callback_id: "track_broppy", user: { id: "UDAVID" }, team: { id: "TONE" }, channel: { id: "CDB" },
      message: { text: "I will increase replicas by Friday", ts: "1791195720.001", user: "UMAYA" } }));
    await Promise.all(ctx.deferred.splice(0)); // the card is sent after Slack's three-second reply
    const ref = JSON.parse(buttonValue(ctx.calls.ephemeral.at(-1))); const p = await ctx.deps.store.getProposal(ref.id);
    expect(p).toMatchObject({ authorSlackId: "UMAYA", suggestion: { a: "UMAYA", t: "Increase replicas", d: "2026-10-09" } });
    expect(ctx.calls.ephemeral.at(-1).user).toBe("UMAYA");
  });
  it("persists dismissal across handler restarts and repeat intake", async () => {
    const ctx = setup(); const value = buttonValue(await suggestion(ctx));
    await click(ctx, value, "UMAYA", "dismiss_task");
    const p = await ctx.deps.store.getProposal(JSON.parse(value).id); expect(p?.status).toBe("dismissed");
    ctx.calls.ephemeral.length = 0;
    await handleSlack({ ...ctx.deps }, signed(message(AGREED), "/slack/events"));
    await click(ctx, value); expect(ctx.calls.created).toHaveLength(0); expect(ctx.calls.ephemeral).toHaveLength(0);
  });
  it("edits the stored draft and rejects stale approval revisions", async () => {
    const ctx = setup(); const value = buttonValue(await suggestion(ctx));
    await click(ctx, value, "UMAYA", "edit_task"); const view = ctx.calls.views[0];
    await handleSlack(ctx.deps, interaction({ type: "view_submission", user: { id: "UMAYA" }, view: { callback_id: "edit_commitment", private_metadata: view.private_metadata,
      state: { values: { summary: { value: { value: "Rotate staging keys" } }, owner: { value: { value: "UDAVID" } }, due: { value: { value: "2026-10-20" } }, project: { value: { value: "DB" } } } } } }));
    const p = await ctx.deps.store.getProposal(JSON.parse(value).id); expect(p).toMatchObject({ revision: 2, reviewerSlackId: "UMAYA", suggestion: { t: "Rotate staging keys", a: "UDAVID", d: "2026-10-20", c: "CDB" } });
    await click(ctx, value); expect(ctx.calls.created).toHaveLength(0);
    await click(ctx, buttonValue(ctx.calls.ephemeral.at(-1))); expect(ctx.calls.created[0].issue.summary).toBe("Rotate staging keys");
  });
});

describe("durable Jira actions", () => {
  it("refuses another reviewer and arbitrary signed issue fields", async () => {
    const ctx = setup(); const value = buttonValue(await suggestion(ctx));
    await click(ctx, value, "UDAVID"); expect(ctx.calls.created).toHaveLength(0); expect(ctx.calls.responses.at(-1).text).toContain("Only <@UMAYA>");
    await click(ctx, JSON.stringify({ ...JSON.parse(value), t: "Injected private data", p: "SECRET", a: "UDAVID" }));
    expect(ctx.calls.created[0].issue).toMatchObject({ summary: "Raise replica storage quota", project: "DB", assigneeAccountId: "acc-maya" });
  });
  it("writes only the reviewed draft and source pointer, and uses exact deep links", async () => {
    const ctx = setup(); await click(ctx, buttonValue(await suggestion(ctx)));
    expect(ctx.calls.created[0]).toMatchObject({ email: "maya@x.test", issue: { project: "DB", summary: "Raise replica storage quota", dueDate: "2026-10-16" } });
    expect(ctx.calls.created[0].issue.description).toContain("https://x.slack.com/archives/CDB/p1791195720000100");
    expect(ctx.calls.created[0].issue.description).not.toContain(AGREED); expect(ctx.calls.legacy).toHaveLength(0);
    expect(ctx.calls.messages[0]).toMatchObject({ channel: "CDB", thread_ts: "1791195720.000100" });
    expect(ctx.calls.messages[0].text).toContain("/workspace/index.html?task=jira%3ADB-77");
  });
  it.each(["missing audience", "broad audience", "unapproved summary"])("refuses Jira disclosure with %s before any remote effect", async reason => {
    const ctx = setup();
    if (reason === "missing audience") ctx.deps.destinations![0].allowedSlackIds = [];
    if (reason === "broad audience") ctx.deps.destinations![0].allowedSlackIds.push("UDAVID");
    if (reason === "unapproved summary") ctx.deps.destinations![0].disclosureFields = ["permalink"];
    // The card offers no "Track in Jira" without an approved audience; a click sent anyway is still refused.
    const value = buttonValue(await suggestion(ctx), "edit_task"); await click(ctx, value);
    expect(ctx.calls.created).toHaveLength(0); expect(ctx.calls.messages).toHaveLength(0); expect(ctx.calls.legacy).toHaveLength(0);
  });
  it("sends the owner's email when no Jira account is configured, and tells the approver what Jira left out", async () => {
    const ctx = setup(); ctx.deps.people = ctx.deps.people.map(person => ({ slackId: person.slackId, name: person.name }));
    const create = ctx.deps.broppy.createIssue;
    ctx.deps.broppy.createIssue = async (email, input) => ({ ...(await create(email, input))!, omitted: ["due date"] });
    await click(ctx, buttonValue(await suggestion(ctx)));
    expect(ctx.calls.created[0].issue).toMatchObject({ assigneeEmail: "maya@x.test" });
    expect(JSON.stringify(ctx.calls.responses)).toContain("No due date was set");
  });
  it("omits the source pointer unless the destination policy approves that field", async () => {
    const ctx = setup(); ctx.deps.destinations![0].disclosureFields = ["summary"];
    const eph = await suggestion(ctx); expect(eph.blocks[0].text.text).toContain("Jira task visible to: <@UMAYA>");
    expect(eph.blocks[0].text.text).not.toContain("From: "); await click(ctx, buttonValue(eph));
    expect(ctx.calls.created[0].issue.description).not.toContain("Source:"); expect(ctx.calls.created[0].issue.description).toContain("Approved summary: Raise replica storage quota");
  });
  it("serializes simultaneous approvals of the same fingerprint at distinct source timestamps", async () => {
    const ctx = setup(); const one = buttonValue(await suggestion(ctx)); const two = buttonValue(await suggestion(ctx, AGREED, "1791195999.1"));
    await Promise.all([click(ctx, one), click(ctx, two)]); expect(ctx.calls.created).toHaveLength(1);
    await click(ctx, two); expect((await ctx.deps.store.getProposal(JSON.parse(two).id))?.status).toBe("pending");
    await click(ctx, buttonValue(ctx.calls.ephemeral.at(-1), "link_task"), "UMAYA", "link_task"); const links = (ctx.deps.store as MemoryTaskStore).links;
    expect(links).toHaveLength(2); expect(links[0].mentionCount).toBe(2); expect(links[0].messageTs).toBe("1791195720.000100");
  });
  it("resumes task recording after saveTask fails following Jira success", async () => {
    const ctx = setup(); const store = ctx.deps.store; const save = store.saveTask.bind(store); let fail = true;
    store.saveTask = async link => { if (fail) { fail = false; throw new Error("storage unavailable"); } await save(link); };
    const value = buttonValue(await suggestion(ctx)); await click(ctx, value); expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.messages).toHaveLength(0);
    await click(ctx, value); expect(ctx.calls.created).toHaveLength(1); expect((store as MemoryTaskStore).links[0].issueKey).toBe("DB-77"); expect(ctx.calls.messages).toHaveLength(1);
  });
  it("retries confirmed failed notification without another Jira write", async () => {
    const ctx = setup(); const post = ctx.deps.slack.postMessage; let fail = true;
    ctx.deps.slack.postMessage = async args => { if (fail) { fail = false; throw new SlackDeliveryError("ratelimited"); } return post(args); };
    const value = buttonValue(await suggestion(ctx)); await click(ctx, value); await click(ctx, value); await click(ctx, value);
    expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.messages).toHaveLength(1); expect(ctx.calls.messages[0].client_msg_id).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("withholds a channel announcement for a denied recipient and later retries only notification", async () => {
    const ctx = setup(); ctx.deps.destinations![0].allowedSlackIds.push("UDAVID"); ctx.deps.slack.members = async () => ["UMAYA", "UDAVID"];
    const access = ctx.deps.broppy.issueAccess; let refused = true;
    ctx.deps.broppy.issueAccess = async (email, key) => { if (refused && email === "david@x.test") throw new NotLinkedError(); return access(email, key); };
    const value = buttonValue(await suggestion(ctx)); await click(ctx, value); expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.messages).toHaveLength(0);
    const p = await ctx.deps.store.getProposal(JSON.parse(value).id); expect(p?.status).toBe("created"); expect((await ctx.deps.store.getOperation(p!.operationId!))?.state).toBe("linked");
    refused = false; await click(ctx, value); expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.messages).toHaveLength(1);
  });
  it("does not recreate after a timeout with an unknown Jira result", async () => {
    const ctx = setup(); let attempts = 0; ctx.deps.broppy.createIssue = async () => { attempts++; throw new Error("timeout"); };
    const value = buttonValue(await suggestion(ctx)); await click(ctx, value); await click(ctx, value);
    expect(attempts).toBe(1); expect(ctx.calls.messages).toHaveLength(0); expect(ctx.calls.responses.at(-1).text).toContain("reconciliation");
  });
  it("requires a read-verified operation marker after remote-result persistence fails", async () => {
    const ctx = setup(); const store = ctx.deps.store; const advance = store.advanceOperation.bind(store); let failed = false;
    store.advanceOperation = async (id, state, patch) => { if (!failed && state === "creating" && patch.state === "remote_succeeded") { failed = true; throw new Error("write lost"); } return advance(id, state, patch); };
    const value = buttonValue(await suggestion(ctx)); await click(ctx, value); await click(ctx, value); expect(ctx.calls.created).toHaveLength(1);
    const opId = ctx.calls.created[0].issue.description.match(/Broppy operation: ([a-f0-9-]+)/)[1];
    expect(await reconcileOperation(ctx.deps, opId, "DB-77", "UMAYA")).toBe(false);
    ctx.deps.broppy.issueAccess = async (_email, key) => ({ key, url: `https://x.atlassian.net/browse/${key}`, statusCategory: "new", providerVersion: "1", operationMarker: opId });
    expect(await reconcileOperation(ctx.deps, opId, "DB-77", "UMAYA")).toBe(true);
    await click(ctx, value); expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.messages).toHaveLength(1);
  });
  it("reconciles ambiguous notification success without reposting", async () => {
    const ctx = setup(); let posts = 0; ctx.deps.slack.postMessage = async () => { posts++; throw new Error("timeout"); };
    const value = buttonValue(await suggestion(ctx)); await click(ctx, value); await click(ctx, value); expect(posts).toBe(1);
    ctx.deps.slack.findMessage = async () => "resolved-ts"; await click(ctx, value); expect(posts).toBe(1);
    const p = await ctx.deps.store.getProposal(JSON.parse(value).id); expect((await ctx.deps.store.getOperation(p!.operationId!))?.state).toBe("notified");
  });
  it.each(["email", "actor", "401", "missing Jira", "policy", "source membership"])("does not use a shared Jira account when blocked by %s", async reason => {
    const ctx = setup(); const value = buttonValue(await suggestion(ctx));
    if (reason === "email") ctx.deps.slack.userEmail = async () => undefined;
    if (reason === "actor") ctx.deps.broppy.actor = async () => { throw new NotLinkedError(); };
    if (reason === "401") ctx.deps.broppy.createIssue = async () => { throw new NotLinkedError(); };
    if (reason === "missing Jira") ctx.deps.broppy.createIssue = async () => undefined;
    if (reason === "policy") ctx.deps.destinations = [];
    if (reason === "source membership") ctx.deps.slack.members = async () => [];
    await click(ctx, value); expect(ctx.calls.legacy).toHaveLength(0); expect(ctx.calls.messages).toHaveLength(0); expect((ctx.deps.store as MemoryTaskStore).links).toHaveLength(0);
  });
  it("links exact repeats and keeps each sighting without copying or commenting", async () => {
    const ctx = setup(); await click(ctx, buttonValue(await suggestion(ctx)));
    const again = buttonValue(await suggestion(ctx, AGREED, "1791195999.1"), "link_task"); await click(ctx, again, "UMAYA", "link_task"); await click(ctx, again, "UMAYA", "link_task");
    expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.comments).toHaveLength(0);
    const store = ctx.deps.store as MemoryTaskStore; expect(store.links[0]).toMatchObject({ mentionCount: 2, channel: "CDB", messageTs: "1791195720.000100" });
    expect([...store.sightings.values()][0]).toEqual([{ channel: "CDB", messageTs: "1791195999.1" }]);
  });
  it("retries a definite refusal after Jira is connected without locking the reservation forever", async () => {
    const ctx = setup(); const create = ctx.deps.broppy.createIssue; let refused = true;
    ctx.deps.broppy.createIssue = async (email, input) => refused ? undefined : create(email, input);
    const value = buttonValue(await suggestion(ctx)); await click(ctx, value); expect(ctx.calls.created).toHaveLength(0);
    refused = false; await click(ctx, value); expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.messages).toHaveLength(1);
  });
  it("keeps distinct reviewed source records pointing to the same reserved issue", async () => {
    const ctx = setup(); const one = buttonValue(await suggestion(ctx)); const two = buttonValue(await suggestion(ctx, AGREED, "1791195999.1"));
    await click(ctx, one); await click(ctx, two);
    expect((await ctx.deps.store.getProposal(JSON.parse(two).id))?.status).toBe("pending");
    await click(ctx, buttonValue(ctx.calls.ephemeral.at(-1), "link_task"), "UMAYA", "link_task");
    const first = await ctx.deps.store.getProposal(JSON.parse(one).id); const second = await ctx.deps.store.getProposal(JSON.parse(two).id);
    expect(first?.status).toBe("created"); expect(second?.status).toBe("linked"); expect(second?.issueKey).toBe(first?.issueKey);
    const links = await ctx.deps.store.listTasks(); expect(links.map(l => l.threadTs).sort()).toEqual(["1791195720.000100", "1791195999.1"]);
    expect(links[0].fingerprint).not.toBe(links[1].fingerprint); expect(ctx.calls.created).toHaveLength(1);
  });
  it("presents similar titles as reviewed candidates and creates when the reviewer chooses creation", async () => {
    const ctx = setup(); await click(ctx, buttonValue(await suggestion(ctx)));
    const eph = await suggestion(ctx, "Agreed: Maya will raise the replica storage quota urgently by Fri 16 Oct.", "1791195999.1");
    expect(JSON.stringify(eph.blocks)).toContain("Link DB-77"); await click(ctx, buttonValue(eph));
    expect(ctx.calls.created).toHaveLength(2); expect(ctx.calls.comments).toHaveLength(0);
  });
  it("links a reviewed visible candidate without a Jira mutation", async () => {
    const ctx = setup(); await click(ctx, buttonValue(await suggestion(ctx)));
    const eph = await suggestion(ctx, "Agreed: Maya will raise the replica storage quota urgently by Fri 16 Oct.", "1791195999.1");
    await click(ctx, buttonValue(eph, "link_task"), "UMAYA", "link_task"); expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.comments).toHaveLength(0);
  });
  it("links a different exact-title issue explicitly while preserving the shared create reservation", async () => {
    const ctx = setup(); const firstValue = buttonValue(await suggestion(ctx)); await click(ctx, firstValue);
    const first = (await ctx.deps.store.listTasks())[0];
    await ctx.deps.store.saveTask({ ...first, fingerprint: "second-visible-source", issueKey: "DB-88", issueUrl: "https://x.atlassian.net/browse/DB-88", messageTs: "1791195000.1" });
    const eph = await suggestion(ctx, AGREED, "1791195999.1");
    const choices = eph.blocks.flatMap((block: any) => block.elements ?? []).filter((element: any) => element.action_id === "link_task");
    expect(choices.map((choice: any) => JSON.parse(choice.value).issueKey).sort()).toEqual(["DB-77", "DB-88"]);
    const value = choices.find((choice: any) => JSON.parse(choice.value).issueKey === "DB-88").value;
    await click(ctx, value, "UMAYA", "link_task");
    expect((await ctx.deps.store.getProposal(JSON.parse(value).id))?.issueKey).toBe("DB-88");
    expect((await ctx.deps.store.getProposal(JSON.parse(firstValue).id))?.issueKey).toBe("DB-77");
    expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.comments).toHaveLength(0);
    expect(ctx.calls.messages.at(-1)).toMatchObject({ thread_ts: "1791195999.1", text: expect.stringContaining("DB-88") });
  });
  it("freezes a partial link-only result and retries its recording without another Jira write", async () => {
    const ctx = setup(); await click(ctx, buttonValue(await suggestion(ctx)));
    const eph = await suggestion(ctx, AGREED, "1791195999.1"); const value = buttonValue(eph, "link_task");
    const p = await ctx.deps.store.getProposal(JSON.parse(value).id); const save = ctx.deps.store.saveTask.bind(ctx.deps.store); let fail = true;
    ctx.deps.store.saveTask = async link => { if (fail && link.messageTs === "1791195999.1") { fail = false; throw new Error("link recording unavailable"); } return save(link); };
    await click(ctx, value, "UMAYA", "link_task");
    expect(await ctx.deps.store.saveProposal({ ...p!, revision: 2, status: "dismissed" }, 1)).toBe(false);
    await click(ctx, value, "UMAYA", "link_task");
    expect((await ctx.deps.store.getProposal(p!.id))?.status).toBe("linked"); expect(ctx.calls.created).toHaveLength(1);
    expect(ctx.calls.messages.map(message => message.thread_ts)).toEqual(["1791195720.000100", "1791195999.1"]);
  });
  it("acknowledges each explicitly linked source once and retries only its failed announcement", async () => {
    const ctx = setup(); await click(ctx, buttonValue(await suggestion(ctx)));
    const post = ctx.deps.slack.postMessage; let fail = true;
    ctx.deps.slack.postMessage = async args => { if (fail && args.thread_ts === "1791195999.1") { fail = false; throw new SlackDeliveryError("ratelimited"); } return post(args); };
    const value = buttonValue(await suggestion(ctx, AGREED, "1791195999.1"), "link_task");
    await click(ctx, value, "UMAYA", "link_task"); expect(ctx.calls.messages).toHaveLength(1);
    await click(ctx, value, "UMAYA", "link_task"); await click(ctx, value, "UMAYA", "link_task");
    expect(ctx.calls.messages.map(message => message.thread_ts)).toEqual(["1791195720.000100", "1791195999.1"]);
    expect(ctx.calls.messages[0].client_msg_id).not.toBe(ctx.calls.messages[1].client_msg_id); expect(ctx.calls.created).toHaveLength(1); expect(ctx.calls.comments).toHaveLength(0);
  });
});

describe("asking Broppy", () => {
  it("acknowledges and answers privately as the mapped user", async () => {
    const ctx = setup(); const r = await handleSlack(ctx.deps, signed(new URLSearchParams({ command: "/broppy", text: "What's blocking wave three?", user_id: "UMAYA", response_url: "https://hooks.slack.com/c" }).toString(), "/slack/commands"));
    expect((r.body as any).response_type).toBe("ephemeral"); await Promise.all(ctx.deferred);
    expect(ctx.calls.asks).toEqual([{ user: "maya@x.test", q: "What's blocking wave three?" }]); expect(JSON.stringify(ctx.calls.responses.at(-1).blocks)).toContain("Migration plan");
  });
  it("handles the Ask Broppy shortcut", async () => {
    const ctx = setup(); await handleSlack(ctx.deps, interaction({ type: "message_action", callback_id: "ask_broppy", user: { id: "UDAVID" }, response_url: "https://hooks.slack.com/m", message: { text: "Is DB-15 resolved?" } }));
    await Promise.all(ctx.deferred); expect(ctx.calls.asks).toEqual([{ user: "david@x.test", q: "Is DB-15 resolved?" }]);
  });
});

describe("a workspace with no people list in its settings", () => {
  it("recognises who is asked from the message itself, by their Slack name", async () => {
    const ctx = setup(); ctx.deps.people = [];
    ctx.deps.slack.userName = async id => ({ UMAYA: "Maya", UDAVID: "David" } as Record<string, string>)[id];
    const eph = await suggestion(ctx, "<@UDAVID> can you work on the video for publishing?");
    expect(eph).toMatchObject({ user: "UDAVID" });
    expect(eph.blocks[0].text.text).toContain("Work on the video for publishing");
    expect(eph.blocks[0].text.text).toContain("David");
  });
  it("introduces itself when it is added to a channel, and only then", async () => {
    const ctx = setup(); ctx.deps.slack.botUserId = async () => "UBOT";
    const joined = (user: string) => signed(JSON.stringify({ type: "event_callback", team_id: "TONE", event: { type: "member_joined_channel", user, channel: "CDB" } }), "/slack/events");
    await handleSlack(ctx.deps, joined("UDAVID")); await Promise.all(ctx.deferred.splice(0));
    expect(ctx.calls.messages).toHaveLength(0);
    await handleSlack(ctx.deps, joined("UBOT")); await Promise.all(ctx.deferred.splice(0));
    expect(ctx.calls.messages).toHaveLength(1);
    expect(ctx.calls.messages[0]).toMatchObject({ channel: "CDB" });
    expect(ctx.calls.messages[0].text).toContain("/broppy");
  });
});
