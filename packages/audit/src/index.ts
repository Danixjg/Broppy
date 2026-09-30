import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { appendFileSync, existsSync, openSync, readFileSync, closeSync, fsyncSync } from "node:fs";
import type { AuditEntry, MerkleBatch, MerkleProof } from "@brain/types";

const GENESIS = "0".repeat(64);
const HASH = /^[0-9a-f]{64}$/;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pair(left: string, right: string): string {
  return digest(`${left}:${right}`);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)]));
  return value;
}

function entryHash(entry: AuditEntry): string {
  return digest(JSON.stringify({
    ...(entry.hashVersion ? { hashVersion: entry.hashVersion } : {}),
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    type: entry.type,
    actor: entry.actor,
    data: entry.hashVersion === 2 ? canonical(entry.data) : entry.data,
    previousHash: entry.previousHash
  }));
}

export interface SignedMerkleBatch extends MerkleBatch {
  signature?: string;
}

export interface AuditProof extends MerkleProof {
  sequence: number;
  firstSequence: number;
  lastSequence: number;
  entry: AuditEntry;
}

export interface AuditStore {
  load(): { entries: AuditEntry[]; batches: SignedMerkleBatch[] };
  appendEntry(entry: AuditEntry): void;
  appendBatch(batch: SignedMerkleBatch): void;
}

/** One JSON record per line. Appends are flushed before they become visible in the log. */
export class FileAuditStore implements AuditStore {
  constructor(private readonly path: string) {}

