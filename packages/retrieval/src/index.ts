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
  payment: ["pay", "payments"],
  blockers: ["blocker"]
};

export function terms(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  return raw.flatMap(term => [term, ...(Object.hasOwn(synonyms, term) ? synonyms[term] : [])]);
}

// Words that carry no topic. Matching them made every document look relevant to every question.
const STOPWORDS = new Set([
  "about", "after", "all", "also", "an", "and", "any", "anything", "are", "as", "at", "be", "been", "before", "being",
  "both", "but", "by", "can", "could", "describe", "did", "do", "does", "each", "everything", "explain", "find", "for",
  "from", "get", "give", "had", "has", "have", "he", "her", "here", "his", "how", "if", "in", "into", "is", "it", "its",
  "just", "list", "me", "more", "most", "my", "no", "not", "of", "on", "or", "our", "out", "please", "regarding",
  "related", "she", "should", "show", "so", "some", "something", "such", "summarise", "summarize", "tell", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "up", "us", "was", "we",
  "were", "what", "when", "where", "which", "who", "whom", "why", "will", "with", "would", "you", "your",
  // Time words narrow a question; they are not its topic.
  "ago", "current", "currently", "day", "days", "last", "latest", "month", "months", "now", "past", "recent",
  "recently", "since", "today", "week", "weeks", "yesterday"
]);

/**
 * Minimum semantic cosine that makes a chunk relevant without a shared topic term. Tuned on 3 Oct with
 * `pnpm llm:calibrate` against Cloudflare's bge-m3 over the mock items: matching pairs had a 25th percentile of 0.51,
 * and non-matching ones a 95th percentile of 0.51 (highest 0.61). The earlier 0.35 let in 176 of 234 non-matching
 * pairs. Tune it again when the documents change.
 */
export const SEMANTIC_MIN = 0.51;

/** A question's topic terms: its terms without stopwords or single characters. */
export function queryTerms(text: string): string[] {
  return [...new Set(terms(text).filter(term => term.length > 1 && !STOPWORDS.has(term)))];
}

function vectorOf(list: string[]): Record<string, number> {
  const vector: Record<string, number> = {};
  for (const term of list) vector[term] = (Object.hasOwn(vector, term) ? vector[term] : 0) + 1;
  return vector;
}

export function embed(text: string): Record<string, number> {
  return vectorOf(terms(text));
}

// A hyphenated question term also matches text that has all of its parts as separate words.
function mentions(chunkTerms: Record<string, number>, term: string): boolean {
  if (Object.hasOwn(chunkTerms, term)) return true;
  const parts = term.split("-");
  return parts.length > 1 && parts.every(part => Object.hasOwn(chunkTerms, part));
}

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const [term, value] of Object.entries(a)) {
    aNorm += value * value;
    dot += value * (Object.hasOwn(b, term) ? b[term] : 0);
  }
  for (const value of Object.values(b)) bNorm += value * value;
  return aNorm && bNorm ? dot / Math.sqrt(aNorm * bNorm) : 0;
}

const SEMANTIC_DIMENSIONS = 1024;

export interface SemanticEmbeddingClient {
  embed(text: string): Promise<number[]>;
  /** False while the client can't be used, e.g. over its token budget. Absent means always available. */
  available?(): boolean;
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
    orgId: doc.orgId,
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

  semanticSnapshot(): Array<[string, Array<[string, number[]]>]> {
    return [...this.semanticVectors].map(([docId, vectors]) => [docId, [...vectors].map(([id, vector]) => [id, [...vector]])]);
  }

  restoreSemantic(snapshot: Array<[string, Array<[string, number[]]>]>): void {
    for (const [docId, vectors] of snapshot) {
      const doc = this.documents.get(docId);
      if (!doc || doc.deletedAt) continue;
      if (vectors.some(([id, vector]) => !doc.chunks.some(chunk => chunk.chunkId === id) || !validSemanticVector(vector))) throw new Error("Invalid stored vectors");
      this.semanticVectors.set(docId, new Map(vectors));
    }
  }

