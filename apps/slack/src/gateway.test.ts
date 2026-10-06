import { describe, expect, it, vi } from "vitest";
import { SlackGateway, type GatewayConfig } from "./gateway.js";
import { installedDeps } from "./runtime.js";
import { runCompletionFeedback } from "./feedback.js";
import { confirmProposal } from "./actions.js";
import { TestInstallationRegistry } from "./installation-fixtures.js";
import { AGREED, buttonValue, interaction, message, NOW, SECRET, setup, signed, suggestion } from "./test-fixtures.js";

async function setupGateway() {
  const registry = new TestInstallationRegistry();
  await registry.seed("TONE", "org-a"); await registry.seed("TTWO", "org-b");
  const a = setup(); const b = setup();
  const runtime = vi.fn<NonNullable<GatewayConfig["runtime"]>>((installation, scope) => {
    const ctx = installation.orgId === "org-a" ? a : b;
    return { ...ctx.deps, workspace: scope };
  });
  const gateway = new SlackGateway({ appId: "AAPP", signingSecret: SECRET, registry, workerToken: "w".repeat(32), now: () => NOW, defer: () => {}, runtime });
  const event = (teamId: string) => signed(JSON.stringify({ type: "event_callback", api_app_id: "AAPP", team_id: teamId,
    event: { type: "message", user: "UMAYA", channel: "CDB", ts: "1791195720.000100", text: AGREED } }), "/slack/events");
  return { gateway, registry, a, b, runtime, event };
}
describe("shared installed-workspace gateway", () => {
  it("routes two workspaces to their own runtime and store with no first-workspace reuse", async () => {
    const ctx = await setupGateway();
    expect((await ctx.gateway.handle(ctx.event("TONE"))).status).toBe(200);
    expect((await ctx.gateway.handle(ctx.event("TTWO"))).status).toBe(200);
    expect(ctx.a.calls.ephemeral).toHaveLength(1); expect(ctx.b.calls.ephemeral).toHaveLength(1);
    const aRef = JSON.parse(buttonValue(ctx.a.calls.ephemeral[0]));
    const bRef = JSON.parse(buttonValue(ctx.b.calls.ephemeral[0]));
    expect(await ctx.a.deps.store.getProposal(aRef.id)).toMatchObject({ teamId: "TONE" });
    expect(await ctx.b.deps.store.getProposal(bRef.id)).toMatchObject({ teamId: "TTWO" });
    expect(await ctx.b.deps.store.getProposal(aRef.id)).toBeUndefined();
    expect(ctx.runtime.mock.calls.map(([install]) => [install.orgId, install.accessToken])).toEqual([["org-a","xoxb-TONE"],["org-b","xoxb-TTWO"]]);
  });
  it("authenticates raw bytes before parsing or looking up installations", async () => {
    const ctx = await setupGateway();
    expect((await ctx.gateway.handle(signed("malformed", "/slack/events", "wrong"))).status).toBe(401);
    expect((await ctx.gateway.handle({ ...ctx.event("TONE"), rawBody: ctx.event("TONE").rawBody + " " })).status).toBe(401);
    expect(ctx.registry.lookups).toHaveLength(0);
    expect((await ctx.gateway.handle(signed(JSON.stringify({ type: "url_verification", challenge: "challenge" }), "/slack/events"))).body).toEqual({ challenge: "challenge" });
    expect(ctx.registry.lookups).toHaveLength(0);
  });
  it.each([{ team_id: undefined }, { api_app_id: "AOTHER" }, { team: { id: "TTWO" } }, { authorizations: [{ team_id: "TTWO" }] }])("refuses absent or conflicting identities %j without registry access", async extra => {
    const ctx = await setupGateway();
    const raw = JSON.stringify({ type: "event_callback", api_app_id: "AAPP", team_id: "TONE", ...extra });
    expect((await ctx.gateway.handle(signed(raw,"/slack/events"))).status).toBe(400);
    expect(ctx.registry.lookups).toHaveLength(0); expect(ctx.a.calls.ephemeral).toHaveLength(0);
  });
  it("refuses unknown and disconnected teams and requires workspace and worker authorization for maintenance", async () => {
    const ctx = await setupGateway();
    expect((await ctx.gateway.handle(ctx.event("TUNKNOWN"))).status).toBe(403);
    await ctx.registry.deactivate("org-a","AAPP","TONE",1,"disconnected");
    expect((await ctx.gateway.handle(ctx.event("TONE"))).status).toBe(403);
    const before = ctx.registry.lookups.length;
    expect((await ctx.gateway.handle({ method: "POST", path: "/slack/feedback", headers: {}, rawBody: '{"teamId":"TTWO"}' })).status).toBe(401);
    expect(ctx.registry.lookups).toHaveLength(before);
    expect((await ctx.gateway.handle({ method: "POST", path: "/slack/feedback", headers: { authorization: `Bearer ${"w".repeat(32)}` }, rawBody: '{}' })).status).toBe(400);
    expect((await ctx.gateway.handle({ method: "POST", path: "/slack/feedback", headers: { authorization: `Bearer ${"w".repeat(32)}` }, rawBody: '{"teamId":"TTWO"}' })).status).toBe(200);
    expect(ctx.registry.lookups.at(-1)).toEqual({ appId: "AAPP", teamId: "TTWO" });
  });
  it("withholds cross-team and teamless actions, modal edits and completion records", async () => {
    const ctx = await setupGateway(); await ctx.gateway.handle(ctx.event("TONE"));
    const value = buttonValue(ctx.a.calls.ephemeral[0]); const proposal = await ctx.a.deps.store.getProposal(JSON.parse(value).id);
    if (!proposal) throw new Error("Expected proposal");
    await ctx.b.deps.store.saveProposal(proposal);
    const click = { type: "block_actions", api_app_id: "AAPP", team: { id: "TTWO" }, user: { id: "UMAYA" }, response_url: "https://hooks.slack.com/x", actions: [{ action_id: "track_task", value }] };
    expect((await ctx.gateway.handle(interaction(click))).status).toBe(200); expect(ctx.b.calls.created).toHaveLength(0);
    const modal = { type: "view_submission", api_app_id: "AAPP", team: { id: "TTWO" }, user: { id: "UMAYA" }, view: { callback_id: "edit_commitment", private_metadata: value, state: { values: {} } } };
    expect((await ctx.gateway.handle(interaction(modal))).body).toMatchObject({ response_action: "errors" });
    const scoped = await ctx.gateway.forTeam("TTWO"); if (!scoped) throw new Error("Expected installed deps");
    await confirmProposal(scoped,{ ...proposal, teamId: undefined },"UMAYA"); expect(ctx.b.calls.created).toHaveLength(0);
    await scoped.store.saveTask({ fingerprint: "foreign", project: "DB", title: "Foreign", tokens: [], issueKey: "DB-77", issueUrl: "https://x.atlassian.net/browse/DB-77", trackedBy: "UMAYA", assigneeSlackId: "UMAYA", channel: "CDB", messageTs: "1", mentionCount: 1, teamId: "TONE" });
    expect(await runCompletionFeedback(scoped)).toMatchObject({ observed: 0, delivered: 0, withheld: 0 }); expect(ctx.b.calls.reads).toHaveLength(0);
  });
  it("processes current-team completion despite more than a page of old teamless work", async () => {
    const ctx = await setupGateway(); const deps = await ctx.gateway.forTeam("TONE"); if (!deps) throw new Error("Expected deps");
    const link = { fingerprint: "valid", titleFingerprint: "same-title", project: "DB", title: "Raise quota", tokens: ["raise","quota"], issueKey: "DB-77",
      issueUrl: "https://x.atlassian.net/browse/DB-77", trackedBy: "UMAYA", assigneeSlackId: "UMAYA", channel: "CDB", messageTs: "1", mentionCount: 1 };
    for (let n = 0; n < 40; n++) {
      const legacy = { ...link, fingerprint: `old-${n}` }; await deps.store.saveTask(legacy);
      await deps.store.observeCompletion(legacy,{ statusCategory: "new", providerVersion: "1" }); await deps.store.observeCompletion(legacy,{ statusCategory: "done", providerVersion: "2" });
    }
    const valid = { ...link, teamId: "TONE" }; await deps.store.saveTask(valid);
    await deps.store.observeCompletion(valid,{ statusCategory: "new", providerVersion: "1" }); await deps.store.observeCompletion(valid,{ statusCategory: "done", providerVersion: "2" });
    deps.broppy.issueAccess = async (_email,key) => ({ key, url: `https://x.atlassian.net/browse/${key}`, statusCategory: "done", providerVersion: "2" });
    expect((await deps.store.findTask("DB","same-title",[],"TONE"))?.fingerprint).toBe("valid");
    expect((await deps.store.candidates("DB","same-title",["raise","quota"],"TONE")).map(link => link.fingerprint)).toEqual(["valid"]);
    expect(await runCompletionFeedback(deps,1)).toEqual({ observed: 1, delivered: 1, withheld: 0 });
    expect(ctx.a.calls.messages).toHaveLength(1);
    expect((await deps.store.listTasks(100)).length).toBe(41);
  });
  it("rechecks generation before deferred answers and retains known in-flight Jira receipts", async () => {
    const ctx = await setupGateway();
    const scoped = await ctx.gateway.forTeam("TONE"); if (!scoped) throw new Error("Expected installed deps");
    let release: () => void = () => {};
    const paused = new Promise<void>(resolve => { release = resolve; });
    const originalAsk = scoped.broppy.ask;
    scoped.broppy.ask = async (...args) => { await paused; return originalAsk(...args); };
    const command = new URLSearchParams({ api_app_id: "AAPP", team_id: "TONE", user_id: "UMAYA", text: "question", response_url: "https://hooks.slack.com/x" }).toString();
    const result = await ctx.gateway.handle(signed(command,"/slack/commands")); expect(result.status).toBe(200);
    await ctx.registry.deactivate("org-a","AAPP","TONE",1,"disconnected"); release();
    await Promise.all(ctx.a.deferred); expect(ctx.a.calls.responses).toHaveLength(0);
    const another = await setupGateway(); await another.gateway.handle(another.event("TONE"));
    const current = await another.gateway.forTeam("TONE"); if (!current) throw new Error("Expected deps");
    const value = buttonValue(another.a.calls.ephemeral[0]); const proposal = await current.store.getProposal(JSON.parse(value).id); if (!proposal) throw new Error("Expected proposal");
    const create = current.broppy.createIssue;
    current.broppy.createIssue = async (...args) => { const receipt = await create(...args); await another.registry.deactivate("org-a","AAPP","TONE",1,"disconnected"); return receipt; };
    await confirmProposal(current,proposal,"UMAYA");
    const saved = await current.store.getProposal(proposal.id);
    expect(saved?.status).toBe("created"); expect((await current.store.getOperation(saved?.operationId ?? ""))?.issueKey).toBe("DB-77");
    expect(another.a.calls.messages).toHaveLength(0);
  });
  it("scopes actual HTTP credentials, task-store organization and generation checks per installation", async () => {
    const ctx = await setupGateway(); const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return Response.json({ ok: true, user: { profile: { email: "maya@example.test" } } }); });
    try {
      for (const teamId of ["TONE","TTWO"]) {
        const install = await ctx.registry.resolve("AAPP",teamId); if (!install) throw new Error("Expected install");
        const scope = { ...install, current: () => ctx.registry.current("AAPP",teamId,install.generation) };
        const deps = installedDeps(install.runtime,install.accessToken,scope,SECRET,() => {});
        await deps.slack.userEmail("UMAYA"); await deps.store.getProposal("proposal");
      }
      expect(calls[0].init?.headers).toMatchObject({ authorization: "Bearer xoxb-TONE" });
      expect(calls[1].url).toContain("https://org-a.store.test/"); expect(calls[1].url).toContain("org_id=eq.org-a");
      expect(calls[2].init?.headers).toMatchObject({ authorization: "Bearer xoxb-TTWO" }); expect(calls[3].url).toContain("org_id=eq.org-b");
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("Slack uninstall and bot revocation", () => {
  it("ignores user token revocations and valid-current-token late uninstall notices", async () => {
    const ctx = await setupGateway(); const probe = vi.fn<typeof fetch>(async () => Response.json({ ok: true, team_id: "TONE", user_id: "UBOT" }));
    const gateway = new SlackGateway({ appId: "AAPP", signingSecret: SECRET, registry: ctx.registry, now: () => NOW, defer: () => {}, transport: probe });
    const event = (event: unknown) => signed(JSON.stringify({ type: "event_callback", api_app_id: "AAPP", team_id: "TONE", event }),"/slack/events");
    expect((await gateway.handle(event({ type: "tokens_revoked", tokens: { oauth: ["UMAYA"], bot: [] } }))).status).toBe(200); expect(probe).not.toHaveBeenCalled();
    expect((await gateway.handle(event({ type: "app_uninstalled" }))).status).toBe(200);
    expect((await ctx.registry.status("org-a","AAPP")).state).toBe("active");
    probe.mockResolvedValue(Response.json({ ok: false, error: "ratelimited" })); expect((await gateway.handle(event({ type: "app_uninstalled" }))).status).toBe(503);
    expect((await ctx.registry.status("org-a","AAPP")).state).toBe("active");
    probe.mockResolvedValue(Response.json({ ok: false, error: "token_revoked" })); expect((await gateway.handle(event({ type: "tokens_revoked", tokens: { bot: ["UBOT"] } }))).status).toBe(200);
    expect((await ctx.registry.status("org-a","AAPP")).state).toBe("uninstalled");
  });
  it("cannot deactivate a reinstall that wins the probe race", async () => {
    const ctx = await setupGateway();
    const probe: typeof fetch = async () => { await ctx.registry.seed("TONE","org-a","xoxb-new"); return Response.json({ ok: false, error: "invalid_auth" }); };
    const gateway = new SlackGateway({ appId: "AAPP", signingSecret: SECRET, registry: ctx.registry, now: () => NOW, defer: () => {}, transport: probe });
    expect((await gateway.handle(signed(JSON.stringify({ type: "event_callback", api_app_id: "AAPP", team_id: "TONE", event: { type: "app_uninstalled" } }),"/slack/events"))).status).toBe(200);
    expect((await ctx.registry.resolve("AAPP","TONE"))?.accessToken).toBe("xoxb-new");
  });
});
