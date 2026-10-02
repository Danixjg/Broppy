import { describe, expect, it } from "vitest";
import fgaTuples from "../../../data/mock/fga-tuples.json" with { type: "json" };
import { loadMockCorpus, nativeAllows } from "./index.js";

describe("Stage 1 mock corpus", () => {
  it("loads six linked identities and every planned source item", async () => {
    const { users, connectors } = loadMockCorpus();
    expect(users.map(user => user.name)).toEqual(["Ravi", "Maya", "Alex", "David", "Nur", "Wei Ming"]);
    for (const user of users) {
      expect(user.auth0Sub).toBeTruthy();
      for (const source of ["slack", "jira", "confluence", "drive"] as const) {
        expect(user.platformIdentities?.[source]).toBe(user.email);
      }
      for (const group of user.groups) {
        expect(fgaTuples).toContainEqual({ user: `user:${user.email}`, relation: "member", object: `group:${group}` });
      }
    }

    const ids = (await Promise.all(Object.values(connectors).map(connector => connector.listIds()))).flat();
    expect(ids).toEqual(expect.arrayContaining([
      "slack:payments-cutover", "slack:fraud-private", "jira:PAY-101", "jira:SETL-27",
      "jira:SEC-44", "confluence:payment-master", "confluence:q3-incident",
      "drive:cutover-plan", "drive:cutover-duplicate", "drive:recon-sheet",
      "drive:steering-deck", "drive:api-spec",
      "jira:DB-12", "jira:DB-15", "slack:db-migration", "slack:db-oncall", "slack:db-planning",
      "confluence:db-migration-plan", "confluence:payment-service-runbook", "drive:runbook-2025",
      "drive:db-wave-checklist", "drive:api-spec-copy"
    ]));
    expect(ids).toHaveLength(26);
    for (const connector of Object.values(connectors)) {
      for (const doc of await connector.listItems()) {
        expect(doc.content).toBeTruthy();
        expect(Object.keys(doc.metadata).length).toBeGreaterThan(0);
        expect(doc.version).toBeGreaterThan(0);
        expect(doc.url).toMatch(/^https:\/\//);
        expect(doc.permissions.native?.source).toBe(connector.source);
        expect(await connector.fetchContent(doc.docId)).toBe(doc.content);
        expect(await connector.fetchVersion(doc.docId)).toBe(doc.version);
        expect(await connector.getPermissions(doc.docId)).toEqual(doc.permissions);
        for (const group of doc.permissions.groups) {
          expect(fgaTuples).toContainEqual({
            user: `group:${group}#member`, relation: "group_reader", object: `document:${doc.docId}`
          });
        }
        for (const email of doc.permissions.users) {
          expect(fgaTuples).toContainEqual({
            user: `user:${email}`, relation: "direct_reader", object: `document:${doc.docId}`
          });
        }
      }
    }
  });

  it("links items the way their sources do, and marks each project's master page", async () => {
    const { connectors } = loadMockCorpus();
    const docs = (await Promise.all(Object.values(connectors).map(connector => connector.listItems()))).flat();
    const ids = new Set(docs.map(doc => doc.docId));
    // Every link a fixture declares points at a fixture.
    for (const doc of docs) for (const target of doc.links ?? []) expect(ids, `${doc.docId} → ${target}`).toContain(target);
    expect(docs.filter(doc => doc.metadata.label === "master").map(doc => doc.docId).sort())
      .toEqual(["confluence:db-migration-plan", "confluence:payment-master"]);

    // A fetched item carries its declared links plus the issue keys in its text.
    const issue = await connectors.jira.fetchDocument("jira:DB-12");
    expect(issue?.links).toEqual(expect.arrayContaining(["confluence:db-migration-plan", "drive:db-wave-checklist",
      "jira:DB-15", "slack:db-migration"]));
    expect(issue?.links).not.toContain("jira:DB-12");
    expect((await connectors.jira.fetchDocument("jira:DB-15"))?.links).toContain("slack:db-oncall");
    expect((await connectors.slack.fetchDocument("slack:db-migration"))?.content)
      .toContain("Agreed: Maya raises the replica storage quota before the final wave.");
  });

  it("dates the fixtures relative to now, keeping their spacing", async () => {
    const at = async (now: string) => {
      const { connectors } = loadMockCorpus(new Date(now));
      return new Map((await Promise.all(Object.values(connectors).map(connector => connector.listItems()))).flat()
        .map(doc => [doc.docId, Date.parse(doc.updatedAt)]));
    };
    const written = await at("2026-09-30T00:00:00.000Z");
    const later = await at("2026-10-16T00:30:00.000Z");
    expect(written.get("slack:db-migration")).toBe(Date.parse("2026-09-27T02:00:00.000Z"));
    for (const [docId, time] of later) expect(time - written.get(docId)!).toBe(16 * 86_400_000);
    expect(Math.max(...later.values())).toBeLessThan(Date.parse("2026-10-16T00:00:00.000Z"));
  });

  it("intersects brain grants with each platform's native restriction", async () => {
    const { users, connectors } = loadMockCorpus();
    const user = (id: string) => users.find(candidate => candidate.id === id)!;
    expect(await connectors.slack.checkAccess(user("ravi"), "slack:fraud-private")).toBe(true);
    expect(await connectors.slack.checkAccess(user("maya"), "slack:fraud-private")).toBe(false);
    expect(await connectors.jira.checkAccess(user("ravi"), "jira:SETL-27")).toBe(true);
    expect(await connectors.jira.checkAccess(user("alex"), "jira:SETL-27")).toBe(false);
    expect(await connectors.confluence.checkAccess(user("nur"), "confluence:q3-incident")).toBe(true);
    expect(await connectors.confluence.checkAccess(user("ravi"), "confluence:q3-incident")).toBe(false);
    expect(await connectors.drive.checkAccess(user("maya"), "drive:cutover-plan")).toBe(true);
    expect(await connectors.drive.checkAccess(user("wei"), "drive:cutover-plan")).toBe(false);

    const payment = (await connectors.jira.getPermissions("jira:PAY-101"))!;
    expect(nativeAllows(user("ravi"), { ...payment, users: [], groups: [], public: false })).toBe(false);
    expect(nativeAllows(user("ravi"), { ...payment, native: undefined })).toBe(false);
    expect(nativeAllows({ ...user("ravi"), platformIdentities: undefined }, payment)).toBe(false);
    const native = payment.native!;
    if (native.source !== "jira") throw new Error("Expected Jira restriction");
    expect(nativeAllows(user("maya"), {
      ...payment,
      native: { ...native, issueViewers: ["ravi@aspire.example"] }
    })).toBe(false);
  });

  it("applies native permission changes without changing content and reports changes", async () => {
    const { users, connectors } = loadMockCorpus();
    const ravi = users.find(user => user.id === "ravi")!;
    const connector = connectors.jira;
    const id = "jira:SETL-27";
    const initial = await connector.listUpdatedSince(0);
    const before = (await connector.fetchDocument(id))!;
    const changes: string[] = [];
    const unsubscribe = connector.subscribeToChanges(change => changes.push(change.kind));
    expect(before.permissions.native?.source).toBe("jira");
    const native = before.permissions.native!;
    if (native.source !== "jira") throw new Error("Expected Jira restriction");
    connector.updatePermissions(id, {
      ...before.permissions,
      native: { ...native, issueViewers: native.issueViewers!.filter(email => email !== ravi.email) }
    });
    expect(await connector.checkAccess(ravi, id)).toBe(false);
    expect(await connector.fetchContent(id)).toBe(before.content);
    expect(await connector.fetchVersion(id)).toBe(before.version);
    expect((await connector.listUpdatedSince(initial.cursor)).ids).toEqual([id]);
    expect(changes).toEqual(["permission"]);
    const narrowed = (await connector.getPermissions(id))!;
    expect(() => connector.updatePermissions(id, before.permissions)).toThrow("narrow");
    connector.updatePermissions(id, { ...narrowed, groups: [] });
    expect(await connector.checkAccess(ravi, id)).toBe(false);
    connector.updateContent(id, "Updated SETL reconciliation instructions.");
    expect(await connector.fetchVersion(id)).toBe(before.version + 1);
    expect(await connector.fetchContent(id)).toContain("Updated SETL");
    connector.delete(id);
    expect(await connector.fetchDocument(id)).toBeUndefined();
    expect(await connector.getPermissions(id)).toBeUndefined();
    expect(await connector.checkAccess(ravi, id)).toBe(false);
    expect(await connector.listIds()).not.toContain(id);
    unsubscribe();
    expect(changes).toEqual(["permission", "permission", "content", "deletion"]);
  });

  it("revokes each other platform's native access while its brain group still grants", async () => {
    const { users, connectors } = loadMockCorpus();
    const ravi = users.find(user => user.id === "ravi")!;
    const cases = [
      [connectors.slack, "slack:payments-cutover"],
      [connectors.confluence, "confluence:payment-master"],
      [connectors.drive, "drive:cutover-plan"]
    ] as const;
    for (const [connector, id] of cases) {
      const permission = (await connector.getPermissions(id))!;
      expect(await connector.checkAccess(ravi, id)).toBe(true);
      const native = permission.native!;
      switch (native.source) {
        case "slack":
          connector.updatePermissions(id, {
            ...permission,
            native: { ...native, members: native.members.filter(email => email !== ravi.email) }
          });
          break;
        case "confluence":
          connector.updatePermissions(id, {
            ...permission,
            native: { ...native, pageViewers: native.pageViewers?.filter(email => email !== ravi.email) }
          });
          break;
        case "drive":
          connector.updatePermissions(id, {
            ...permission,
            native: { ...native, sharedUsers: native.sharedUsers.filter(email => email !== ravi.email) }
          });
          break;
        default:
          throw new Error("Unexpected native permission source");
      }
      expect((await connector.getPermissions(id))?.groups).toContain("payments");
      expect(await connector.checkAccess(ravi, id)).toBe(false);
    }
  });
});

it("allows contractors only on an explicit grant with native membership", async () => {
  const { users, connectors } = loadMockCorpus();
  const wei = users.find(user => user.id === "wei")!;
  const doc = (await connectors.slack.listItems())[0];
  const native = { source: "slack" as const, channelId: "vendor", visibility: "public" as const, members: [wei.email] };
  expect(nativeAllows(wei, { users: [], groups: [], public: true, native })).toBe(false);
  expect(nativeAllows(wei, { users: [wei.email], groups: [], public: false, native })).toBe(true);
  expect(nativeAllows(wei, { users: [wei.email], groups: [], public: false, native: { ...native, members: [] } })).toBe(false);
});
