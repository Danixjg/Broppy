import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Deps } from "./config.js";
import { handleSlack } from "./handler.js";
import { MemoryTaskStore } from "./store.js";
import { verifySignature } from "./slack.js";

const SECRET = "shh";
const NOW = new Date("2026-10-05T10:22:30Z");

function setup() {
  const calls = { ephemeral: [] as any[], messages: [] as any[], responses: [] as any[], created: [] as any[], comments: [] as any[], asks: [] as any[] };
  const deferred: Promise<unknown>[] = [];
  const deps: Deps = {
    signingSecret: SECRET,
    slack: {
      postEphemeral: async a => { calls.ephemeral.push(a); },
      postMessage: async a => { calls.messages.push(a); },
      respond: async (_url, body) => { calls.responses.push(body); },
      history: async () => undefined,
      userEmail: async id => id === "UNOBODY" ? undefined : `${id.slice(1).toLowerCase()}@x.test`
    },
    jira: {
      createIssue: async input => { calls.created.push(input); return { key: `DB-${15 + calls.created.length}`, url: `https://x.atlassian.net/browse/DB-${15 + calls.created.length}` }; },
      addComment: async (key, text) => { calls.comments.push({ key, text }); }
    },
    broppy: { ask: async (user, q) => { calls.asks.push({ user, q }); return { text: "Wave three starts after DB-15 is resolved.", citations: [{ title: "Migration plan", url: "https://b/p" }] }; } },
    store: new MemoryTaskStore(),
    people: [{ slackId: "UMAYA", name: "Maya", jiraAccountId: "acc-maya" }, { slackId: "UDAVID", name: "David" }],
    channelProjects: { CDB: "DB" }, defaultProject: "OPS", threshold: 0.6, webUrl: "https://broppy.test",
    defer: work => { deferred.push(work); }, now: () => NOW
  };
  return { deps, calls, deferred };
}

function signed(body: string, path: string, secret = SECRET) {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { method: "POST", path, rawBody: body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } };
}

const message = (text: string, ts = "1791195720.000100", extra = {}) => JSON.stringify({
  type: "event_callback", event: { type: "message", user: "UMAYA", channel: "CDB", ts, text, ...extra }
});
const AGREED = "Agreed: Maya raises the replica storage quota before the final wave. Due Fri 16 Oct.";

async function suggestion(ctx: ReturnType<typeof setup>, text = AGREED, ts?: string) {
  await handleSlack(ctx.deps, signed(message(text, ts), "/slack/events"));
  return ctx.calls.ephemeral.at(-1);
}
const buttonValue = (eph: any, action: string) => eph.blocks[1].elements.find((e: any) => e.action_id === action).value;
const click = (ctx: ReturnType<typeof setup>, value: string, user: string, action = "track_task") => handleSlack(ctx.deps, signed(
  new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", user: { id: user }, response_url: "https://hooks.slack.com/x", actions: [{ action_id: action, value }] }) }).toString(),
  "/slack/interactions"));

describe("signatures", () => {
  it("rejects bad, stale and missing signatures", async () => {
    const { deps } = setup();
    expect((await handleSlack(deps, { ...signed("{}", "/slack/events", "wrong") })).status).toBe(401);
    expect((await handleSlack(deps, { method: "POST", path: "/slack/events", rawBody: "{}", headers: {} })).status).toBe(401);
    expect(verifySignature(SECRET, "{}", "1", "v0=00", NOW.getTime())).toBe(false);
  });
  it("answers Slack's URL verification", async () => {
    const { deps } = setup();
    const r = await handleSlack(deps, signed(JSON.stringify({ type: "url_verification", challenge: "abc" }), "/slack/events"));
    expect(r.body).toEqual({ challenge: "abc" });
  });
});

describe("task suggestion", () => {
  it("shows the suggestion only to the person receiving the task", async () => {
    const ctx = setup();
    const eph = await suggestion(ctx);
    expect(eph.user).toBe("UMAYA");
    expect(eph.blocks[0].text.text).toContain("Raise replica storage quota");
    expect(eph.blocks[0].text.text).toContain("due Fri 16 Oct");
    expect(eph.blocks[0].text.text).toContain("Jira project DB");
    expect(eph.blocks[1].elements.map((e: any) => e.text.text)).toEqual(["Track in Jira", "Open in Broppy ↗", "Not a task"]);
    expect(ctx.calls.messages).toHaveLength(0);
  });
  it("stays quiet for ordinary messages, bots and retried events", async () => {
    const ctx = setup();
    await handleSlack(ctx.deps, signed(message("Blocker raised: the backfill job keeps timing out."), "/slack/events"));
    await handleSlack(ctx.deps, signed(message(AGREED, "1.1", { bot_id: "B1" }), "/slack/events"));
    expect(ctx.calls.ephemeral).toHaveLength(0);
    await handleSlack(ctx.deps, signed(message(AGREED), "/slack/events"));
    await handleSlack(ctx.deps, signed(message(AGREED), "/slack/events"));
    expect(ctx.calls.ephemeral).toHaveLength(1);
  });
});

