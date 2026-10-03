import { expect, it } from "vitest";
import { Brain } from "./brain.js";
import type { Persistence } from "./persistence.js";
it("imports scoped history and disconnect purges documents and grants", async () => {
  const brain = new Brain(); const admin = brain.user("maya")!;
  await brain.connect(admin, "drive");
  const doc = (await brain.connectors.drive.listItems())[0];
  await brain.setScope(admin, "drive", { ids: [doc.sourceNativeId] });
  await brain.startImport(admin, "drive"); await brain.sync("drive");
  expect([...brain.index.documents.values()].filter(doc => !doc.deletedAt).map(doc => doc.docId)).toEqual([doc.docId]);
  expect(brain.jobs.get("drive")).toMatchObject({ status: "complete", found: 1, indexed: 1 });
  await brain.disconnect(admin, "drive"); await brain.syncAll();
  expect([...brain.index.documents.values()].some(doc => doc.source === "drive")).toBe(false);
  expect(brain.fga.check(admin, doc.docId).allowed).toBe(false);
  expect(brain.audit.entries.some(e => e.type === "connection_removed")).toBe(true);
});
it("rejects another organisation and non-admin onboarding", async () => {
  const brain = new Brain();
  await expect(brain.startImport(brain.user("ravi")!, "slack")).rejects.toThrow("Forbidden");
  await expect(brain.query({ ...brain.user("ravi")!, orgId: "other" }, "test")).rejects.toThrow("Forbidden");
});
it("keeps scope narrowing in force after subsequent incremental sync", async () => {
  const brain = new Brain(); await brain.syncAll();
  const keep = (await brain.connectors.drive.listItems())[0];
  await brain.setScope(brain.user("maya")!, "drive", { ids: [keep.sourceNativeId] });
  await brain.sync("drive");
  expect([...brain.index.documents.values()].filter(doc => doc.source === "drive" && !doc.deletedAt).map(doc => doc.docId)).toEqual([keep.docId]);
});

const live = (brain: Brain, source: "slack" | "jira" | "confluence" | "drive") =>
  [...brain.index.documents.values()].filter(doc => doc.source === source && !doc.deletedAt);

it("imports nothing from a source connected with mode none", async () => {
  const brain = new Brain(); const admin = brain.user("maya")!;
  await brain.connect(admin, "slack", { mode: "none" });
  await brain.startImport(admin, "slack"); await brain.sync("slack");
  expect(live(brain, "slack")).toEqual([]);
  expect(brain.jobs.get("slack")).toMatchObject({ found: 0 });
});

it("select all, select and none each change what is indexed, and none removes it", async () => {
  const brain = new Brain(); const admin = brain.user("maya")!;
  await brain.connect(admin, "slack", { mode: "none" });
  await brain.setScope(admin, "slack", { mode: "all" }); await brain.sync("slack");
  const everything = live(brain, "slack").length;
  expect(everything).toBeGreaterThan(1);
  const channels = await brain.listContainers(admin, "slack");
  expect(channels.length).toBeGreaterThan(1);
  await brain.setScope(admin, "slack", { mode: "selected", containers: [channels[0].id] }); await brain.sync("slack");
  expect(live(brain, "slack").length).toBeGreaterThan(0);
  expect(live(brain, "slack").length).toBeLessThan(everything);
  await brain.setScope(admin, "slack", { mode: "selected" }); await brain.sync("slack");
  expect(live(brain, "slack")).toEqual([]);
  await brain.setScope(admin, "slack", { mode: "all" }); await brain.sync("slack");
  await brain.setScope(admin, "slack", { mode: "none" }); await brain.sync("slack");
  expect(live(brain, "slack")).toEqual([]);
  expect(brain.audit.entries.filter(entry => entry.type === "scope_changed").length).toBe(5);
});

