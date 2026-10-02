import { describe, expect, it, vi } from "vitest";
import { nativeAllows } from "./index.js";
import { LiveConnector } from "./live.js";
import type { Source, User } from "@brain/types";

const user: User = { id: "ravi", name: "Ravi", email: "ravi@example.test", auth0Sub: "auth0|ravi",
  groups: [], role: "member", platformIdentities: {
    slack: "ravi@example.test", jira: "ravi@example.test",
    confluence: "ravi@example.test", drive: "ravi@example.test"
  } };

const ids = { slack: "C123", jira: "PAY-101", confluence: "42", drive: "file-1" };

function provider(source: Source) {
  let allowed = true;
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const delegated = new Headers(init?.headers).get("authorization") === "Bearer user";
    if (delegated && !allowed) return new Response("", { status: 403 });
    if (source === "slack") return Response.json(url.pathname.endsWith("info")
      ? { ok: true, channel: { name: "payments", created: 1700000000, context_team_id: "T123" } }
      : { ok: true, messages: [{ text: "Cutover requires approval.", ts: "1700000001.000000" }] });
    if (source === "jira") return Response.json({ fields: {
      summary: "PAY-101", description: { content: [{ text: "Cutover requires approval." }] },
      updated: "2026-09-26T11:00:00.000Z", status: { name: "Open" }
    } });
    if (source === "confluence") return Response.json({ title: "Cutover page",
      body: { storage: { value: "<p>Cutover requires approval.</p>" } },
      version: { createdAt: "2026-09-26T11:00:00.000Z" }, status: "current" });
    if (url.searchParams.has("fields")) return Response.json({ name: "Cutover file",
      mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-26T11:00:00.000Z",
      webViewLink: "https://drive.google.com/file/d/file-1/view" });
    return new Response("Cutover requires approval.", { headers: { "content-type": "text/plain" } });
  });
  const connector = new LiveConnector(source, { ids: [ids[source]],
    baseUrl: "https://atlassian.example.test/", serviceAuthorization: "Bearer service",
    userAuthorizations: { ravi: "Bearer user" } }, [user], transport as typeof fetch);
  return { connector, transport, revoke: () => { allowed = false; } };
}

describe("live source adapters", () => {
  for (const source of ["slack", "jira", "confluence", "drive"] as const) {
    it(`${source} ingests live text, reads delegated permissions, and denies a revocation`, async () => {
      const { connector, transport, revoke } = provider(source);
      const doc = await connector.fetchDocument(`${source}:${ids[source]}`);
      expect(doc?.content).toContain("Cutover requires approval.");
      expect(doc?.permissions.users).toEqual([user.email]);
      expect(nativeAllows(user, doc!.permissions)).toBe(true);
      expect(await connector.checkAccess(user, doc!.docId)).toBe(true);
      revoke();
      expect(await connector.checkAccess(user, doc!.docId)).toBe(false);
      expect((await connector.fetchPermissions(doc!.docId))?.users).toEqual([]);
      expect(transport).toHaveBeenCalled();
    });
  }
});

it("discovers all Slack pages and imports every history page and thread reply", async () => {
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("list")) return Response.json({ ok: true, channels: [{ id: url.searchParams.get("cursor") ? "C2" : "C1" }], response_metadata: { next_cursor: url.searchParams.get("cursor") ? "" : "next" } });
    if (url.pathname.endsWith("info")) return Response.json({ ok: true, channel: { name: "archive", created: 1700000000 } });
    if (url.pathname.endsWith("replies")) return Response.json({ ok: true, messages: [{ ts: "1700000002", text: "Thread decision" }] });
    return Response.json({ ok: true, messages: url.searchParams.get("cursor") ? [{ ts: "1700000000", text: "Older history" }] : [{ ts: "1700000001", text: "Recent history", reply_count: 1 }], response_metadata: { next_cursor: url.searchParams.get("cursor") ? "" : "older" } });
  });
  const connector = new LiveConnector("slack", { ids: [], discover: true, serviceAuthorization: "Bearer service", userAuthorizations: { ravi: "Bearer user" } }, [user], transport);
  expect(await connector.discover()).toEqual(["slack:C1", "slack:C2"]);
  const doc = await connector.fetchDocument("slack:C1");
  expect(doc?.content).toContain("Older history"); expect(doc?.content).toContain("Thread decision");
});

