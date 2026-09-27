import { createHash } from "node:crypto";
import type { Citation, IndexedDocument, QueryAnswer, SearchCandidate, SourceChunk, SourceDocument } from "@brain/types";

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
    const contentChanged = !previous || previous.contentHash !== contentHash;
    const permissionChanged = !previous || previous.permissionHash !== permissionHash;
    const now = new Date().toISOString();
    const chunks = contentChanged ? chunk(source) : previous.chunks;
    if (contentChanged) this.embeddingRefreshes += 1;
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
    this.documents.set(docId, {
      ...doc,
      deletedAt: new Date().toISOString(),
      chunks: []
    });
    return true;
  }

  search(query: string, limit = 20): SearchCandidate[] {
    const queryTerms = terms(query);
    const queryVector = embed(query);
    const results: SearchCandidate[] = [];
    for (const doc of this.documents.values()) {
      if (doc.deletedAt) continue;
      for (const item of doc.chunks) {
        const haystack = `${doc.title} ${item.text}`.toLowerCase();
        const keyword = queryTerms.length
          ? queryTerms.filter(term => haystack.includes(term)).length / queryTerms.length
          : 0;
        const vector = cosine(queryVector, item.embedding);
        if (keyword === 0 && vector === 0) continue;
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
      .map(item => `${item.text.replace(/\s+/g, " ").trim()} [${item.citation}]`)
      .join("\n");
  }
}

export const NO_RESULT = "No accessible information was found for this query.";

export function groundedOutput(output: string, allowed: Map<string, Citation>): QueryAnswer {
  const lines = output.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const kept: string[] = [];
  const citations = new Map<string, Citation>();
  for (const line of lines) {
    const allMarkers = [...line.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
    const cited = allMarkers.filter(id => allowed.has(id));
    if (!cited.length || cited.length !== allMarkers.length) continue;
    const claims = line.replace(/\[[^\]]+\]/g, "").split(/(?<=[.!?])\s+/).filter(Boolean);
    if (claims.length > 1) continue;
    kept.push(line);
    for (const id of cited) citations.set(id, allowed.get(id)!);
  }
  return {
    text: kept.join("\n") || NO_RESULT,
    citations: [...citations.values()]
  };
}