it("future only keeps what is older than the moment it was chosen out, and keeps that moment on a re-save", async () => {
  const brain = new Brain(); const admin = brain.user("maya")!;
  await brain.connect(admin, "confluence", { mode: "none" });
  await brain.setScope(admin, "confluence", { mode: "all", futureOnly: true });
  const since = brain.connections.get("confluence")!.scope.since!;
  expect(Date.parse(since)).toBeLessThanOrEqual(Date.now());
  await brain.sync("confluence");
  expect(live(brain, "confluence")).toEqual([]);
  await brain.setScope(admin, "confluence", { mode: "all", futureOnly: true });
  expect(brain.connections.get("confluence")!.scope.since).toBe(since);
  // A page edited after that moment is picked up on the next sync.
  const page = (await brain.connectors.confluence.listItems())[0];
  (brain.connectors.confluence as import("@brain/connectors").MockConnector).updateContent(page.docId, "Edited after the company connected.");
  await brain.sync("confluence");
  expect(live(brain, "confluence").map(doc => doc.docId)).toEqual([page.docId]);
});

it("only an admin of the organisation can list or change what is included", async () => {
  const brain = new Brain();
  await expect(brain.listContainers(brain.user("ravi")!, "slack")).rejects.toThrow("Forbidden");
  await expect(brain.setScope(brain.user("ravi")!, "slack", { mode: "all" })).rejects.toThrow("Forbidden");
});

it("reconnecting a source keeps the scope the admin chose, while a new connection starts at none", async () => {
  const brain = new Brain(); const admin = brain.user("maya")!;
  brain.connections.get("jira")!.status = "Not connected";
  brain.markConnected(admin, "jira");
  expect(brain.connections.get("jira")!.scope).toEqual({ mode: "none" });
  await brain.setScope(admin, "jira", { mode: "selected", containers: ["PAY"] });
  brain.connections.get("jira")!.status = "Error";
  brain.markConnected(admin, "jira");
  expect(brain.connections.get("jira")).toMatchObject({ status: "Connected", scope: { mode: "selected", containers: ["PAY"] } });
  await brain.disconnect(admin, "jira");
  brain.markConnected(admin, "jira");
  expect(brain.connections.get("jira")!.scope).toEqual({ mode: "none" });
});

it("shows why a source is in error, keeps its documents, and clears the reason once it syncs", async () => {
  const brain = new Brain(); const admin = brain.user("maya")!;
  await brain.sync("drive");
  const before = live(brain, "drive").length;
  const connector = brain.connectors.drive;
  const discover = connector.discover.bind(connector);
  connector.discover = async () => { throw new Error("drive credential was rejected; reconnect the source"); };
  await expect(brain.sync("drive")).rejects.toThrow("reconnect");
  expect(brain.connections.get("drive")).toMatchObject({ status: "Error", error: "drive credential was rejected; reconnect the source" });
  expect(live(brain, "drive").length).toBe(before);
  connector.discover = discover;
  await brain.sync("drive");
  expect(brain.connections.get("drive")).toMatchObject({ status: "Live", error: undefined });
});

it("pressing Connect again in the demo keeps the scope already chosen", async () => {
  const brain = new Brain(); const admin = brain.user("maya")!;
  await brain.setScope(admin, "slack", { mode: "selected", containers: ["DB"] });
  await brain.connect(admin, "slack");
  expect(brain.connections.get("slack")!.scope).toEqual({ mode: "selected", containers: ["DB"] });
});
it("keeps a disconnected source's raw documents out of the saved state", async () => {
  let snapshot: { connectorDocuments?: Array<{ source: string }> } = {};
  const persistence = { loadState: async () => undefined, saveState: async (value: typeof snapshot) => { snapshot = structuredClone(value); } } as unknown as Persistence;
  const brain = new Brain(undefined, { persistence });
  await brain.syncAll(); await brain.persist();
  expect(snapshot.connectorDocuments?.some(doc => doc.source === "slack")).toBe(true);
  await brain.disconnect(brain.user("maya")!, "slack");
  expect(snapshot.connectorDocuments?.some(doc => doc.source === "slack")).toBe(false);
  expect(snapshot.connectorDocuments?.some(doc => doc.source === "jira")).toBe(true);
});
