import { describe, expect, it, vi } from "vitest";
import { SlackInstallationOAuth } from "./slack-installation.js";
import { SLACK_BOT_SCOPES } from "../../slack/src/app-manifest.js";
import { admin, testRuntime, TestInstallationRegistry } from "../../slack/src/installation-fixtures.js";

function setup(grantOverride: Record<string, unknown> = {}, proofOverride: Record<string, unknown> = {}) {
  const registry = new TestInstallationRegistry();
  const directory = vi.fn(async () => admin);
  const transport = vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    const body = path.endsWith("oauth.v2.access") ? { ok: true, app_id: "AAPP", token_type: "bot", access_token: "xoxb-test", bot_user_id: "UBOT",
      team: { id: "TONE", name: "Company A" }, scope: SLACK_BOT_SCOPES.join(","), authed_user: { id: "UMAYA" }, is_enterprise_install: false, ...grantOverride }
      : path.endsWith("auth.test") ? { ok: true, team_id: "TONE", user_id: "UBOT", bot_id: "BBOT", ...proofOverride }
      : { ok: true, user: { id: "UMAYA", profile: { email: "maya@example.test" } } };
    return Response.json(body);
  });
  const oauth = new SlackInstallationOAuth({ appId: "AAPP", clientId: "client", clientSecret: "secret", orgId: "org-a", apiOrigin: "https://org-a.api.test", webOrigin: "https://org-a.web.test" }, registry, () => testRuntime(), directory, transport);
  const begin = async () => new URL(await oauth.begin(admin)).searchParams.get("state") ?? "";
  const callback = (state: string) => oauth.callback({ state, code: "code", error: "" });
  return { oauth, registry, transport, directory, begin, callback };
}
describe("admin Slack installation", () => {
  it("installs a validated top-level bot grant and returns token-free status", async () => {
    const ctx = setup(); const state = await ctx.begin();
    expect(ctx.registry.attempts[0].hash).not.toContain(state);
    expect(await ctx.callback(state)).toBe("installed");
    expect(await ctx.oauth.status(admin)).toMatchObject({ state: "active", teamId: "TONE", generation: 1 });
    const status = JSON.stringify(await ctx.oauth.status(admin));
    expect(status).not.toMatch(/xoxb|serviceToken|storeKey|secret/);
    expect(await ctx.callback(state)).toBe("failed");
    expect(ctx.transport).toHaveBeenCalledTimes(3);
  });
  it.each([{ token_type: "user" }, { app_id: "AOTHER" }, { scope: "chat:write" }, { access_token: "xoxp-person" }, { authed_user: {} }])("refuses incomplete bot proof %j", async invalid => {
    const ctx = setup(invalid); expect(await ctx.callback(await ctx.begin())).toBe("failed");
    expect((await ctx.oauth.status(admin)).state).toBe("not_installed");
  });
  it("accepts an app that asks Slack for more permissions than Broppy needs", async () => {
    const ctx = setup({ scope: [...SLACK_BOT_SCOPES, "app_mentions:read", "im:history"].join(",") });
    expect(await ctx.callback(await ctx.begin())).toBe("installed");
  });
  it.each([{ expires_in: 43200 }, { refresh_token: "refresh" }, { is_enterprise_install: true }])("refuses unsupported installs %j without replacement", async invalid => {
    const ctx = setup(invalid); await ctx.registry.seed("TONE","org-a","xoxb-current");
    expect(await ctx.callback(await ctx.begin())).toBe("unsupported");
    expect((await ctx.registry.resolve("AAPP","TONE"))?.accessToken).toBe("xoxb-current");
  });
  it.each([{ team_id: "TOTHER" }, { user_id: "UOTHER" }, { bot_id: undefined }])("rejects auth.test disagreement %j", async invalid => {
    const ctx = setup({},invalid); expect(await ctx.callback(await ctx.begin())).toBe("failed");
  });
  it("consumes denial, missing-code and expired state without exchanging a grant", async () => {
    const ctx = setup(); const denied = await ctx.begin();
    expect(await ctx.oauth.callback({ state: denied, code: "", error: "access_denied" })).toBe("denied");
    expect(await ctx.callback(denied)).toBe("failed");
    expect(await ctx.oauth.callback({ state: await ctx.begin(), code: "", error: "" })).toBe("failed");
    const expired = await ctx.begin(); ctx.registry.clock += 600_001;
    expect(await ctx.callback(expired)).toBe("failed"); expect(ctx.transport).not.toHaveBeenCalled();
  });
  it("rechecks active same-org admin identity and installer email", async () => {
    const ctx = setup(); const state = await ctx.begin(); ctx.directory.mockResolvedValue({ ...admin, active: false });
    expect(await ctx.callback(state)).toBe("failed"); expect(ctx.transport).not.toHaveBeenCalled();
    const other = setup(); other.transport.mockImplementation(async input => String(input).endsWith("users.info") ? Response.json({ ok: true, user: { id: "UMAYA", profile: { email: "other@example.test" } } })
      : String(input).endsWith("auth.test") ? Response.json({ ok: true, team_id: "TONE", user_id: "UBOT", bot_id: "BBOT" }) : Response.json({ ok: true, app_id: "AAPP", token_type: "bot", access_token: "xoxb-test", bot_user_id: "UBOT", team: { id: "TONE" }, scope: SLACK_BOT_SCOPES.join(","), authed_user: { id: "UMAYA" }, is_enterprise_install: false }));
    expect(await other.callback(await other.begin())).toBe("email_mismatch");
  });
  it.each([undefined, "", "   "])("requires configured Slack identity %j before consent and again at callback", async identity => {
    const ctx = setup(); const state = await ctx.begin();
    const identities = identity === undefined ? undefined : { ...admin.platformIdentities, slack: identity, jira: "", confluence: "", drive: "" };
    ctx.directory.mockResolvedValue({ ...admin, platformIdentities: identities });
    await expect(ctx.oauth.begin(admin)).rejects.toThrow("profile needs a Slack email");
    expect(await ctx.callback(state)).toBe("failed"); expect(ctx.transport).not.toHaveBeenCalled();
  });
  it("preserves current grant on team collision and never remotely revokes it", async () => {
    const ctx = setup(); await ctx.registry.seed("TONE","org-b","xoxb-owner");
    expect(await ctx.callback(await ctx.begin())).toBe("conflict");
    expect((await ctx.registry.resolve("AAPP","TONE"))?.accessToken).toBe("xoxb-owner");
    expect(ctx.transport.mock.calls.every(([url]) => !String(url).includes("revoke") && !String(url).includes("uninstall"))).toBe(true);
  });
  it("older callbacks cannot replace a later successful install, and disconnect fences pending callbacks", async () => {
    const ctx = setup(); const old = await ctx.begin(); const latest = await ctx.begin();
    expect(await ctx.callback(latest)).toBe("installed"); expect(await ctx.callback(old)).toBe("conflict");
    const pending = await ctx.begin(); expect(await ctx.oauth.disconnect(admin,1)).toBe(true);
    expect(await ctx.callback(pending)).toBe("failed"); expect(await ctx.registry.resolve("AAPP","TONE")).toBeUndefined();
    expect(await ctx.callback(await ctx.begin())).toBe("installed");
    expect(await ctx.oauth.refresh(admin,3)).toBe(true); expect(await ctx.oauth.refresh(admin,3)).toBe(false);
  });
});

