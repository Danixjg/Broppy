import { expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { AuditLog } from "@brain/audit";
import { Brain } from "./brain.js";
import type { Persistence } from "./persistence.js";
it("restores the index, checkpoints, narrowed grants and changed mock ACLs", async () => {
  let snapshot: any;
  const persistence = { loadState: async () => structuredClone(snapshot), saveState: async (value: unknown) => { snapshot = structuredClone(value); } } as Persistence;
  const brain = new Brain(undefined, { persistence }); await brain.syncAll();
  await brain.narrowTier(brain.user("maya")!, "drive:steering-deck", "internal");
  await brain.removeSlackMember(brain.user("maya")!, "slack:payments-cutover", "ravi");
  await brain.persist();
  const restored = new Brain(undefined, { persistence }); await restored.restore();
  expect(restored.index.documents.size).toBe(brain.index.documents.size);
  expect(restored.fga.check(restored.user("alex")!, "drive:steering-deck").allowed).toBe(false);
  await restored.syncAll();
  expect(await restored.connectors.slack.checkAccess(restored.user("ravi")!, "slack:payments-cutover")).toBe(false);
  expect(restored.fga.check(restored.user("alex")!, "drive:steering-deck").allowed).toBe(false);
});
it("retries failed audit writes and verifies JSONB key ordering and previous signed roots", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  let fail = true; const saved: unknown[] = [];
  const log = new AuditLog({ signingKey: privateKey, persist: async (_kind, record) => {
    if (fail) throw new Error("offline"); saved.push(record);
  } });
  log.append("query_received", "ravi", { z: 1, a: { y: 2, b: 3 } }); log.seal();
  await expect(log.flush()).rejects.toThrow("offline");
  fail = false; await log.flush(); expect(saved).toHaveLength(2);
  log.append("answer_returned", "ravi", { answer: "Hello" }); const batch = log.seal()!;
  expect(batch.previousRoot).toBe(log.batches[0].root);
  const entries = log.entries; entries[0].data = { a: { b: 3, y: 2 }, z: 1 };
  expect(new AuditLog({ signingKey: privateKey, initial: { entries, batches: log.batches } }).verifyChain()).toBe(true);
  const batches = log.batches; batches[1].previousRoot = "f".repeat(64);
  expect(() => new AuditLog({ signingKey: privateKey, initial: { entries, batches } })).toThrow("Invalid stored audit");
});
