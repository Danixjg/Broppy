import { createHash } from "node:crypto";
import type { Citation, IndexedDocument, QueryAnswer, SearchCandidate, SourceChunk, SourceDocument } from "@brain/types";
export { SupabaseIndex } from "./supabase.js";

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const synonyms: Record<string, string[]> = {
  switch: ["cutover", "migration"],
  recovery: ["failover", "rollback"],
  outage: ["incident", "failover"],
  launch: ["cutover"],
  access: ["permission"],
  payment: ["pay", "payments"]
};

export function terms(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  return raw.flatMap(term => [term, ...(synonyms[term] ?? [])]);
}

export function embed(text: string): Record<string, number> {
  const vector: Record<string, number> = {};
  for (const term of terms(text)) vector[term] = (vector[term] ?? 0) + 1;
  return vector;
}

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const [term, value] of Object.entries(a)) {
    aNorm += value * value;
    dot += value * (b[term] ?? 0);
  }
  for (const value of Object.values(b)) bNorm += value * value;
  return aNorm && bNorm ? dot / Math.sqrt(aNorm * bNorm) : 0;
}

const SEMANTIC_DIMENSIONS = 1024;

export interface SemanticEmbeddingClient {
  embed(text: string): Promise<number[]>;
}

function validSemanticVector(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== SEMANTIC_DIMENSIONS) return false;
  let squaredNorm = 0;
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) return false;
    squaredNorm += component * component;
  }
  return Number.isFinite(squaredNorm) && squaredNorm > 0;
}

function semanticCosine(a: number[], b: number[]): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < SEMANTIC_DIMENSIONS; index++) {
    dot += a[index] * b[index];
    aNorm += a[index] * a[index];
    bNorm += b[index] * b[index];
  }
  const score = dot / Math.sqrt(aNorm * bNorm);
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
}

export function chunk(doc: SourceDocument): SourceChunk[] {
  const paragraphs = doc.content.match(/[\s\S]{1,900}(?:\s|$)/g) ?? [doc.content];
  return paragraphs.map((text, index) => ({
    chunkId: `${doc.docId}:${index}`,
    docId: doc.docId,
    text: text.trim(),
    embedding: embed(`${doc.title} ${text}`)
  }));
}

export class HybridIndex {
  readonly documents = new Map<string, IndexedDocument>();
  private readonly semanticVectors = new Map<string, Map<string, number[]>>();
  embeddingRefreshes = 0;

  upsert(source: SourceDocument): { contentChanged: boolean; permissionChanged: boolean } {
    const previous = this.documents.get(source.docId);
    const contentHash = hash(source.content);
    const permissionHash = hash(source.permissions);
    const metadataHash = hash({
      title: source.title,
      url: source.url,
      metadata: source.metadata,
      version: source.version
    });
    const contentChanged = !previous || previous.contentHash !== contentHash || previous.title !== source.title;
    const permissionChanged = !previous || previous.permissionHash !== permissionHash;
    const now = new Date().toISOString();
    const chunks = contentChanged ? chunk(source) : previous.chunks;
    if (contentChanged) this.embeddingRefreshes += 1;
    if (contentChanged) this.semanticVectors.delete(source.docId);
    this.documents.set(source.docId, {
      ...structuredClone(source),
      chunks,
      contentHash,
      permissionHash,
      metadataHash,
      deletedAt: undefined,
      lastIndexedAt: contentChanged ? now : previous.lastIndexedAt,
      lastPermissionSyncAt: permissionChanged ? now : previous.lastPermissionSyncAt
    });
    return { contentChanged, permissionChanged };
  }

  tombstone(docId: string): boolean {
    const doc = this.documents.get(docId);
    if (!doc || doc.deletedAt) return false;
    this.semanticVectors.delete(docId);
    this.documents.set(docId, {
      ...doc,
      deletedAt: new Date().toISOString(),
      chunks: []
    });
    return true;
  }

