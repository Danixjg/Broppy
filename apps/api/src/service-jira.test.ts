import { describe, expect, it } from "vitest";
import type { User } from "@brain/types";
import { JiraAsUser, parseComment, parseIssue } from "./service-jira.js";

const maya = { id: "maya" } as User;
const site = { baseUrl: "https://acme.atlassian.net", cloudId: "cloud-1" };

describe("JiraAsUser", () => {
  it("creates the issue with the person's own token on their site", async () => {
    let seen: any;
    const jira = new JiraAsUser({ authorizationFor: async (user: string) => user === "maya" ? "Bearer mine" : undefined, siteFor: async () => site }, async (url, init) => {
      seen = { url: String(url), headers: (init as any).headers, body: JSON.parse((init as any).body) };
      return new Response(JSON.stringify({ key: "DB-9" }), { status: 201 });
    });
    expect(await jira.createIssue(maya, { project: "DB", summary: "Raise quota", description: "d", dueDate: "2026-10-16" }))
      .toEqual({ key: "DB-9", url: "https://acme.atlassian.net/browse/DB-9" });
    expect(seen.url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue");
    expect(seen.headers.authorization).toBe("Bearer mine");
    expect(seen.body.fields).toMatchObject({ project: { key: "DB" }, summary: "Raise quota", duedate: "2026-10-16" });
  });
  it("returns undefined without calling Jira when the person hasn't connected", async () => {
    let called = false;
    const jira = new JiraAsUser({ authorizationFor: async () => undefined, siteFor: async () => site }, async () => { called = true; return new Response("{}"); });
    expect(await jira.createIssue(maya, { project: "DB", summary: "s", description: "d" })).toBeUndefined();
    expect(await jira.comment(maya, "DB-1", "t")).toBe(false);
    expect(called).toBe(false);
  });
  it("surfaces a Jira refusal instead of hiding it", async () => {
    const jira = new JiraAsUser({ authorizationFor: async () => "Bearer t", siteFor: async () => site }, async () => new Response("{}", { status: 403 }));
    await expect(jira.createIssue(maya, { project: "DB", summary: "s", description: "d" })).rejects.toThrow("403");
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
