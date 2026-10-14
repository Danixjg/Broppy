import { describe, expect, it } from "vitest";
import { parseRuntime } from "./runtime.js";

const base = { orgId: "org_acme1", apiUrl: "https://api.test", webUrl: "https://web.test", storeUrl: "https://store.test", storeKey: "k",
  serviceToken: "s".repeat(43), people: [], channelProjects: {}, defaultProject: "", threshold: 0.6, destinations: [], completionPolicies: [] };

describe("a company's Slack runtime", () => {
  it("may have no Jira site and no default project yet", () => {
    const runtime = parseRuntime(base);
    expect(runtime.jiraBaseUrl).toBeUndefined();
    expect(runtime.defaultProject).toBe("");
  });
  it("refuses Jira destinations or completion notices without a Jira site to check links against", () => {
    const destination = { channel: "C1", project: "OPS", allowedSlackIds: ["U1"], disclosureFields: ["summary"] };
    expect(() => parseRuntime({ ...base, destinations: [destination] })).toThrow("need a Jira site");
    expect(() => parseRuntime({ ...base, completionPolicies: [{ channel: "C1", project: "OPS", allowedSlackIds: ["U1"] }] })).toThrow("need a Jira site");
    expect(parseRuntime({ ...base, jiraBaseUrl: "https://acme.atlassian.net/", destinations: [destination] }).jiraBaseUrl).toBe("https://acme.atlassian.net");
  });
});
