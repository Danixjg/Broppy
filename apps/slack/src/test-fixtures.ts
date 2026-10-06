import { createHmac } from "node:crypto";
import type { Deps } from "./config.js";
import { handleSlack } from "./handler.js";
import { MemoryTaskStore } from "./store.js";

export const SECRET = "shh";
export const NOW = new Date("2026-10-05T10:22:30Z");
export const AGREED = "Agreed: Maya raises the replica storage quota before the final wave. Due Fri 16 Oct.";
export function setup() {
  const calls = { ephemeral: [] as any[], messages: [] as any[], responses: [] as any[], legacy: [] as any[], created: [] as any[], comments: [] as any[], asks: [] as any[], views: [] as any[], reads: [] as any[] };
  const deferred: Promise<unknown>[] = [];
  const deps: Deps = { signingSecret: SECRET,
    slack: { postEphemeral: async a => { calls.ephemeral.push(a); }, postMessage: async a => { calls.messages.push(a); return { ts: `${calls.messages.length}.0` }; },
      respond: async (_url, body) => { calls.responses.push(body); }, history: async () => undefined,
      userEmail: async id => id === "UNOBODY" ? undefined : `${id.slice(1).toLowerCase()}@x.test`,
      permalink: async (channel, ts) => `https://x.slack.com/archives/${channel}/p${ts.replace('.', '')}`,
      openView: async (_trigger, view) => { calls.views.push(view); }, members: async () => ["UMAYA"], findMessage: async () => undefined },
    jira: { createIssue: async input => { calls.legacy.push(input); return { key: "DB-999", url: "https://x.atlassian.net/browse/DB-999" }; }, addComment: async () => { calls.comments.push("shared"); } },
    broppy: { actor: async () => ({ active: true }), issueAccess: async (email, key) => { calls.reads.push({ email, key }); return { key, url: `https://x.atlassian.net/browse/${key}`, statusCategory: "new", providerVersion: "1" }; },
      createIssue: async (email, issue) => { calls.created.push({ email, issue }); return { key: `DB-${76 + calls.created.length}`, url: `https://x.atlassian.net/browse/DB-${76 + calls.created.length}` }; },
      comment: async () => { calls.comments.push("personal"); return true; },
      ask: async (user, q) => { calls.asks.push({ user, q }); return { text: "Wave three starts after DB-15 is resolved.", citations: [{ title: "Migration plan", url: "https://b/p" }] }; } },
    store: new MemoryTaskStore(), people: [{ slackId: "UMAYA", name: "Maya", jiraAccountId: "acc-maya" }, { slackId: "UDAVID", name: "David" }],
    channelProjects: { CDB: "DB" }, defaultProject: "OPS", threshold: 0.6, webUrl: "https://broppy.test", jiraBaseUrl: "https://x.atlassian.net",
    destinations: [{ channel: "CDB", project: "DB", allowedSlackIds: ["UMAYA"], disclosureFields: ["summary", "permalink"] }], completionPolicies: [{ channel: "CDB", project: "DB", allowedSlackIds: ["UMAYA"] }], workerToken: "w".repeat(32),
    defer: work => { deferred.push(work); }, now: () => NOW };
  return { deps, calls, deferred };
}
export function signed(body: string, path: string, secret = SECRET) {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { method: "POST", path, rawBody: body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } };
}
export const message = (text: string, ts = "1791195720.000100", extra = {}) => JSON.stringify({ type: "event_callback", team_id: "TONE", event: { type: "message", user: "UMAYA", channel: "CDB", ts, text, ...extra } });
export const interaction = (payload: unknown) => signed(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), "/slack/interactions");
export async function suggestion(ctx: ReturnType<typeof setup>, text = AGREED, ts?: string) { await handleSlack(ctx.deps, signed(message(text, ts), "/slack/events")); return ctx.calls.ephemeral.at(-1); }
export const buttonValue = (eph: any, action = "track_task") => eph.blocks.flatMap((b: any) => b.elements ?? []).find((e: any) => e.action_id === action).value;
export const click = (ctx: ReturnType<typeof setup>, value: string, user = "UMAYA", action = "track_task") => handleSlack(ctx.deps, interaction({ type: "block_actions", user: { id: user }, trigger_id: "trigger", response_url: "https://hooks.slack.com/x", actions: [{ action_id: action, value }] }));
