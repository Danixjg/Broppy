import { createHash } from "node:crypto";
import type { Citation, IndexedDocument, QueryAnswer, SearchCandidate, SourceChunk, SourceDocument } from "@brain/types";
import { checkAnswer } from "./grounding.js";
export { SupabaseIndex } from "./supabase.js";
export { checkAnswer, NO_RESULT, type CheckReport } from "./grounding.js";

/** Object keys are sorted first, so a copy whose keys came back reordered hashes the same: Postgres jsonb, which holds
 * the saved state, returns keys shortest first. Without this, every document read as a permission change after a
 * restart. */
export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortedKeys(value))).digest("hex");
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, sortedKeys(record[key])]));
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

// Words that name no topic: every project's items are full of them. They never make a hit on their own, count a
// quarter as much as other words, and don't count toward a hit's coverage of the question.
const GENERIC = new Set([
  "status", "update", "updates", "project", "projects", "plan", "plans", "team", "teams", "issue", "issues", "task",
  "tasks", "ticket", "tickets", "raised", "need", "needs", "note", "notes", "progress", "work", "item", "items", "page",
  "pages", "doc", "docs", "document", "documents", "file", "files", "channel", "channels", "thread", "threads", "new",
  "first", "read", "help", "info"
]);
const GENERIC_WEIGHT = 0.25;

/** One word of a question with its synonyms, so a word counts once however many forms it has. */
export interface Concept { terms: string[]; generic: boolean }

/** A question's words after the stopwords, each with its synonyms; words that share a form are one concept. */
export function queryConcepts(text: string): Concept[] {
  const concepts: Concept[] = [];
  for (const word of text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    const forms = [word, ...(Object.hasOwn(synonyms, word) ? synonyms[word] : [])];
    const same = concepts.find(concept => forms.some(form => concept.terms.includes(form)));
    if (same) {
      same.terms = [...new Set([...same.terms, ...forms])];
      same.generic &&= GENERIC.has(word);
    } else concepts.push({ terms: forms, generic: GENERIC.has(word) });
  }
  return concepts;
}

/** The distinctive words of a text: no stopwords, generic words or single characters, and no synonyms added. */
export function distinctiveWords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .filter(word => word.length > 1 && !STOPWORDS.has(word) && !GENERIC.has(word)))];
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
    const concepts = queryConcepts(query);
    // A hit must match a word that names the topic; generic words do only when the question has nothing else.
    const gate = concepts.some(concept => !concept.generic) ? concepts.filter(concept => !concept.generic) : concepts;
    const weight = (concept: Concept) => concept.generic ? GENERIC_WEIGHT : 1;
    const totalWeight = concepts.reduce((sum, concept) => sum + weight(concept), 0);
    const sparseQueryVector: Record<string, number> = {};
    for (const concept of concepts) {
      for (const term of concept.terms) sparseQueryVector[term] = Math.max(sparseQueryVector[term] ?? 0, weight(concept));
    }
    const semanticQueryVector = validSemanticVector(queryVector) ? queryVector : undefined;
    const results: SearchCandidate[] = [];
    for (const doc of this.documents.values()) {
      if (doc.deletedAt) continue;
      for (const item of doc.chunks) {
        // Chunk terms include the title, so whole-word matching covers both.
        const matched = concepts.filter(concept => concept.terms.some(term => mentions(item.embedding, term)));
        const keyword = totalWeight ? matched.reduce((sum, concept) => sum + weight(concept), 0) / totalWeight : 0;
        const semanticVector = semanticQueryVector ? this.semanticVectors.get(doc.docId)?.get(item.chunkId) : undefined;
        const semantic = semanticQueryVector && semanticVector
          ? semanticCosine(semanticQueryVector, semanticVector)
          : undefined;
        // Relevant means a shared topic word, or strong semantic similarity.
        if (!matched.some(concept => gate.includes(concept)) && (semantic === undefined || semantic < SEMANTIC_MIN)) continue;
        const vector = semantic ?? cosine(sparseQueryVector, item.embedding);
        const ageDays = Math.max(0, (Date.now() - Date.parse(doc.updatedAt)) / 86_400_000);
        const freshness = 1 / (1 + ageDays / 30);
        results.push({
          docId: doc.docId,
          chunkId: item.chunkId,
          score: 0.65 * vector + 0.25 * keyword + 0.10 * freshness,
          coverage: matched.filter(concept => !concept.generic).length,
          ...(semantic === undefined ? {} : { semantic })
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

/** The checked answer: only the lines of a writer's reply that the passages it cites back (see grounding.ts). */
export function groundedOutput(
  output: string,
  allowed: Map<string, Citation>,
  evidence: Map<string, string>
): QueryAnswer {
  return checkAnswer(output, allowed, evidence).answer;
}
