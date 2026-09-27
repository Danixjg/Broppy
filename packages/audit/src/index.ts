import { createHash } from "node:crypto";
import type { AuditEntry, MerkleBatch, MerkleProof } from "@brain/types";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pair(left: string, right: string): string {
  return digest(`${left}:${right}`);
}

export class AuditLog {
  readonly entries: AuditEntry[] = [];
  readonly batches: MerkleBatch[] = [];

  append(type: string, actor: string, data: Record<string, unknown>): AuditEntry {
    const previousHash = this.entries.at(-1)?.hash ?? "0".repeat(64);
    const entry: AuditEntry = {
      sequence: this.entries.length + 1,
      timestamp: new Date().toISOString(),
      type,
      actor,
      data: structuredClone(data),
      previousHash,
      hash: ""
    };
    entry.hash = digest(JSON.stringify({
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      type: entry.type,
      actor: entry.actor,
      data: entry.data,
      previousHash
    }));
    this.entries.push(entry);
    return structuredClone(entry);
  }

  verifyChain(): boolean {
    let previousHash = "0".repeat(64);
    for (const entry of this.entries) {
      if (entry.previousHash !== previousHash) return false;
      const expected = digest(JSON.stringify({
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        type: entry.type,
        actor: entry.actor,
        data: entry.data,
        previousHash
      }));
      if (entry.hash !== expected) return false;
      previousHash = expected;
    }
    return true;
  }

  seal(): MerkleBatch | undefined {
    const firstSequence = (this.batches.at(-1)?.lastSequence ?? 0) + 1;
    if (firstSequence > this.entries.length) return undefined;
    const leaves = this.entries.slice(firstSequence - 1).map(entry => entry.hash);
    const batch: MerkleBatch = {
      firstSequence,
      lastSequence: this.entries.length,
      root: AuditLog.root(leaves),
      sealedAt: new Date().toISOString()
    };
    this.batches.push(batch);
    return structuredClone(batch);
  }

  proof(sequence: number): MerkleProof | undefined {
    const batch = this.batches.find(item => sequence >= item.firstSequence && sequence <= item.lastSequence);
    if (!batch) return undefined;
    let level = this.entries.slice(batch.firstSequence - 1, batch.lastSequence).map(entry => entry.hash);
    let index = sequence - batch.firstSequence;
    const siblings: MerkleProof["siblings"] = [];
    while (level.length > 1) {
      const siblingIndex = index ^ 1;
      siblings.push({
        hash: level[siblingIndex] ?? level[index],
        position: siblingIndex < index ? "left" : "right"
      });
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(pair(level[i], level[i + 1] ?? level[i]));
      }
      level = next;
      index = Math.floor(index / 2);
    }
    return {
      leaf: this.entries[sequence - 1].hash,
      root: batch.root,
      siblings
    };
  }

  static root(leaves: string[]): string {
    if (!leaves.length) throw new Error("Empty Merkle batch");
    let level = leaves;
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(pair(level[i], level[i + 1] ?? level[i]));
      }
      level = next;
    }
    return level[0];
  }

  static verifyProof(proof: MerkleProof, trustedRoot: string): boolean {
    let current = proof.leaf;
    for (const sibling of proof.siblings) {
      current = sibling.position === "left"
        ? pair(sibling.hash, current)
        : pair(current, sibling.hash);
    }
    return current === trustedRoot && proof.root === trustedRoot;
  }
}