describe("Track in Jira", () => {
  it("rejects anyone but the assignee", async () => {
    const ctx = setup();
    const value = buttonValue(await suggestion(ctx), "track_task");
    await click(ctx, value, "UDAVID");
    expect(ctx.calls.created).toHaveLength(0);
    expect(ctx.calls.responses.at(-1).text).toContain("Only <@UMAYA>");
    await click(ctx, value, "UDAVID", "dismiss_task");
    expect(ctx.calls.responses.at(-1).delete_original).toBeUndefined();
  });
  it("creates the issue and replies in the thread when the assignee confirms", async () => {
    const ctx = setup();
    await click(ctx, buttonValue(await suggestion(ctx), "track_task"), "UMAYA");
    expect(ctx.calls.created[0]).toMatchObject({ project: "DB", summary: "Raise replica storage quota", assigneeAccountId: "acc-maya", dueDate: "2026-10-16" });
    expect(ctx.calls.messages[0].thread_ts).toBe("1791195720.000100");
    expect(ctx.calls.messages[0].text).toContain("Tracked as <https://x.atlassian.net/browse/DB-16|DB-16>");
  });
  it("ignores a second click on the same suggestion", async () => {
    const ctx = setup();
    const value = buttonValue(await suggestion(ctx), "track_task");
    await click(ctx, value, "UMAYA");
    await click(ctx, value, "UMAYA");
    expect(ctx.calls.created).toHaveLength(1);
  });
  it("comments on the existing ticket when the task repeats", async () => {
    const ctx = setup();
    await click(ctx, buttonValue(await suggestion(ctx), "track_task"), "UMAYA");
    const again = await suggestion(ctx, "Agreed: Maya will raise the replica storage quota again by Fri 16 Oct.", "1791199999.000200");
    await click(ctx, buttonValue(again, "track_task"), "UMAYA");
    expect(ctx.calls.created).toHaveLength(1);
    expect(ctx.calls.comments[0].key).toBe("DB-16");
    expect(ctx.calls.messages.at(-1).text).toContain("Added to");
    expect((ctx.deps.store as MemoryTaskStore).links[0].mentionCount).toBe(2);
  });
  it("lets a failed attempt be retried", async () => {
    const ctx = setup();
    const create = ctx.deps.jira.createIssue;
    ctx.deps.jira.createIssue = async () => { throw new Error("jira down"); };
    const value = buttonValue(await suggestion(ctx), "track_task");
    await click(ctx, value, "UMAYA");
    ctx.deps.jira.createIssue = create;
    await click(ctx, value, "UMAYA");
    expect(ctx.calls.created).toHaveLength(1);
  });
  it("removes the suggestion on Not a task", async () => {
    const ctx = setup();
    await click(ctx, buttonValue(await suggestion(ctx), "dismiss_task"), "UMAYA", "dismiss_task");
    expect(ctx.calls.responses.at(-1)).toEqual({ delete_original: true });
    expect(ctx.calls.created).toHaveLength(0);
  });
});

describe("asking Broppy", () => {
  const command = (ctx: ReturnType<typeof setup>, user: string, text: string) => handleSlack(ctx.deps, signed(
    new URLSearchParams({ command: "/broppy", text, user_id: user, response_url: "https://hooks.slack.com/c" }).toString(), "/slack/commands"));

  it("acknowledges at once and answers privately with sources, for the asker's own Slack ID", async () => {
    const ctx = setup();
    const r = await command(ctx, "UMAYA", "what's blocking wave three?");
    expect((r.body as any).response_type).toBe("ephemeral");
    await Promise.all(ctx.deferred);
    expect(ctx.calls.asks).toEqual([{ user: "maya@x.test", q: "what's blocking wave three?" }]);
    const reply = ctx.calls.responses.at(-1);
    expect(reply.response_type).toBe("ephemeral");
    expect(JSON.stringify(reply.blocks)).toContain("Migration plan");
  });
  it("won't answer for someone not linked to Broppy", async () => {
    const ctx = setup();
    await command(ctx, "UNOBODY", "anything");
    await Promise.all(ctx.deferred);
    expect(ctx.calls.responses.at(-1).text).toContain("isn't linked");
  });
  it("handles the Ask Broppy message shortcut", async () => {
    const ctx = setup();
    await handleSlack(ctx.deps, signed(new URLSearchParams({ payload: JSON.stringify({
      type: "message_action", callback_id: "ask_broppy", user: { id: "UDAVID" }, response_url: "https://hooks.slack.com/m", message: { text: "Is DB-15 resolved?" }
    }) }).toString(), "/slack/interactions"));
    await Promise.all(ctx.deferred);
    expect(ctx.calls.asks).toEqual([{ user: "david@x.test", q: "Is DB-15 resolved?" }]);
  });
});
