import type { IndexedDocument, SearchCandidate } from "@brain/types";

const VECTOR_DIMENSIONS = 1024;

function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === VECTOR_DIMENSIONS &&
    value.every(component => typeof component === "number" && Number.isFinite(component)) &&
    value.some(component => component !== 0);
}

interface SearchRow {
  doc_id: string;
  chunk_id: string;
  score: number;
}

/** Server-side optional index. The caller keeps the local index as the source of truth. */
export class SupabaseIndex {
  private constructor(private readonly baseUrl: string, private readonly key: string, private readonly orgId = "demo-company-a") {}

  static fromEnv(): SupabaseIndex | null {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SECRET_KEY?.trim();
    if (!url && !key) return null;
    if (!url || !key) throw new Error("Supabase requires both SUPABASE_URL and SUPABASE_SECRET_KEY");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("SUPABASE_URL must be a valid HTTPS project URL");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("SUPABASE_URL must be an HTTPS project URL without a path, credentials, or query parameters");
    }
    return new SupabaseIndex(parsed.origin, key, process.env.AUTH0_ORG_ID ?? "demo-company-a");
  }

  private async request(path: string, method: string, body?: unknown, prefer?: string): Promise<unknown> {
    const label = `${method} ${path.split("?")[0]}`;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: this.key,
          "Content-Type": "application/json",
          ...(prefer ? { Prefer: prefer } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      throw new Error(`Supabase ${label} failed: network error`, { cause: error });
    }
    if (!response.ok) {
      let detail = "";
      try {
        const payload: unknown = await response.json();
        if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string") {
          detail = `: ${payload.message}`;
        }
      } catch { /* An HTTP status is enough when the body is not JSON. */ }
      throw new Error(`Supabase ${label} failed (HTTP ${response.status})${detail}`);
    }
    if (response.status === 204 || prefer?.includes("return=minimal")) return null;
    try {
      return await response.json();
    } catch {
      throw new Error(`Supabase ${label} returned invalid JSON`);
    }
  }

  async syncDocument(indexed: IndexedDocument, semanticVectors: Map<string, number[]>, contentChanged: boolean): Promise<void> {
    if (contentChanged) {
      for (const item of indexed.chunks) {
        const vector = semanticVectors.get(item.chunkId);
        if (vector !== undefined && !validVector(vector)) {
          throw new Error(`Invalid 1024-dimensional semantic vector for chunk ${item.chunkId}`);
        }
      }
    }

    await this.request("source_documents?on_conflict=doc_id", "POST", {
      org_id: this.orgId,
      doc_id: this.storedId(indexed.docId),
      source: indexed.source,
      source_native_id: indexed.sourceNativeId,
      title: indexed.title,
      content: indexed.content,
      url: indexed.url,
      version: indexed.version,
      content_hash: indexed.contentHash,
      permission_hash: indexed.permissionHash,
      metadata_hash: indexed.metadataHash,
      updated_at: indexed.updatedAt,
      deleted_at: indexed.deletedAt ?? null,
      metadata: indexed.metadata,
      permissions: indexed.permissions,
      tier: indexed.tier,
      last_indexed_at: indexed.lastIndexedAt,
      last_permission_sync_at: indexed.lastPermissionSyncAt
    }, "resolution=merge-duplicates,return=minimal");

    if (!contentChanged) return;
    const id = encodeURIComponent(`eq.${this.storedId(indexed.docId)}`);
    await this.request(`source_chunks?doc_id=${id}`, "DELETE", undefined, "return=minimal");
    if (!indexed.chunks.length) return;
    await this.request("source_chunks?on_conflict=chunk_id", "POST", indexed.chunks.map((item, ordinal) => ({
      org_id: this.orgId,
      chunk_id: this.storedId(item.chunkId),
      doc_id: this.storedId(indexed.docId),
      ordinal,
      content: item.text,
      embedding: semanticVectors.get(item.chunkId) ?? null
    })), "resolution=merge-duplicates,return=minimal");
  }

  private storedId(id: string): string { return `${encodeURIComponent(this.orgId)}/${id}`; }
  private localId(id: string): string {
    const prefix = `${encodeURIComponent(this.orgId)}/`;
    if (!id.startsWith(prefix)) throw new Error("Cross-organization search result");
    return id.slice(prefix.length);
  }
  async purge(docId: string): Promise<void> {
    await this.request(`source_documents?org_id=eq.${encodeURIComponent(this.orgId)}&doc_id=${encodeURIComponent(`eq.${this.storedId(docId)}`)}`, "DELETE", undefined, "return=minimal");
  }

  async tombstone(docId: string, deletedAt: string): Promise<void> {
    const id = encodeURIComponent(`eq.${this.storedId(docId)}`);
    const result = await this.request(`source_documents?doc_id=${id}&select=doc_id`, "PATCH",
      { deleted_at: deletedAt }, "return=representation");
    if (!Array.isArray(result) || result.length !== 1) {
      throw new Error(`Supabase tombstone found no document for ${docId}`);
    }
  }

  async search(query: string, queryVector: number[], limit: number): Promise<SearchCandidate[]> {
    if (!validVector(queryVector)) throw new Error("Supabase search requires a nonzero 1024-dimensional query vector");
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Supabase search limit must be a positive integer");
    const result = await this.request("rpc/hybrid_search", "POST", {
      organization: this.orgId,
      query_text: query,
      query_embedding: queryVector,
      match_count: limit
    });
    if (!Array.isArray(result) || !result.every((row: unknown): row is SearchRow =>
      !!row && typeof row === "object" &&
      "doc_id" in row && typeof row.doc_id === "string" &&
      "chunk_id" in row && typeof row.chunk_id === "string" &&
      "score" in row && typeof row.score === "number" && Number.isFinite(row.score))) {
      throw new Error("Supabase hybrid_search returned invalid candidates");
    }
    return result.map(row => ({ docId: this.localId(row.doc_id), chunkId: this.localId(row.chunk_id), score: row.score }));
  }
}
