import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { appendFileSync, existsSync, openSync, readFileSync, closeSync, fsyncSync } from "node:fs";
import type { AuditEntry, MerkleBatch, MerkleProof } from "@brain/types";
import { core } from "@brain/rust-core";

const GENESIS = "0".repeat(64);
const HASH = /^[0-9a-f]{64}$/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)]));
  return value;
}

// Existing signatures and hashes require Node's locale ordering and JSON byte representation.
function entryPayload(entry: AuditEntry): string {
  return JSON.stringify({
    ...(entry.hashVersion ? { hashVersion: entry.hashVersion } : {}),
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    type: entry.type,
    actor: entry.actor,
    data: entry.hashVersion === 2 ? canonical(entry.data) : entry.data,
    previousHash: entry.previousHash
  });
}

function entryHash(entry: AuditEntry): string {
  return core<string>("audit.digest", { payload: entryPayload(entry) });
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
    return core("audit.parseRecords", { content: readFileSync(this.path, "utf8") });
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
    if (!this.verifyChain()) throw new Error(`Invalid stored audit log: entry ${this.firstBrokenSequence()} does not match its hash chain`);
    if (!this.verifyBatches()) throw new Error("Invalid stored audit log: a sealed batch does not verify");
  }

  /** The sequence number of the first entry that breaks the chain, or undefined when the chain is intact. */
  firstBrokenSequence(): number | undefined {
    const payloads = this.storedEntries.map(entry => {
      try { return entryPayload(entry); } catch { return null; }
    });
    const entries = this.storedEntries.map(entry => ({
      sequence: typeof entry?.sequence === "number" ? entry.sequence : null,
      previousHash: typeof entry?.previousHash === "string" ? entry.previousHash : null,
      hash: typeof entry?.hash === "string" ? entry.hash : null
    }));
    return core<number | null>("audit.firstBroken", { entries, payloads }) ?? undefined;
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
    try { return this.firstBrokenSequence() === undefined; } catch { return false; }
  }

  verifyBatches(): boolean {
    return core<boolean>("audit.verifyBatches", {
      entries: this.storedEntries.map(entry => ({ hash: entry.hash })), batches: this.storedBatches
    }) &&
      (!this.verificationKey || this.storedBatches.every(batch => AuditLog.verifyBatchSignature(batch, this.verificationKey!)));
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
    const proof = core<AuditProof | null>("audit.proof", {
      entries: this.storedEntries.map(entry => ({ hash: entry.hash })), batches: this.storedBatches, sequence
    });
    return proof ? { ...proof, entry: structuredClone(this.storedEntries[sequence - 1]) } : undefined;
  }

  static root(leaves: string[]): string {
    return core<string>("audit.root", { leaves });
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
    try {
      return core<boolean>("audit.verifyProof", {
        proof, trusted, payload: entryPayload((proof as AuditProof).entry)
      });
    } catch {
      return false;
    }
  }
}