it("collects links from what each live source already returns, with no extra requests", async () => {
  const responses: Record<"slack" | "jira" | "confluence", (url: URL) => unknown> = {
    slack: url => url.pathname.endsWith("info")
      ? { ok: true, channel: { name: "payments", created: 1700000000, context_team_id: "T123" } }
      : { ok: true, messages: [{ text: "<https://atlassian.example.test/browse/SEC-44|the drill> needs sign-off.", ts: "1700000001.000000" }] },
    jira: () => ({ fields: {
      summary: "Payment cutover", updated: "2026-09-26T11:00:00.000Z", status: { name: "Open" }, project: { key: "PAY" },
      issuelinks: [{ outwardIssue: { key: "SEC-44" } }, { inwardIssue: { key: "SETL-27" } }],
      description: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Read the cutover plan.",
          marks: [{ type: "link", attrs: { href: "https://drive.google.com/file/d/file-1/view" } }] }] },
        { type: "paragraph", content: [{ type: "inlineCard", attrs: { url: "https://acme.slack.com/archives/C123/p1700000001000000" } }] }
      ] }
    } }),
    confluence: () => ({ title: "Cutover page", status: "current", version: { createdAt: "2026-09-26T11:00:00.000Z" },
      labels: { results: [{ name: "master" }, { name: "payments" }] },
      body: { storage: { value: '<p>Read <a href="https://drive.google.com/file/d/file-1/view">the plan</a> first.</p>' +
        '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PAY-101</ac:parameter></ac:structured-macro>' } } })
  };
  const expected = {
    slack: ["jira:SEC-44"],
    jira: ["drive:file-1", "jira:SEC-44", "jira:SETL-27", "slack:C123"],
    confluence: ["drive:file-1", "jira:PAY-101"]
  };
  for (const source of ["slack", "jira", "confluence"] as const) {
    const requests: URL[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      return Response.json(responses[source](url));
    });
    const connector = new LiveConnector(source, { ids: [ids[source]], baseUrl: "https://atlassian.example.test/",
      serviceAuthorization: "Bearer service", userAuthorizations: { ravi: "Bearer user" } }, [user], transport as typeof fetch);
    const doc = await connector.fetchDocument(`${source}:${ids[source]}`);
    expect(doc?.links, source).toEqual(expected[source]);
    if (source === "jira") {
      expect(requests.every(url => url.searchParams.get("fields")?.split(",").includes("issuelinks"))).toBe(true);
    }
    if (source === "confluence") {
      expect(doc?.metadata.label).toBe("master");
      expect(doc?.content).not.toContain("<");
      expect(requests.every(url => url.searchParams.get("include-labels") === "true")).toBe(true);
    }
  }
});

it("still imports an item whose optional link or label fields are malformed", async () => {
  const bodies = {
    jira: { fields: { summary: "Payment cutover", updated: "2026-09-26T11:00:00.000Z", status: { name: "Open" },
      issuelinks: ["oops", { outwardIssue: "nope" }, { inwardIssue: { key: "not a key" } }],
      description: { content: [{ type: "text", text: "Cutover requires approval.", marks: ["bad", { type: "link", attrs: [] }] }] } } },
    confluence: { title: "Cutover page", status: "current", version: { createdAt: "2026-09-26T11:00:00.000Z" }, labels: ["master"],
      body: { storage: { value: "<p>Cutover requires approval.</p>" } } }
  };
  for (const source of ["jira", "confluence"] as const) {
    const transport = vi.fn(async () => Response.json(bodies[source]));
    const connector = new LiveConnector(source, { ids: [ids[source]], baseUrl: "https://atlassian.example.test/",
      serviceAuthorization: "Bearer service", userAuthorizations: { ravi: "Bearer user" } }, [user], transport as typeof fetch);
    const doc = await connector.fetchDocument(`${source}:${ids[source]}`);
    expect(doc?.content, source).toContain("Cutover requires approval.");
    expect(doc?.links, source).toEqual([]);
    expect(doc?.metadata.label, source).toBeUndefined();
  }
});