  upsert(source: SourceDocument): { contentChanged: boolean; permissionChanged: boolean } {
    const previous = this.documents.get(source.docId);
    const contentHash = hash(source.content);
    const permissionHash = hash(source.permissions);
    // Links travel with the metadata: a link-only change never re-chunks or re-embeds.
    const metadataHash = hash({
      title: source.title,
      url: source.url,
      metadata: source.metadata,
      version: source.version,
      links: source.links ?? []
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

  /** How many of a document's chunks have semantic vectors, without copying them. */
  semanticCount(docId: string): number {
    return this.semanticVectors.get(docId)?.size ?? 0;
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
    const topics = queryTerms(query);
    const sparseQueryVector = vectorOf(topics);
    const semanticQueryVector = validSemanticVector(queryVector) ? queryVector : undefined;
    const results: SearchCandidate[] = [];
    for (const doc of this.documents.values()) {
      if (doc.deletedAt) continue;
      for (const item of doc.chunks) {
        // Chunk terms include the title, so whole-word matching covers both.
        const keyword = topics.length
          ? topics.filter(term => mentions(item.embedding, term)).length / topics.length
          : 0;
        const semanticVector = semanticQueryVector ? this.semanticVectors.get(doc.docId)?.get(item.chunkId) : undefined;
        const semantic = semanticQueryVector && semanticVector
          ? semanticCosine(semanticQueryVector, semanticVector)
          : undefined;
        // Relevant means a shared topic term, or strong semantic similarity.
        if (keyword === 0 && (semantic === undefined || semantic < SEMANTIC_MIN)) continue;
        const vector = semantic ?? cosine(sparseQueryVector, item.embedding);
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
  async generate(context: Array<{ citation: string; text: string }>, question: string): Promise<string> {
    const topics = new Set(queryTerms(question));
    const prerequisite = /\b(need|needs|required|require|requires|before|prerequisite|depend|depends)\b/i.test(question);
    const score = (value: string) => {
      const overlap = [...new Set(terms(value))].filter(term => topics.has(term)).length;
      const required = prerequisite && /\b(before|requires?|complete|must|depends?|prerequisite)\b/i.test(value) ? 3 : 0;
      return overlap + required;
    };
    const sentences = (text: string) => text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    const [first, ...rest] = context;
    if (!first) return "";
    // The most relevant source is quoted in full, so a runbook keeps every step; the next three add their best sentence.
    const lines = sentences(first.text).slice(0, 6).map(sentence => `${sentence} [${first.citation}]`);
    for (const item of rest.slice(0, 3)) {
      const best = sentences(item.text).sort((left, right) => score(right) - score(left))[0];
      if (best) lines.push(`${best} [${item.citation}]`);
    }
    return lines.join("\n");
  }
}

export const NO_RESULT = "No accessible information was found for this query.";

// A model may copy a sentence with lookalike characters: a non-breaking hyphen, curly quotes or special spaces. Both
// sides are folded before they are compared, so those don't drop a faithful copy; the words must still match.
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

/** The source's own sentence, when the claim copies one whole, so the answer shows the source's characters. */
function sourceSentence(evidence: string | undefined, claim: string): string | undefined {
  return evidence?.split(/(?<=[.!?])\s+/).map(sentence => sentence.replace(/\s+/g, " ").trim())
    .find(sentence => fold(sentence) === claim);
}

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
    const claim = fold(claims[0] ?? "");
    if (!claim || !cited.some(id => fold(evidence.get(id) ?? "").includes(claim))) continue;
    const original = cited.map(id => sourceSentence(evidence.get(id), claim)).find(Boolean);
    kept.push(original ? `${original} ${allMarkers.map(id => `[${id}]`).join(" ")}`
      : line.normalize("NFKC").replace(/[\u2010\u2011]/g, "-"));
    for (const id of cited) citations.set(id, allowed.get(id)!);
  }
  return {
    text: kept.join("\n") || NO_RESULT,
    citations: [...citations.values()]
  };
}
