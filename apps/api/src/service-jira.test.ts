import { describe, expect, it } from "vitest";
import type { User } from "@brain/types";
import { JiraAsUser, parseComment, parseIssue } from "./service-jira.js";

const maya = { id: "maya", name: "Maya", platformIdentities: { jira: "maya@acme.test" } } as unknown as User;
const accountId = async (email: string) => email === "maya@acme.test" ? "acct-maya" : undefined;
const site = { baseUrl: "https://acme.atlassian.net", cloudId: "cloud-1" };

describe("JiraAsUser", () => {
  it("creates the issue with the shared token on the org site and names the person", async () => {
    let seen: any;
    const jira = new JiraAsUser({ authorization: async () => "Bearer mine", siteFor: async () => site }, undefined, async (url, init) => {
      seen = { url: String(url), headers: (init as any).headers, body: JSON.parse((init as any).body) };
      return new Response(JSON.stringify({ key: "DB-9" }), { status: 201 });
    });
    expect(await jira.createIssue(maya, { project: "DB", summary: "Raise quota", description: "d", dueDate: "2026-10-16" }))
      .toEqual({ key: "DB-9", url: "https://acme.atlassian.net/browse/DB-9" });
    expect(seen.url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue");
    expect(seen.headers.authorization).toBe("Bearer mine");
    expect(JSON.stringify(seen.body.fields.description)).toContain("Tracked in Broppy for Maya.");
    expect(seen.body.fields).toMatchObject({ project: { key: "DB" }, summary: "Raise quota", duedate: "2026-10-16" });
  });
  it("returns undefined without calling Jira when the admin hasn't connected Jira", async () => {
    let called = false;
    const jira = new JiraAsUser({ authorization: async () => undefined, siteFor: async () => site }, undefined, async () => { called = true; return new Response("{}"); });
    expect(await jira.createIssue(maya, { project: "DB", summary: "s", description: "d" })).toBeUndefined();
    expect(await jira.comment(maya, "DB-1", "t")).toBe(false);
    expect(called).toBe(false);
  });
  it("surfaces a Jira refusal instead of hiding it", async () => {
    const jira = new JiraAsUser({ authorization: async () => "Bearer t", siteFor: async () => site }, undefined, async () => new Response("{}", { status: 403 }));
    await expect(jira.createIssue(maya, { project: "DB", summary: "s", description: "d" })).rejects.toThrow("403");
  });

  it("reads status and the operation marker without exposing the description, once Jira says the person may browse the issue", async () => {
    const marker = "12345678-1234-1234-1234-123456789abc";
    const urls: string[] = [];
    const jira = new JiraAsUser({ authorization: async () => "Bearer shared", siteFor: async () => site }, accountId, async url => {
      urls.push(String(url));
      if (String(url).includes("user/permission/search")) return Response.json([{ accountId: "acct-maya" }]);
      return Response.json({ fields: { status: { statusCategory: { key: "done" } }, updated: "2026-10-05T09:00:00Z",
        description: { content: [{ text: `Private source text. Broppy operation: ${marker}` }] } } });
    });
    expect(await jira.access(maya, "DB-9")).toEqual({ key: "DB-9", url: "https://acme.atlassian.net/browse/DB-9",
      statusCategory: "done", providerVersion: "2026-10-05T09:00:00Z", operationMarker: marker });
    expect(urls[0]).toContain("accountId=acct-maya");
    expect(urls[0]).toContain("issueKey=DB-9");
  });

  it("withholds an issue the person cannot browse, and refuses an inactive actor without provider calls", async () => {
    let calls = 0;
    const jira = new JiraAsUser({ authorization: async () => "Bearer shared", siteFor: async () => site }, accountId, async () => {
      calls++; return Response.json([]);
    });
    expect(await jira.access(maya, "DB-9")).toBeUndefined();
    await expect(jira.access({ ...maya, active: false }, "DB-9")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("withholds the issue when the person cannot be matched to an Atlassian account", async () => {
    let calls = 0;
    const jira = new JiraAsUser({ authorization: async () => "Bearer shared", siteFor: async () => site }, async () => undefined, async () => { calls++; return Response.json([]); });
    expect(await jira.access(maya, "DB-9")).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("JiraAsUser for the workspace", () => {
  it("lets the person create only where their own Jira account may", async () => {
    const urls: string[] = [];
    const jira = new JiraAsUser({ authorization: async () => "Bearer shared", siteFor: async () => site }, accountId, async url => {
      urls.push(String(url));
      return Response.json(String(url).includes("projectKey=DB") ? [{ accountId: "acct-maya" }] : []);
    });
    expect(await jira.canCreate(maya, "DB")).toBe(true);
    expect(await jira.canCreate(maya, "SEC")).toBe(false);
    expect(urls[0]).toContain("permissions=CREATE_ISSUES");
    // No Jira identity, an inactive person or a malformed project never reach Jira.
    expect(await jira.canCreate({ ...maya, platformIdentities: {} } as unknown as User, "DB")).toBe(false);
    expect(await jira.canCreate({ ...maya, active: false }, "DB")).toBe(false);
    expect(await jira.canCreate(maya, "db")).toBe(false);
    expect(urls).toHaveLength(2);
  });

  it("moves an issue to done through a transition into the done category, when the person may", async () => {
    const posted: any[] = [];
    const jira = new JiraAsUser({ authorization: async () => "Bearer shared", siteFor: async () => site }, accountId, async (url, init) => {
      const href = String(url);
      if (href.includes("user/permission/search")) return Response.json([{ accountId: "acct-maya" }]);
      if ((init as any)?.method === "POST") { posted.push(JSON.parse((init as any).body)); return new Response(null, { status: 204 }); }
      return Response.json({ transitions: [{ id: "11", to: { statusCategory: { key: "indeterminate" } } }, { id: "31", to: { statusCategory: { key: "done" } } }] });
    });
    expect(await jira.markDone(maya, "DB-9")).toBe(true);
    expect(posted).toEqual([{ transition: { id: "31" } }]);
  });

  it("refuses to mark done without permission, or when the workflow has no way to done", async () => {
    const denied = new JiraAsUser({ authorization: async () => "Bearer shared", siteFor: async () => site }, accountId, async url =>
      Response.json(String(url).includes("TRANSITION_ISSUES") ? [] : [{ accountId: "acct-maya" }]));
    expect(await denied.markDone(maya, "DB-9")).toBe(false);
    const stuck = new JiraAsUser({ authorization: async () => "Bearer shared", siteFor: async () => site }, accountId, async url =>
      String(url).includes("user/permission/search") ? Response.json([{ accountId: "acct-maya" }]) : Response.json({ transitions: [{ id: "11", to: { statusCategory: { key: "new" } } }] }));
    expect(await stuck.markDone(maya, "DB-9")).toBe(false);
  });
});

describe("request validation", () => {
  it("accepts what the Slack app sends and rejects the rest", () => {
    expect(parseIssue({ project: "DB", summary: "s", description: "d", dueDate: "2026-10-16" })).toMatchObject({ project: "DB" });
    for (const bad of [{ project: "db" }, { project: "DB", summary: "", description: "d" }, { project: "DB", summary: "s", description: "d", dueDate: "tomorrow" }]) {
      expect(() => parseIssue(bad)).toThrow();
    }
    expect(parseComment({ key: "DB-16", text: "hi" })).toEqual({ key: "DB-16", text: "hi" });
    expect(() => parseComment({ key: "../x", text: "hi" })).toThrow();
  });
});
