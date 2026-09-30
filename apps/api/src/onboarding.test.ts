import { expect, it } from "vitest";
import { Brain } from "./brain.js";
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