  semanticVectorsFor(docId: string): Map<string, number[]> {
    const copy = new Map<string, number[]>();
    for (const [chunkId, vector] of this.semanticVectors.get(docId) ?? []) {
      copy.set(chunkId, [...vector]);
    }
    return copy;
  }

  async refreshSemantic(docId: string, client: SemanticEmbeddingClient): Promise<boolean> {
    const doc = this.documents.get(docId);
    if (!doc || doc.deletedAt) return false;
    const vectors = new Map<string, number[]>();
    try {
      for (const item of doc.chunks) {
        const vector = await client.embed(`${doc.title} ${item.text}`);
        if (!validSemanticVector(vector)) return false;
        vectors.set(item.chunkId, [...vector]);
      }
    } catch {
      return false;
    }
    // Ignore a refresh that finished after a content update or tombstone.
    if (this.documents.get(docId)?.chunks === doc.chunks && !this.documents.get(docId)?.deletedAt) {
      this.semanticVectors.set(docId, vectors);
      return true;
    }
    return false;
  }

  search(query: string, limit = 20, queryVector?: number[]): SearchCandidate[] {
    const queryTerms = terms(query);
    const sparseQueryVector = embed(query);
    const semanticQueryVector = validSemanticVector(queryVector) ? queryVector : undefined;
    const results: SearchCandidate[] = [];
    for (const doc of this.documents.values()) {
      if (doc.deletedAt) continue;
      for (const item of doc.chunks) {
        const haystack = `${doc.title} ${item.text}`.toLowerCase();
        const keyword = queryTerms.length
          ? queryTerms.filter(term => haystack.includes(term)).length / queryTerms.length
          : 0;
        const semanticVector = semanticQueryVector ? this.semanticVectors.get(doc.docId)?.get(item.chunkId) : undefined;
        const vector = semanticQueryVector && semanticVector
          ? semanticCosine(semanticQueryVector, semanticVector)
          : cosine(sparseQueryVector, item.embedding);
        if (keyword === 0 && vector <= 0) continue;
        const ageDays = Math.max(0, (Date.now() - Date.parse(doc.updatedAt)) / 86_400_000);
        const freshness = 1 / (1 + ageDays / 30);
        results.push({
          docId: doc.docId,
          chunkId: item.chunkId,
          score: 0.65 * vector + 0.25 * keyword + 0.10 * freshness
        });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export interface LlmClient {
  generate(context: Array<{ citation: string; text: string }>, question: string): Promise<string>;
}

export class LocalGroundedLlm implements LlmClient {
  async generate(context: Array<{ citation: string; text: string }>): Promise<string> {
    return context.slice(0, 4)
      .map(item => {
        const normalized = item.text.replace(/\s+/g, " ").trim();
        const sentence = normalized.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? normalized;
        return `${sentence} [${item.citation}]`;
      })
      .join("\n");
  }
}

export const NO_RESULT = "No accessible information was found for this query.";

export function groundedOutput(
  output: string,
  allowed: Map<string, Citation>,
  evidence: Map<string, string>
): QueryAnswer {
  const lines = output.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const kept: string[] = [];
  const citations = new Map<string, Citation>();
  for (const line of lines) {
    const allMarkers = [...line.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
    const cited = allMarkers.filter(id => allowed.has(id));
    if (!cited.length || cited.length !== allMarkers.length) continue;
    const claims = line.replace(/\[[^\]]+\]/g, "").split(/(?<=[.!?])\s+/).filter(Boolean);
    if (claims.length > 1) continue;
    const claim = claims[0]?.toLowerCase().replace(/\s+/g, " ").trim();
    if (!claim || !cited.some(id => evidence.get(id)?.toLowerCase().replace(/\s+/g, " ").includes(claim))) {
      continue;
    }
    kept.push(line);
    for (const id of cited) citations.set(id, allowed.get(id)!);
  }
  return {
    text: kept.join("\n") || NO_RESULT,
    citations: [...citations.values()]
  };
}
