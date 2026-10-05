import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, FileAuditStore, type AuditProof, type AuditStore } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function filePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  dirs.push(dir);
  return join(dir, "audit.jsonl");
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

describe("AuditLog", () => {
  it("copies input and output, and verifies entry content and sequence on reload", () => {
    const data = { nested: { value: 1 } };
    const log = new AuditLog();
    const returned = log.append("read", "alice", data);
    data.nested.value = 2;
    (returned.data.nested as { value: number }).value = 3;
    log.entries[0].sequence = 22;
    log.entries[0].data.nested = { value: 4 };
    expect(log.entries[0].data).toEqual({ nested: { value: 1 } });
    expect(log.verifyChain()).toBe(true);

    const first = log.entries[0];
    for (const mutation of [
      (entry: typeof first) => { entry.data = { changed: true }; },
      (entry: typeof first) => { entry.sequence = 2; },
      (entry: typeof first) => { entry.previousHash = "a".repeat(64); }
    ]) {
      const bad = copy(first);
      mutation(bad);
      const store: AuditStore = {
        load: () => ({ entries: [bad], batches: [] }),
        appendEntry: () => {},
        appendBatch: () => {}
      };
      expect(() => new AuditLog({ store })).toThrow("Invalid stored audit log: entry 1 does not match");
    }
  });

  it("verifies positions, odd-leaf duplication, entry and sequence against a trusted batch", () => {
    const log = new AuditLog();
    for (let i = 0; i < 5; i++) log.append("read", "alice", { i });
    const batch = log.seal()!;
    for (let sequence = 1; sequence <= 5; sequence++) {
      const proof = log.proof(sequence)!;
      expect(AuditLog.verifyProof(proof, batch)).toBe(true);
      expect(AuditLog.verifyProof(proof, "f".repeat(64))).toBe(false);
    }
    const proof = log.proof(5)!;
    const altered: AuditProof = copy(proof);
    altered.siblings[0].hash = "f".repeat(64);
    expect(AuditLog.verifyProof(altered, batch)).toBe(false);
    altered.siblings[0].hash = proof.siblings[0].hash;
    altered.siblings[0].position = "left";
    expect(AuditLog.verifyProof(altered, batch)).toBe(false);
    altered.siblings[0].position = proof.siblings[0].position;
    altered.sequence = 4;
    expect(AuditLog.verifyProof(altered, batch)).toBe(false);
    altered.sequence = 5;
    altered.entry.data = { i: 999 };
    expect(AuditLog.verifyProof(altered, batch)).toBe(false);
    expect(AuditLog.verifyProof({ ...proof, siblings: proof.siblings.slice(1) }, batch)).toBe(false);
    expect(AuditLog.verifyProof(proof, { ...batch, firstSequence: 2 })).toBe(false);
    expect(log.proof(6)).toBeUndefined();

    const exposedBatch = log.batches[0];
    exposedBatch.root = "0".repeat(64);
    expect(log.batches[0].root).toBe(batch.root);
  });

  it("persists and authenticates signed roots across restarts, rejecting edited records", () => {
    const path = filePath();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const log = new AuditLog({ store: new FileAuditStore(path), signingKey: privateKey });
    log.append("read", "alice", { id: 1 });
    log.append("read", "bob", { id: 2 });
    const batch = log.seal()!;
    expect(AuditLog.verifyBatchSignature(batch, publicKey)).toBe(true);
    expect(AuditLog.verifyBatchSignature({ ...batch, root: "f".repeat(64) }, publicKey)).toBe(false);
    expect(AuditLog.verifyBatchSignature({ ...batch, lastSequence: 3 }, publicKey)).toBe(false);
    expect(AuditLog.verifyProof(log.proof(2)!, batch)).toBe(true);

    const reopened = new AuditLog({ store: new FileAuditStore(path), verificationKey: publicKey });
    expect(reopened.entries).toHaveLength(2);
    expect(reopened.verifyBatches()).toBe(true);
    expect(AuditLog.verifyProof(reopened.proof(1)!, reopened.batches[0])).toBe(true);
    expect(() => reopened.seal()).not.toThrow(); // no unsealed entries
    reopened.append("read", "carol", { id: 3 });
    expect(() => reopened.seal()).toThrow("Signing key required");

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const changed = JSON.parse(lines[2]);
    changed.value.sealedAt = "2020-01-01T00:00:00.000Z";
    lines[2] = JSON.stringify(changed);
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(() => new AuditLog({ store: new FileAuditStore(path), verificationKey: publicKey })).toThrow("Invalid stored audit log");
  });

  it("rejects incomplete file records and does not expose failed appends", () => {
    const path = filePath();
    writeFileSync(path, '{"kind":"entry"');
    expect(() => new AuditLog({ store: new FileAuditStore(path) })).toThrow("Incomplete audit record");
    const store: AuditStore = {
      load: () => ({ entries: [], batches: [] }),
      appendEntry: () => { throw new Error("disk full"); },
      appendBatch: () => {}
    };
    const log = new AuditLog({ store });
    expect(() => log.append("read", "alice", {})).toThrow("disk full");
    expect(log.entries).toEqual([]);
  });
});