describe("one consent that installs Broppy and connects Slack as a source", () => {
  function combined(authed: Record<string, unknown> = {}, userProof: Record<string, unknown> = {}) {
    const ctx = setup();
    const stored: unknown[] = []; const discarded = vi.fn();
    ctx.oauth.link = { scopes: ["channels:read", "users:read.email"], store: async (_admin, grant) => { stored.push(grant); }, discard: async () => { discarded(); } };
    ctx.transport.mockImplementation(async (input, init) => {
      const path = String(input);
      const bearer = new Headers((init as RequestInit | undefined)?.headers).get("authorization");
      if (path.endsWith("oauth.v2.access")) return Response.json({ ok: true, app_id: "AAPP", token_type: "bot", access_token: "xoxb-test", bot_user_id: "UBOT", team: { id: "TONE", name: "Company A" },
        scope: SLACK_BOT_SCOPES.join(","), authed_user: { id: "UMAYA", access_token: "xoxp-admin", scope: "channels:read,users:read.email", ...authed }, is_enterprise_install: false });
      if (path.endsWith("auth.test")) return Response.json(bearer === "Bearer xoxp-admin" ? { ok: true, team_id: "TONE", user_id: "UMAYA", ...userProof } : { ok: true, team_id: "TONE", user_id: "UBOT", bot_id: "BBOT" });
      return Response.json({ ok: true, user: { id: "UMAYA", profile: { email: "maya@example.test" } } });
    });
    return { ...ctx, stored, discarded };
  }
  it("asks for the bot and the admin's own scopes together, then stores the admin's token as the shared connection", async () => {
    const ctx = combined();
    const url = new URL(await ctx.oauth.begin(admin));
    expect(url.searchParams.get("user_scope")).toBe("channels:read,users:read.email");
    expect(url.searchParams.get("scope")).toBe(SLACK_BOT_SCOPES.join(","));
    expect(await ctx.callback(url.searchParams.get("state")!)).toBe("installed");
    expect(ctx.stored).toEqual([{ access_token: "xoxp-admin", scope: "channels:read,users:read.email" }]);
    expect(JSON.stringify(await ctx.oauth.status(admin))).not.toContain("xoxp");
  });
  it.each([{ access_token: undefined }, { access_token: "xoxb-bot" }, { refresh_token: "r" }])("refuses a missing or unusable admin token %j without installing", async invalid => {
    const ctx = combined(invalid);
    expect(await ctx.callback(await ctx.begin())).toBe("failed");
    expect(ctx.stored).toEqual([]);
    expect((await ctx.oauth.status(admin)).state).toBe("not_installed");
  });
  it("refuses a token that belongs to someone else", async () => {
    const ctx = combined({}, { user_id: "UOTHER" });
    expect(await ctx.callback(await ctx.begin())).toBe("failed");
    expect(ctx.stored).toEqual([]);
  });
  it("removes the stored connection again when the workspace belongs to another organization", async () => {
    const ctx = combined(); await ctx.registry.seed("TONE", "org-b", "xoxb-owner");
    expect(await ctx.callback(await ctx.begin())).toBe("conflict");
    expect(ctx.discarded).toHaveBeenCalled();
  });
});
