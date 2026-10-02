import { describe, expect, it, vi } from "vitest";
import { nativeAllows } from "./index.js";
import { CredentialRejected, LiveConnector } from "./live.js";
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

describe("live connector failure handling", () => {
  const settings = { ids: ["PAY-101"], baseUrl: "https://atlassian.example.test/",
    serviceAuthorization: "Bearer service", userAuthorizations: { ravi: "Bearer user" } };
  const issue = (updated: string) => Response.json({ fields: { summary: "PAY-101",
    description: { content: [{ text: "Cutover requires approval." }] }, updated, status: { name: "Open" } } });
  const instant = async () => undefined;

  it("never reads a rejected service credential as a deleted item", async () => {
    const transport = vi.fn(async () => new Response("", { status: 401 }));
    const connector = new LiveConnector("jira", settings, [user], transport as typeof fetch, instant);
    await expect(connector.fetchDocument("jira:PAY-101")).rejects.toBeInstanceOf(CredentialRejected);
  });

  it("treats Slack's invalid_auth the same way, but channel_not_found as gone", async () => {
    const reply = (error: string) => vi.fn(async () => Response.json({ ok: false, error }));
    const slack = (error: string) => new LiveConnector("slack", { ...settings, ids: ["C1"] }, [user],
      reply(error) as typeof fetch, instant);
    await expect(slack("invalid_auth").fetchDocument("slack:C1")).rejects.toBeInstanceOf(CredentialRejected);
    expect(await slack("channel_not_found").fetchDocument("slack:C1")).toBeUndefined();
  });

  it("still reads 404 as gone, and a user's rejected credential as no access", async () => {
    const gone = new LiveConnector("jira", settings, [user],
      vi.fn(async () => new Response("", { status: 404 })) as typeof fetch, instant);
    expect(await gone.fetchDocument("jira:PAY-101")).toBeUndefined();
    const rejected = new LiveConnector("jira", settings, [user],
      vi.fn(async () => new Response("", { status: 401 })) as typeof fetch, instant);
    expect(await rejected.checkAccess(user, "jira:PAY-101")).toBe(false);
  });

  it("retries a dropped connection with backoff, then gives up", async () => {
    const waits: number[] = [];
    let calls = 0;
    const flaky = vi.fn(async () => {
      if (++calls < 3) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return issue("2026-09-26T11:00:00.000Z");
    });
    const connector = new LiveConnector("jira", settings, [], flaky as typeof fetch, async ms => { waits.push(ms); });
    expect(await connector.fetchVersion("jira:PAY-101")).toBeTypeOf("number");
    expect(waits).toEqual([250, 500]);
    const dead = new LiveConnector("jira", settings, [], vi.fn(async () => { throw new TypeError("fetch failed"); }) as typeof fetch, instant);
    await expect(dead.fetchVersion("jira:PAY-101")).rejects.toThrow("fetch failed");
  });

  it("treats Slack's ratelimited reply as a pause, never as a missing channel", async () => {
    const waits: number[] = [];
    let calls = 0;
    const slack = new LiveConnector("slack", { ...settings, ids: ["C1"] }, [user], vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("info") && ++calls < 3) return Response.json({ ok: false, error: "ratelimited" });
      return Response.json(url.pathname.endsWith("info")
        ? { ok: true, channel: { name: "payments", created: 1700000000 } }
        : { ok: true, messages: [{ text: "Cutover requires approval.", ts: "1700000001.000000" }] });
    }) as typeof fetch, async ms => { waits.push(ms); });
    expect((await slack.fetchDocument("slack:C1"))?.content).toContain("Cutover");
    expect(waits).toEqual([1000, 2000]);
    const always = new LiveConnector("slack", { ...settings, ids: ["C1"] }, [user],
      vi.fn(async () => Response.json({ ok: false, error: "ratelimited" })) as typeof fetch, instant);
    await expect(always.fetchDocument("slack:C1")).rejects.toThrow("rate limited");
    const odd = new LiveConnector("slack", { ...settings, ids: ["C1"] }, [user],
      vi.fn(async () => Response.json({ ok: false, error: "internal_error" })) as typeof fetch, instant);
    await expect(odd.fetchDocument("slack:C1")).rejects.toThrow("internal_error");
  });

  it("treats a Drive 403 rate limit as a pause, and a plain 403 as no access", async () => {
    const drive = (body: string) => new LiveConnector("drive", { ...settings, ids: ["f1"] }, [user],
      vi.fn(async () => new Response(body, { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch, instant);
    await expect(drive('{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}').fetchDocument("drive:f1")).rejects.toThrow("rate limited");
    expect(await drive('{"error":{"errors":[{"reason":"forbidden"}]}}').fetchDocument("drive:f1")).toBeUndefined();
  });

  it("does not index a trashed Drive file or a trashed Confluence page", async () => {
    const file = new LiveConnector("drive", { ...settings, ids: ["f1"] }, [user], vi.fn(async () => Response.json({
      name: "Old plan", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-26T11:00:00.000Z", trashed: true })) as typeof fetch, instant);
    expect(await file.fetchDocument("drive:f1")).toBeUndefined();
    const page = (status: string) => new LiveConnector("confluence", { ...settings, ids: ["42"] }, [user], vi.fn(async () => Response.json({
      title: "Cutover", status, body: { storage: { value: "<p>Cutover requires approval.</p>" } },
      version: { createdAt: "2026-09-26T11:00:00.000Z" } })) as typeof fetch, instant);
    expect(await page("trashed").fetchVersion("confluence:42")).toBeUndefined();
    expect(await page("current").fetchVersion("confluence:42")).toBeTypeOf("number");
  });

  it("polls only the items whose version moved", async () => {
    let updated = "2026-09-26T11:00:00.000Z";
    const connector = new LiveConnector("jira", settings, [], vi.fn(async () => issue(updated)) as typeof fetch, instant);
    const first = await connector.listUpdatedSince(0);
    expect(first.ids).toEqual(["jira:PAY-101"]);
    expect((await connector.listUpdatedSince(first.cursor)).ids).toEqual([]);
    updated = "2026-09-27T09:00:00.000Z";
    expect((await connector.listUpdatedSince(first.cursor + 1)).ids).toEqual(["jira:PAY-101"]);
  });
});

describe("live connector scope", () => {
  const base = { ids: [], discover: true, baseUrl: "https://atlassian.example.test/",
    serviceAuthorization: "Bearer service", userAuthorizations: {} };

  it("asks the provider nothing when no source is selected", async () => {
    const transport = vi.fn();
    for (const scope of [{ mode: "none" as const }, { mode: "selected" as const }]) {
      const connector = new LiveConnector("jira", base, [user], transport as unknown as typeof fetch);
      expect(await connector.discover(scope)).toEqual([]);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("lists what an admin can pick from, page by page, for each source", async () => {
    const slack = new LiveConnector("slack", base, [user], vi.fn(async (input: RequestInfo | URL) => {
      const next = new URL(String(input)).searchParams.get("cursor");
      return Response.json({ ok: true, channels: [{ id: next ? "C2" : "C1", name: next ? "ops" : "payments" }],
        response_metadata: { next_cursor: next ? "" : "p2" } });
    }) as typeof fetch);
    expect(await slack.listContainers()).toEqual([{ id: "C1", name: "payments" }, { id: "C2", name: "ops" }]);
    const jira = new LiveConnector("jira", base, [user], vi.fn(async () =>
      Response.json({ values: [{ key: "PAY", name: "Payments" }], isLast: true })) as typeof fetch);
    expect(await jira.listContainers()).toEqual([{ id: "PAY", name: "Payments" }]);
    const drive = new LiveConnector("drive", base, [user], vi.fn(async () =>
      Response.json({ drives: [{ id: "D1", name: "Finance" }] })) as typeof fetch);
    expect(await drive.listContainers()).toEqual([{ id: "D1", name: "Finance" }]);
    const confluence = new LiveConnector("confluence", base, [user], vi.fn(async () =>
      Response.json({ results: [{ id: "9", name: "Security" }], _links: {} })) as typeof fetch);
    expect(await confluence.listContainers()).toEqual([{ id: "9", name: "Security" }]);
  });
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
