import { describe, expect, it, vi } from "vitest";
import { loadMockCorpus } from "@brain/connectors";
import { LiveConnector } from "@brain/connectors/live";
import { Brain } from "./brain.js";

describe("source resilience", () => {
  function liveJira() {
    const fixture = loadMockCorpus();
    const ravi = fixture.users.find(user => user.id === "ravi")!;
    let delegatedStatus = 200;
    let updated = "2026-10-05T09:00:00.000Z";
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get("authorization") === "Bearer user" && delegatedStatus !== 200) {
        return new Response("", { status: delegatedStatus });
      }
      return Response.json({ fields: { summary: "PAY-101 Cutover", description: { content: [{ text: "Cutover requires approval." }] },
        updated, status: { name: "Open" }, project: { key: "PAY" } } });
    });
    const jira = new LiveConnector("jira", { ids: ["PAY-101"], baseUrl: "https://atlassian.example.test/",
      serviceAuthorization: "Bearer service", userAuthorizations: { ravi: "Bearer user" } }, fixture.users, transport, async () => undefined);
    const brain = new Brain(undefined, { users: fixture.users, connectors: { ...fixture.connectors, jira } });
    return { brain, ravi, fail: (status: number) => { delegatedStatus = status; updated = "2026-10-05T10:00:00.000Z"; },
      recover: () => { delegatedStatus = 200; } };
  }

  for (const status of [429, 500]) {
    it(`preserves confirmed records and grants during a delegated ${status}, and retries the pending item`, async () => {
      const { brain, ravi, fail, recover } = liveJira();
      await brain.syncAll();
      const permissions = structuredClone(brain.index.documents.get("jira:PAY-101")!.permissions);
      fail(status);
      await expect(brain.sync("jira")).rejects.toThrow();
      expect(brain.index.documents.get("jira:PAY-101")?.deletedAt).toBeUndefined();
      expect(brain.index.documents.get("jira:PAY-101")?.permissions).toEqual(permissions);
      expect(brain.runs.get("jira")?.pendingIds).toContain("jira:PAY-101");
      expect((await brain.visibleDocuments(ravi)).some(doc => doc.docId === "jira:PAY-101")).toBe(false);
      expect(brain.index.documents.get("jira:PAY-101")?.permissions).toEqual(permissions);
      recover();
      await brain.sync("jira");
      expect((await brain.visibleDocuments(ravi)).some(doc => doc.docId === "jira:PAY-101")).toBe(true);
    });
  }

  it("still removes access after a confirmed source revocation", async () => {
    const { brain, ravi, fail } = liveJira();
    await brain.syncAll();
    fail(403);
    expect((await brain.visibleDocuments(ravi)).some(doc => doc.docId === "jira:PAY-101")).toBe(false);
    expect(brain.fga.check(ravi, "jira:PAY-101").allowed).toBe(false);
  });

  it("syncs healthy sources before reporting another source's failure", async () => {
    const brain = new Brain();
    vi.spyOn(brain.connectors.slack, "discover").mockRejectedValue(new Error("Slack unavailable"));
    await expect(brain.syncAll()).rejects.toThrow("Source synchronization failed");
    expect(brain.index.documents.has("jira:PAY-101")).toBe(true);
    expect(brain.states.get("jira")?.lastSuccessfulSyncAt).toBeDefined();
    expect(brain.connections.get("slack")?.status).toBe("Error");
  });
});
