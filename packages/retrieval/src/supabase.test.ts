import { afterEach, describe, expect, it, vi } from "vitest";
import type { IndexedDocument } from "@brain/types";
import { SupabaseIndex } from "./supabase.js";

const vector = (): number[] => [1, ...Array(1023).fill(0)];

function indexed(): IndexedDocument {
  return {
    docId: "drive:one",
    source: "drive",
    sourceNativeId: "one",
    title: "Cutover plan",
    content: "Move traffic in stages.",
    url: "https://example.test/one",
    version: 2,
    updatedAt: "2026-09-28T00:00:00.000Z",
    metadata: { owner: "alice" },
    permissions: { users: ["alice"], groups: [], public: false },
    tier: "internal",
    contentHash: "content-hash",
    permissionHash: "permission-hash",
    metadataHash: "metadata-hash",
    lastIndexedAt: "2026-09-28T01:00:00.000Z",
    lastPermissionSyncAt: "2026-09-28T02:00:00.000Z",
    chunks: [{ chunkId: "drive:one:0", docId: "drive:one", text: "Move traffic in stages.", embedding: {} }]
  };
}

function configured(): SupabaseIndex {
  vi.stubEnv("SUPABASE_URL", "https://project.supabase.co/");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
  return SupabaseIndex.fromEnv()!;
}

function mockFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("SupabaseIndex REST adapter", () => {
  it("is optional only when both server credentials are absent", () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    expect(SupabaseIndex.fromEnv()).toBeNull();
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
    expect(() => SupabaseIndex.fromEnv()).toThrow("both SUPABASE_URL and SUPABASE_SECRET_KEY");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    vi.stubEnv("SUPABASE_URL", "http://project.supabase.co");
    expect(() => SupabaseIndex.fromEnv()).toThrow("HTTPS project URL");
  });

  it("upserts document then replaces chunks with 1024-dimensional embeddings on content change", async () => {
    const fetchMock = mockFetch(new Response(null, { status: 201 }), new Response(null, { status: 204 }),
      new Response(null, { status: 201 }));
    const index = configured();
    await index.syncDocument(indexed(), new Map([["drive:one:0", vector()]]), true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [documentUrl, documentRequest] = fetchMock.mock.calls[0];
    expect(documentUrl).toBe("https://project.supabase.co/rest/v1/source_documents?on_conflict=doc_id");
    expect(documentRequest?.method).toBe("POST");
    expect(documentRequest?.headers).toMatchObject({
      apikey: "sb_secret_test",
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    });
    expect(JSON.parse(documentRequest?.body as string)).toMatchObject({
      doc_id: "demo-company-a/drive:one", source_native_id: "one", metadata: { owner: "alice" },
      permissions: { users: ["alice"] }, deleted_at: null, last_permission_sync_at: "2026-09-28T02:00:00.000Z"
    });
    expect(fetchMock.mock.calls[1][0]).toBe("https://project.supabase.co/rest/v1/source_chunks?doc_id=eq.demo-company-a%2Fdrive%3Aone");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
    expect(fetchMock.mock.calls[2][0]).toBe("https://project.supabase.co/rest/v1/source_chunks?on_conflict=chunk_id");
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string)).toEqual([{
      org_id: "demo-company-a", chunk_id: "demo-company-a/drive:one:0", doc_id: "demo-company-a/drive:one", ordinal: 0,
      content: "Move traffic in stages.", embedding: vector()
    }]);
  });

  it("updates metadata and permissions without touching chunks or embeddings", async () => {
    const fetchMock = mockFetch(new Response(null, { status: 201 }));
    const changed = indexed();
    changed.metadata.owner = "bob";
    changed.permissions.users = ["bob"];
    changed.permissionHash = "new-permission-hash";
    await configured().syncDocument(changed, new Map(), false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      metadata: { owner: "bob" }, permissions: { users: ["bob"] }, permission_hash: "new-permission-hash"
    });
  });

  it("rejects invalid embeddings before writing and reports REST errors", async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ message: "constraint violation" }), { status: 400 }));
    const index = configured();
    await expect(index.syncDocument(indexed(), new Map([["drive:one:0", [1]]]), true))
      .rejects.toThrow("Invalid 1024-dimensional semantic vector");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(index.syncDocument(indexed(), new Map(), false))
      .rejects.toThrow("Supabase POST source_documents failed (HTTP 400): constraint violation");
  });

  it("tombstones by document ID and detects a missing row", async () => {
    const fetchMock = mockFetch(
      Response.json([{ doc_id: "demo-company-a/drive:one" }]), Response.json([])
    );
    const index = configured();
    await index.tombstone("drive:one", "2026-09-29T00:00:00.000Z");
    expect(fetchMock.mock.calls[0][0]).toBe("https://project.supabase.co/rest/v1/source_documents?doc_id=eq.demo-company-a%2Fdrive%3Aone&select=doc_id");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ deleted_at: "2026-09-29T00:00:00.000Z" });
    await expect(index.tombstone("missing", "2026-09-29T00:00:00.000Z"))
      .rejects.toThrow("found no document");
  });

  it("calls the search RPC with named arguments and maps candidate rows", async () => {
    const fetchMock = mockFetch(Response.json([
      { doc_id: "demo-company-a/drive:one", chunk_id: "demo-company-a/drive:one:0", score: 0.72 }
    ]));
    const index = configured();
    expect(await index.search("PAY-101 cutover", vector(), 5)).toEqual([
      { docId: "drive:one", chunkId: "drive:one:0", score: 0.72 }
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://project.supabase.co/rest/v1/rpc/hybrid_search");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      organization: "demo-company-a", query_text: "PAY-101 cutover", query_embedding: vector(), match_count: 5
    });
  });

  it("rejects malformed search inputs and responses", async () => {
    const fetchMock = mockFetch(Response.json([{ doc_id: "doc", score: "0.7" }]));
    const index = configured();
    await expect(index.search("query", [1], 5)).rejects.toThrow("1024-dimensional");
    await expect(index.search("query", vector(), 0)).rejects.toThrow("positive integer");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(index.search("query", vector(), 5)).rejects.toThrow("invalid candidates");
  });
});
