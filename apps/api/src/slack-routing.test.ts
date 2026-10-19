import { describe, expect, it } from "vitest";
import { loadMockCorpus, MockConnector } from "@brain/connectors";
import { Brain } from "./brain.js";
import { companyRuntime, SlackInstallationOAuth } from "./slack-installation.js";
import { admin, TestInstallationRegistry } from "../../slack/src/installation-fixtures.js";
import { SLACK_BOT_SCOPES } from "../../slack/src/app-manifest.js";

const env = { SLACK_SERVICE_TOKEN: "s".repeat(40), API_ORIGIN: "https://api.test", WEB_ORIGIN: "https://web.test",
  SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "secret" } as NodeJS.ProcessEnv;
const route = { channel: "CDB", project: "DB", audience: ["UMAYA", "UDAVID"] };

describe("Slack channels routed to Jira for a company that signed itself up", () => {
  it("gives a routed channel Track in Jira, disclosing only the summary to the saved members", () => {
    const runtime = companyRuntime(env, "org-a", "https://acme.atlassian.net", [route]);
    expect(runtime.channelProjects).toEqual({ CDB: "DB" });
    expect(runtime.destinations).toEqual([{ channel: "CDB", project: "DB", allowedSlackIds: ["UMAYA", "UDAVID"], disclosureFields: ["summary"] }]);
    expect(runtime.completionPolicies).toEqual([{ channel: "CDB", project: "DB", allowedSlackIds: ["UMAYA", "UDAVID"] }]);
  });

  it("offers nothing to Jira without a Jira site, or for a route with no one in it", () => {
    expect(companyRuntime(env, "org-a", undefined, [route])).toMatchObject({ channelProjects: {}, destinations: [], completionPolicies: [] });
    expect(companyRuntime(env, "org-a", "https://acme.atlassian.net", [{ ...route, audience: [] }]).destinations).toEqual([]);
  });

  it("sends the saved routes to the installed bot", async () => {
    const registry = new TestInstallationRegistry();
    const routes = [route];
    const transport = async (input: RequestInfo | URL) => {
      const path = String(input);
      return Response.json(path.endsWith("oauth.v2.access") ? { ok: true, app_id: "AAPP", token_type: "bot", access_token: "xoxb-test", bot_user_id: "UBOT",
        team: { id: "TONE", name: "Company A" }, scope: SLACK_BOT_SCOPES.join(","), authed_user: { id: "UMAYA" }, is_enterprise_install: false }
        : path.endsWith("auth.test") ? { ok: true, team_id: "TONE", user_id: "UBOT", bot_id: "BBOT" }
        : { ok: true, user: { id: "UMAYA", profile: { email: "maya@example.test" } } });
    };
    const oauth = new SlackInstallationOAuth({ appId: "AAPP", clientId: "client", clientSecret: "secret", orgId: admin.orgId!, apiOrigin: "https://api.test", webOrigin: "https://web.test" },
      registry, () => companyRuntime(env, admin.orgId!, "https://acme.atlassian.net", routes), async () => admin, transport);
    expect(await oauth.publish(admin)).toBe(false);
    const state = new URL(await oauth.begin(admin)).searchParams.get("state")!;
    expect(await oauth.callback({ state, code: "code", error: "" })).toBe("installed");
    routes.push({ channel: "COPS", project: "OPS", audience: ["UNUR"] });
    expect(await oauth.publish(admin)).toBe(true);
    const active = await registry.resolve("AAPP", "TONE");
    expect(active?.runtime.channelProjects).toEqual({ CDB: "DB", COPS: "OPS" });
  });
});

describe("an admin choosing where a channel's tasks go", () => {
  async function brainWithChannel() {
    const corpus = loadMockCorpus();
    const slack = (await corpus.connectors.slack.listItems()).map(doc => doc.docId === "slack:db-migration" ? { ...doc, sourceNativeId: "CDB" } : doc);
    const brain = new Brain(undefined, { connectors: { ...corpus.connectors, slack: new MockConnector("slack", slack) } });
    await brain.syncAll();
    return brain;
  }

  it("lists the channels Broppy reads and the Jira projects it knows, and saves a route with its audience", async () => {
    const brain = await brainWithChannel();
    const maya = brain.user("maya")!;
    const routing = brain.slackRouting(maya);
    expect(routing.channels).toEqual([expect.objectContaining({ id: "CDB" })]);
    expect(routing.projects).toContain("DB");
    await brain.routeSlackChannel(maya, "CDB", "DB", ["UMAYA", "UDAVID", "UMAYA"]);
    expect(brain.slackRoutes.get("CDB")).toMatchObject({ project: "DB", audience: ["UDAVID", "UMAYA"], savedBy: "maya" });
    expect(brain.slackRouting(maya).channels[0]).toMatchObject({ project: "DB", audience: 2 });
    expect(brain.audit.entries).toContainEqual(expect.objectContaining({ type: "slack_route_changed", actor: "maya" }));
    await brain.routeSlackChannel(maya, "CDB", undefined, []);
    expect(brain.slackRoutes.size).toBe(0);
  });

  it("refuses non-admins, unknown channels and projects, and a route nobody could see", async () => {
    const brain = await brainWithChannel();
    const maya = brain.user("maya")!;
    const member = brain.users.find(user => user.role !== "admin" && user.orgId === maya.orgId)!;
    expect(() => brain.slackRouting(member)).toThrow("Forbidden");
    await expect(brain.routeSlackChannel(maya, "COTHER", "DB", ["UMAYA"])).rejects.toThrow("doesn't read that Slack channel");
    await expect(brain.routeSlackChannel(maya, "CDB", "NOPE", ["UMAYA"])).rejects.toThrow("doesn't know that Jira project");
    await expect(brain.routeSlackChannel(maya, "CDB", "DB", [])).rejects.toThrow("couldn't read who is in that channel");
    expect(brain.slackRoutes.size).toBe(0);
  });
});
