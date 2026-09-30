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