  load(): { entries: AuditEntry[]; batches: SignedMerkleBatch[] } {
    const entries: AuditEntry[] = [];
    const batches: SignedMerkleBatch[] = [];
    if (!existsSync(this.path)) return { entries, batches };
    const content = readFileSync(this.path, "utf8");
    if (!content) return { entries, batches };
    if (content && !content.endsWith("\n")) throw new Error("Incomplete audit record");
    let nextSequence = 1;
    let nextBatchSequence = 1;
    for (const line of content.slice(0, -1).split("\n")) {
      if (!line) throw new Error("Invalid audit record");
      let record: { kind: string; value: unknown };
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error("Invalid audit record");
      }
      if (record?.kind === "entry") {
        const entry = record.value as AuditEntry;
        if (entry?.sequence !== nextSequence++) throw new Error("Invalid audit record order");
        entries.push(entry);
      } else if (record?.kind === "batch") {
        const batch = record.value as SignedMerkleBatch;
        if (batch?.firstSequence !== nextBatchSequence || batch.lastSequence >= nextSequence) {
          throw new Error("Invalid audit record order");
        }
        nextBatchSequence = batch.lastSequence + 1;
        batches.push(batch);
      } else throw new Error("Invalid audit record");
    }
    return { entries, batches };
  }

  appendEntry(entry: AuditEntry): void {
    this.write({ kind: "entry", value: entry });
  }

  appendBatch(batch: SignedMerkleBatch): void {
    this.write({ kind: "batch", value: batch });
  }

  private write(record: unknown): void {
    const fd = openSync(this.path, "a");
    try {
      appendFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export interface AuditLogOptions {
  store?: AuditStore;
  signingKey?: KeyObject | string | Buffer;
  verificationKey?: KeyObject | string | Buffer;
  initial?: { entries: AuditEntry[]; batches: SignedMerkleBatch[] };
  persist?: (kind: "entry" | "batch", value: AuditEntry | SignedMerkleBatch) => Promise<void>;
  orgId?: string;
}

function batchPayload(batch: MerkleBatch): Buffer {
  return Buffer.from(JSON.stringify({
    firstSequence: batch.firstSequence,
    lastSequence: batch.lastSequence,
    root: batch.root,
    ...(batch.previousRoot !== undefined ? { previousRoot: batch.previousRoot } : {}),
    sealedAt: batch.sealedAt
  }));
}

export class AuditLog {
  private readonly storedEntries: AuditEntry[];
  private readonly storedBatches: SignedMerkleBatch[];
  private readonly store?: AuditStore;
  private readonly signingKey?: KeyObject | string | Buffer;
  private readonly verificationKey?: KeyObject | string | Buffer;

  private pending: Array<{ kind: "entry" | "batch"; value: AuditEntry | SignedMerkleBatch }> = [];
  private flushing?: Promise<void>;

  async flush(): Promise<void> {
    if (this.flushing) { await this.flushing; return this.flush(); }
    this.flushing = (async () => {
      while (this.pending.length) {
        const record = this.pending[0];
        await this.options.persist?.(record.kind, record.value);
        this.pending.shift();
      }
    })();
    try { await this.flushing; } finally { this.flushing = undefined; }
  }

  constructor(private readonly options: AuditLogOptions = {}) {
    this.store = options.store;
    this.signingKey = options.signingKey;
    this.verificationKey = options.verificationKey ?? (options.signingKey ? createPublicKey(options.signingKey) : undefined);
    const loaded = options.initial ?? options.store?.load() ?? { entries: [], batches: [] };
    this.storedEntries = structuredClone(loaded.entries);
    this.storedBatches = structuredClone(loaded.batches);
    if (!this.verifyChain() || !this.verifyBatches()) throw new Error("Invalid stored audit log");
  }

  get entries(): AuditEntry[] {
    return structuredClone(this.storedEntries);
  }

  get batches(): SignedMerkleBatch[] {
    return structuredClone(this.storedBatches);
  }

  append(type: string, actor: string, data: Record<string, unknown>): AuditEntry {
    const previousHash = this.storedEntries.at(-1)?.hash ?? GENESIS;
    const entry: AuditEntry = {
      hashVersion: 2,
      sequence: this.storedEntries.length + 1,
      timestamp: new Date().toISOString(),
      type,
      actor,
      data: structuredClone({ ...data, ...(this.options.orgId ? { orgId: this.options.orgId } : {}) }),
      previousHash,
      hash: ""
    };
    entry.hash = entryHash(entry);
    this.store?.appendEntry(entry);
    this.storedEntries.push(entry);
    if (this.options.persist) this.pending.push({ kind: "entry", value: structuredClone(entry) });
    return structuredClone(entry);
  }

  verifyChain(): boolean {
    let previousHash = GENESIS;
    try {
      for (let i = 0; i < this.storedEntries.length; i++) {
        const entry = this.storedEntries[i];
        if (!entry || entry.sequence !== i + 1 || entry.previousHash !== previousHash ||
          !HASH.test(entry.hash) || entry.hash !== entryHash(entry)) return false;
        previousHash = entry.hash;
      }
    } catch {
      return false;
    }
    return true;
  }

  verifyBatches(): boolean {
    let nextSequence = 1;
    let previousRoot = GENESIS;
    for (const batch of this.storedBatches) {
      if (!batch || batch.firstSequence !== nextSequence ||
        !Number.isSafeInteger(batch.lastSequence) || batch.lastSequence < nextSequence ||
        batch.lastSequence > this.storedEntries.length || !HASH.test(batch.root)) return false;
      if (batch.previousRoot !== undefined && batch.previousRoot !== previousRoot) return false;
      previousRoot = batch.root;
      const leaves = this.storedEntries.slice(nextSequence - 1, batch.lastSequence).map(entry => entry.hash);
      if (AuditLog.root(leaves) !== batch.root) return false;
      if (this.verificationKey && !AuditLog.verifyBatchSignature(batch, this.verificationKey)) return false;
      nextSequence = batch.lastSequence + 1;
    }
    return true;
  }

  seal(): SignedMerkleBatch | undefined {
    if (!this.verifyChain() || !this.verifyBatches()) throw new Error("Invalid audit log");
    const firstSequence = (this.storedBatches.at(-1)?.lastSequence ?? 0) + 1;
    if (firstSequence > this.storedEntries.length) return undefined;
    if (this.verificationKey && !this.signingKey) throw new Error("Signing key required to seal");
    const leaves = this.storedEntries.slice(firstSequence - 1).map(entry => entry.hash);
    const batch: SignedMerkleBatch = {
      firstSequence,
      previousRoot: this.storedBatches.at(-1)?.root ?? GENESIS,
      lastSequence: this.storedEntries.length,
      root: AuditLog.root(leaves),
      sealedAt: new Date().toISOString()
    };
    if (this.signingKey) batch.signature = sign(null, batchPayload(batch), this.signingKey).toString("hex");
    this.store?.appendBatch(batch);
    this.storedBatches.push(batch);
    if (this.options.persist) this.pending.push({ kind: "batch", value: structuredClone(batch) });
    return structuredClone(batch);
  }

  proof(sequence: number): AuditProof | undefined {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
    if (!this.verifyChain() || !this.verifyBatches()) throw new Error("Invalid audit log");
    const batch = this.storedBatches.find(item => sequence >= item.firstSequence && sequence <= item.lastSequence);
    if (!batch) return undefined;
    let level = this.storedEntries.slice(batch.firstSequence - 1, batch.lastSequence).map(entry => entry.hash);
    let index = sequence - batch.firstSequence;
    const siblings: MerkleProof["siblings"] = [];
    while (level.length > 1) {
      const siblingIndex = index ^ 1;
      siblings.push({
        hash: level[siblingIndex] ?? level[index],
        position: siblingIndex < index ? "left" : "right"
      });
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1] ?? level[i]));
      level = next;
      index = Math.floor(index / 2);
    }
    return {
      sequence,
      firstSequence: batch.firstSequence,
      lastSequence: batch.lastSequence,
      entry: structuredClone(this.storedEntries[sequence - 1]),
      leaf: this.storedEntries[sequence - 1].hash,
      root: batch.root,
      siblings
    };
  }

  static root(leaves: string[]): string {
    if (!leaves.length) throw new Error("Empty Merkle batch");
    let level = leaves;
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1] ?? level[i]));
      level = next;
    }
    return level[0];
  }

  static verifyBatchSignature(batch: SignedMerkleBatch, verificationKey: KeyObject | string | Buffer): boolean {
    if (!batch || !HASH.test(batch.root) || !Number.isSafeInteger(batch.firstSequence) ||
      !Number.isSafeInteger(batch.lastSequence) || batch.firstSequence < 1 ||
      batch.lastSequence < batch.firstSequence || typeof batch.sealedAt !== "string" ||
      typeof batch.signature !== "string" || !/^(?:[0-9a-f]{2})+$/.test(batch.signature)) return false;
    try {
      return verify(null, batchPayload(batch), verificationKey, Buffer.from(batch.signature, "hex"));
    } catch {
      return false;
    }
  }

  static verifyProof(proof: MerkleProof, trusted: string | MerkleBatch): boolean {
    const item = proof as AuditProof;
    const trustedRoot = typeof trusted === "string" ? trusted : trusted?.root;
    if (!item || !HASH.test(trustedRoot) || item.root !== trustedRoot || !HASH.test(item.leaf) ||
      (typeof trusted !== "string" && (!trusted || item.firstSequence !== trusted.firstSequence ||
        item.lastSequence !== trusted.lastSequence)) ||
      !Number.isSafeInteger(item.sequence) || !Number.isSafeInteger(item.firstSequence) ||
      !Number.isSafeInteger(item.lastSequence) || item.firstSequence < 1 ||
      item.sequence < item.firstSequence || item.sequence > item.lastSequence ||
      !item.entry || item.entry.sequence !== item.sequence || item.entry.hash !== item.leaf ||
      !HASH.test(item.entry.previousHash) ||
      !Array.isArray(item.siblings)) return false;
    try {
      if (entryHash(item.entry) !== item.leaf) return false;
    } catch {
      return false;
    }

    let current = item.leaf;
    let index = item.sequence - item.firstSequence;
    let width = item.lastSequence - item.firstSequence + 1;
    let depth = 0;
    while (width > 1) {
      const sibling = item.siblings[depth++];
      if (!sibling || !HASH.test(sibling.hash) ||
        sibling.position !== (index % 2 ? "left" : "right")) return false;
      if (index % 2 === 0 && index + 1 === width && sibling.hash !== current) return false;
      current = sibling.position === "left" ? pair(sibling.hash, current) : pair(current, sibling.hash);
      index = Math.floor(index / 2);
      width = Math.ceil(width / 2);
    }
    return depth === item.siblings.length && current === trustedRoot;
  }
}
