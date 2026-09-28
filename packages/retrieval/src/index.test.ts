import { describe, expect, it, vi } from "vitest";
import type { SourceDocument } from "@brain/types";
import { HybridIndex, type SemanticEmbeddingClient } from "./index.js";

const vector = (dimension: number): number[] => Array.from({ length: 1024 }, (_, index) => index === dimension ? 1 : 0);

function document(docId: string, content: string): SourceDocument {
  return {
    docId,
    source: "drive",
    sourceNativeId: docId,
    title: docId,
    content,
    url: `https://example.test/${docId}`,
    version: 1,
    updatedAt: "2100-01-01T00:00:00.000Z",
    metadata: {},
    permissions: { users: ["alice"], groups: [], public: false },
    tier: "internal"
  };
}

describe("HybridIndex semantic scoring", () => {
  it("finds and ranks related chunks using numeric cosine without lexical overlap", async () => {
    const index = new HybridIndex();
    index.upsert(document("invoices", "Reimbursement procedure"));
    index.upsert(document("shipping", "Parcel dispatch"));
    index.upsert(document("opposite", "Contrary topic"));
    expect(index.search("payment")).toEqual([]);

    const client: SemanticEmbeddingClient = {
      embed: vi.fn(async text => text.includes("invoices") ? vector(0) :
        text.includes("opposite") ? vector(0).map(value => -value) : vector(1))
    };
    expect(await index.refreshSemantic("invoices", client)).toBe(true);
    expect(await index.refreshSemantic("shipping", client)).toBe(true);
    expect(await index.refreshSemantic("opposite", client)).toBe(true);
    const results = index.search("payment", 20, vector(0));
    expect(results.map(result => result.docId)).toEqual(["invoices"]);
    expect(results[0].score).toBeCloseTo(0.75);
    expect(client.embed).toHaveBeenCalledWith("invoices Reimbursement procedure");
  });

  it("returns defensive copies of installed vectors and an empty map when absent", async () => {
    const index = new HybridIndex();
    expect(index.semanticVectorsFor("missing")).toEqual(new Map());
    index.upsert(document("doc", "Reimbursement procedure"));
    const input = vector(0);
    expect(await index.refreshSemantic("doc", { embed: async () => input })).toBe(true);
    input[0] = 7;
    const exposed = index.semanticVectorsFor("doc");
    expect(exposed.get("doc:0")).toEqual(vector(0));
    exposed.get("doc:0")![0] = 9;
    exposed.clear();
    expect(index.semanticVectorsFor("doc").get("doc:0")).toEqual(vector(0));
    index.tombstone("doc");
    expect(index.semanticVectorsFor("doc")).toEqual(new Map());
  });

  it("keeps cached vectors on permission updates and invalidates them on content, title, and deletion", async () => {
    const index = new HybridIndex();
    const client = { embed: vi.fn(async () => vector(0)) };
    const original = document("doc", "Reimbursement procedure");
    if (index.upsert(original).contentChanged) await index.refreshSemantic("doc", client);
    expect(index.search("payment", 20, vector(0))).toHaveLength(1);

    const permissionOnly = { ...original, permissions: { ...original.permissions, users: ["bob"] } };
    const update = index.upsert(permissionOnly);
    if (update.contentChanged) await index.refreshSemantic("doc", client);
    expect(update).toEqual({ contentChanged: false, permissionChanged: true });
    expect(client.embed).toHaveBeenCalledTimes(1);
    expect(index.search("payment", 20, vector(0))).toHaveLength(1);

    expect(index.upsert({ ...permissionOnly, title: "revised" }).contentChanged).toBe(true);
    expect(index.search("payment", 20, vector(0))).toEqual([]);
    await index.refreshSemantic("doc", client);
    expect(index.search("payment", 20, vector(0))).toHaveLength(1);
    expect(index.upsert({ ...permissionOnly, content: "Changed text" }).contentChanged).toBe(true);
    expect(index.search("payment", 20, vector(0))).toEqual([]);
    await index.refreshSemantic("doc", client);
    expect(index.tombstone("doc")).toBe(true);
    expect(index.search("payment", 20, vector(0))).toEqual([]);
    expect(await index.refreshSemantic("doc", client)).toBe(false);
  });

  it("falls back to sparse scoring for invalid vectors and failed refreshes", async () => {
    const index = new HybridIndex();
    index.upsert(document("doc", "Payment procedure"));
    const sparse = index.search("payment");
    expect(sparse).toHaveLength(1);
    expect(index.search("payment", 20, [1])).toEqual(sparse);
    expect(index.search("payment", 20, Array(1024).fill(NaN))).toEqual(sparse);

    expect(await index.refreshSemantic("missing", { embed: async () => vector(0) })).toBe(false);
    expect(await index.refreshSemantic("doc", { embed: async () => [1] })).toBe(false);
    expect(index.search("payment", 20, vector(0))).toEqual(sparse);
    expect(await index.refreshSemantic("doc", { embed: async () => { throw new Error("provider unavailable"); } }))
      .toBe(false);
    expect(index.search("payment", 20, vector(0))).toEqual(sparse);
    expect(await index.refreshSemantic("doc", { embed: async () => Array(1024).fill(Infinity) })).toBe(false);
    expect(index.search("payment", 20, vector(0))).toEqual(sparse);
  });

  it("does not store an in-flight vector after the source changes", async () => {
    const index = new HybridIndex();
    index.upsert(document("doc", "Old text"));
    let resolve!: (value: number[]) => void;
    const pending = index.refreshSemantic("doc", { embed: () => new Promise(done => { resolve = done; }) });
    index.upsert(document("doc", "New text"));
    resolve(vector(0));
    expect(await pending).toBe(false);
    expect(index.search("unrelated", 20, vector(0))).toEqual([]);
  });
});
