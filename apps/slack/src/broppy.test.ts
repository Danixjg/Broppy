import { describe, expect, it } from "vitest";
import { BroppyClient, JiraRefusedError, NotLinkedError } from "./broppy.js";

describe("BroppyClient", () => {
  it("sends the service secret and the Slack email, never a demo header", async () => {
    let seen: any;
    const client = new BroppyClient("https://api.test", "s".repeat(32), async (url, init) => {
      seen = { url: String(url), headers: (init as any).headers };
      return new Response(JSON.stringify({ text: "ok", citations: [{ title: "T", url: "https://x" }] }));
    });
    expect(await client.ask("maya@x.test", "q")).toEqual({ text: "ok", citations: [{ title: "T", url: "https://x" }] });
    expect(seen.url).toBe("https://api.test/v1/query");
    expect(seen.headers).toMatchObject({ "x-broppy-service": "s".repeat(32), "x-act-as-slack-email": "maya@x.test" });
    expect(seen.headers["x-demo-user"]).toBeUndefined();
  });
  it("names the installation's company when it has one", async () => {
    let headers: any;
    const client = new BroppyClient("https://api.test", "s".repeat(32), async (_url, init) => {
      headers = (init as any).headers; return new Response(JSON.stringify({ text: "ok", citations: [] }));
    }, "org_acme1");
    await client.ask("lee@acme.test", "q");
    expect(headers["x-broppy-org"]).toBe("org_acme1");
  });
  it("reports an unmapped Slack user as not linked", async () => {
    const client = new BroppyClient("https://api.test", "s".repeat(32), async () => new Response("{}", { status: 401 }));
    await expect(client.ask("x@x.test", "q")).rejects.toBeInstanceOf(NotLinkedError);
  });
  it("creates and comments through the service routes, treating 409 as not connected", async () => {
    const seen: string[] = [];
    const client = new BroppyClient("https://api.test", "s".repeat(32), async url => {
      seen.push(String(url));
      return String(url).endsWith("/issue") ? new Response(JSON.stringify({ key: "DB-9", url: "https://j/DB-9" }), { status: 201 }) : new Response("{}", { status: 409 });
    });
    expect(await client.createIssue("m@x.test", { project: "DB", summary: "s", description: "d" })).toEqual({ key: "DB-9", url: "https://j/DB-9" });
    expect(await client.comment("m@x.test", "DB-9", "t")).toBe(false);
    expect(seen).toEqual(["https://api.test/v1/service/jira/issue", "https://api.test/v1/service/jira/comment"]);
  });
  it("classifies an API refusal as retryable, and anything else as an unknown outcome", async () => {
    const client = new BroppyClient("https://api.test", "s".repeat(32), async () => new Response(JSON.stringify({ error: "Jira refused this task" }), { status: 400 }));
    await expect(client.createIssue("m@x.test", { project: "DB", summary: "s", description: "d" })).rejects.toBeInstanceOf(JiraRefusedError);
    const unknown = new BroppyClient("https://api.test", "s".repeat(32), async () => new Response("{}", { status: 502 }));
    await expect(unknown.createIssue("m@x.test", { project: "DB", summary: "s", description: "d" }))
      .rejects.toThrow("Broppy Jira issue failed (502)");
  });
  it("resolves active actors and reads a minimal issue observation through authorized service routes", async () => {
    const seen: any[] = [];
    const client = new BroppyClient("https://api.test", "s".repeat(32), async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(String(url).endsWith("/actor") ? { active: true } : { key: "DB-9", url: "https://j/DB-9", statusCategory: "done", providerVersion: "2026-10-05T12:00:00Z", operationMarker: "marker" }));
    });
    expect(await client.actor("maya@x.test")).toEqual({ active: true });
    expect(await client.issueAccess("maya@x.test", "DB-9")).toEqual({ key: "DB-9", url: "https://j/DB-9", statusCategory: "done", providerVersion: "2026-10-05T12:00:00Z", operationMarker: "marker" });
    expect(seen).toEqual([{ url: "https://api.test/v1/service/actor", body: {} }, { url: "https://api.test/v1/service/jira/access", body: { key: "DB-9" } }]);
  });
});
