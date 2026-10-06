import { core, NativeIndex } from "@brain/rust-core";
import type { Citation, IndexedDocument, QueryAnswer, SearchCandidate, SourceChunk, SourceDocument } from "@brain/types";
import { checkAnswer } from "./grounding.js";
export { SupabaseIndex } from "./supabase.js";
export { checkAnswer, NO_RESULT, type CheckReport } from "./grounding.js";

// Persisted hashes use JavaScript JSON bytes, including its numeric-key and float formatting.
function serialized(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (!item || typeof item !== "object") return item;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, sort(record[key])]));
  };
  return JSON.stringify(sort(value));
}

export const hash = (value: unknown): string => core("retrieval.hash", { serialized: serialized(value) });
export const terms = (text: string): string[] => core("retrieval.terms", { text });
export const queryTerms = (text: string): string[] => core("retrieval.queryTerms", { text });
export interface Concept { terms: string[]; generic: boolean }
export const queryConcepts = (text: string): Concept[] => core("retrieval.queryConcepts", { text });
export const distinctiveWords = (text: string): string[] => core("retrieval.distinctiveWords", { text });
export const embed = (text: string): Record<string, number> => core("retrieval.embed", { text });
export const chunk = (doc: SourceDocument): SourceChunk[] => core("retrieval.chunk", doc);
export const SEMANTIC_MIN = 0.51;

export interface SemanticEmbeddingClient {
  embed(text: string): Promise<number[]>;
  available?(): boolean;
}

class DocumentView implements ReadonlyMap<string, IndexedDocument> {
  readonly [Symbol.toStringTag] = "Map";
  constructor(private readonly index: NativeIndex) {}
  get size(): number { return this.index.execute("size"); }
  get(key: string): IndexedDocument | undefined { return this.index.execute<IndexedDocument | null>("get", key) ?? undefined; }
  has(key: string): boolean { return this.get(key) !== undefined; }
  private snapshot(): Map<string, IndexedDocument> {
    return new Map(this.index.execute<IndexedDocument[]>("values").map(doc => [doc.docId, doc]));
  }
  entries() { return this.snapshot().entries(); }
  keys() { return this.snapshot().keys(); }
  values() { return this.snapshot().values(); }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback: (value: IndexedDocument, key: string, map: ReadonlyMap<string, IndexedDocument>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}

export class HybridIndex {
  private readonly index = new NativeIndex();
  readonly documents: ReadonlyMap<string, IndexedDocument> = new DocumentView(this.index);
  get embeddingRefreshes(): number { return this.index.execute("embeddingRefreshes"); }
  restore(documents: IndexedDocument[]): void { this.index.execute("restore", documents); }
  remove(docId: string): boolean { return this.index.execute("remove", docId); }
  updateLinks(docId: string, links: string[]): void {
    const doc = this.documents.get(docId);
    if (!doc) throw new Error("Unknown document");
    this.upsert({ ...doc, links });
  }
  semanticSnapshot(): Array<[string, Array<[string, number[]]>]> { return this.index.execute("semanticSnapshot"); }
  restoreSemantic(snapshot: Array<[string, Array<[string, number[]]>]>): void { this.index.execute("restoreSemantic", snapshot); }
  upsert(doc: SourceDocument): { contentChanged: boolean; permissionChanged: boolean } {
    return this.index.execute("upsert", { doc, now: new Date().toISOString(), serialized: {
      content: serialized(doc.slackMessages ? { content: doc.content, messages: doc.slackMessages } : doc.content), permission: serialized(doc.permissions), metadata: serialized({
        title: doc.title, url: doc.url, metadata: doc.metadata, version: doc.version, links: doc.links ?? []
      })
    } });
  }
  tombstone(docId: string): boolean { return this.index.execute("tombstone", { docId, now: new Date().toISOString() }); }
  semanticCount(docId: string): number { return this.index.execute("semanticCount", docId); }
  semanticVectorsFor(docId: string): Map<string, number[]> { return new Map(this.index.execute("semanticVectorsFor", docId)); }
  async refreshSemantic(docId: string, client: SemanticEmbeddingClient): Promise<boolean> {
    const generation = this.index.execute<number | null>("generation", docId);
    const doc = this.documents.get(docId);
    if (!doc || generation === null) return false;
    const vectors: Array<[string, number[]]> = [];
    try {
      for (const item of doc.chunks) {
        const vector = await client.embed(`${doc.title} ${item.text}`);
        if (!core<boolean>("retrieval.validVector", vector)) return false;
        vectors.push([item.chunkId, [...vector]]);
      }
    } catch { return false; }
    return this.index.execute("setSemantic", { docId, generation, vectors });
  }
  search(query: string, limit = 20, queryVector?: number[]): SearchCandidate[] {
    return this.index.execute("search", { query, limit, vector: queryVector, now: Date.now() });
  }
  searchAsync(query: string, limit = 20, queryVector?: number[]): Promise<SearchCandidate[]> {
    return this.index.search({ query, limit, vector: queryVector, now: Date.now() });
  }
}

export interface LlmClient {
  generate(context: Array<{ citation: string; text: string }>, question: string): Promise<string>;
}

export class LocalGroundedLlm implements LlmClient {
  async generate(context: Array<{ citation: string; text: string }>, question: string): Promise<string> {
    return core("retrieval.generate", { context, question });
  }
}

export function groundedOutput(output: string, allowed: Map<string, Citation>, evidence: Map<string, string>): QueryAnswer {
  return checkAnswer(output, allowed, evidence).answer;
}
