import { describe, expect, it, vi } from "vitest";
import { loadMockCorpus } from "@brain/connectors";
import { LiveConnector } from "@brain/connectors/live";
import type { User } from "@brain/types";
import { Brain } from "./brain.js";

const person = (id: string, extra: Partial<User> = {}): User => ({ id, name: id, email: `${id}@example.test`, auth0Sub: `auth0|${id}`, groups: [], role: "member", active: true,
  platformIdentities: { slack: `${id}@example.test`, jira: `${id}@example.test`, confluence: `${id}@example.test`, drive: `${id}@example.test` }, ...extra });

/** A live Jira whose source lets everyone with an Atlassian account see the issue, read with a shared connection. */
function setup() {
  const fixture = loadMockCorpus();
  const users: User[] = [person("maya")];
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("user/permission/search")) return Response.json([{ accountId: url.searchParams.get("accountId") }]);
    return Response.json({ fields: { summary: "PAY-101 Cutover", description: { content: [{ text: "Cutover requires approval." }] },
      updated: "2026-10-05T09:00:00.000Z", status: { name: "Open" }, project: { key: "PAY" } } });
  });
  const jira = new LiveConnector("jira", { ids: ["PAY-101"], baseUrl: "https://atlassian.example.test/", serviceAuthorization: "", userAuthorizations: {},
    authorization: async () => "Bearer shared", atlassianAccountId: async email => `acct-${email}` }, users, transport as unknown as typeof fetch, async () => undefined);
  const brain = new Brain(undefined, { users, connectors: { ...fixture.connectors, jira } });
  return { brain, users };
}

describe("a person who was not known at the last permission pass", () => {
  it("is not shown the item until their access is read", async () => {
    const { brain, users } = setup();
    await brain.syncAll();
    const wei = person("wei"); users.push(wei);
    expect(brain.fga.check(wei, "jira:PAY-101").allowed).toBe(false);
  });

  it("is shown it as soon as their own access is read", async () => {
    const { brain, users } = setup();
    await brain.syncAll();
    const wei = person("wei", { platformIdentities: { slack: "wei@example.test", jira: "wei@contractor.test", confluence: "wei@example.test", drive: "wei@example.test" } });
    users.push(wei);
    const result = await brain.refreshAccessFor(wei);
    expect(result.added).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(brain.fga.check(wei, "jira:PAY-101").allowed).toBe(true);
    expect(brain.index.documents.get("jira:PAY-101")?.permissions.native).toMatchObject({ projectViewers: expect.arrayContaining(["maya@example.test", "wei@contractor.test"]) });
    expect((await brain.visibleDocuments(wei)).some(doc => doc.docId === "jira:PAY-101")).toBe(true);
    expect(brain.audit.entries.some(entry => entry.type === "access_refreshed" && entry.actor === "wei")).toBe(true);
  });

  it("does not add someone the source refuses, and does not touch anyone's existing access", async () => {
    const { brain, users } = setup();
    await brain.syncAll();
    const nobody = person("nobody", { platformIdentities: { slack: "", jira: "", confluence: "", drive: "" } as User["platformIdentities"] });
    users.push(nobody);
    const before = structuredClone(brain.index.documents.get("jira:PAY-101")!.permissions);
    expect((await brain.refreshAccessFor(nobody)).added).toBe(0);
    expect(brain.index.documents.get("jira:PAY-101")!.permissions).toEqual(before);
    expect(brain.fga.check(users[0], "jira:PAY-101").allowed).toBe(true);
  });

  it("also comes in when the admin reads every item's permissions again, carrying on from where a limited read stopped", async () => {
    const { brain, users } = setup();
    await brain.syncAll();
    const wei = person("wei"); users.push(wei);
    const first = await brain.refreshAllAccess(users[0], 25_000, 0);
    expect(first.remaining).toBe(0);
    expect(brain.fga.check(wei, "jira:PAY-101").allowed).toBe(true);
    const stopped = await brain.refreshAllAccess(users[0], -1, 0);
    expect(stopped.remaining).toBeGreaterThan(0);
    expect(stopped.next).toBe(0);
    expect((await brain.refreshAllAccess(users[0], 25_000, stopped.next)).remaining).toBe(0);
  });
});
