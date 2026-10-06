import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SourceDocument } from "@brain/types";
import { core } from "@brain/rust-core";
import { chunk, hash, HybridIndex } from "./index.js";

const document = (content: string): SourceDocument => ({
  docId: "drive:doc", source: "drive", sourceNativeId: "doc", title: "Payment", content,
  url: "https://example.test/doc", version: 1, updatedAt: "2026-10-01T00:00:00.000Z",
  metadata: {}, permissions: { users: [], groups: [], public: false }, tier: "internal"
});

describe("Rust core integration", () => {
  it("loads the compiled core and rejects an unknown operation", () => {
    expect(core("core.version", null)).toBe("0.1.0");
    expect(() => core("missing.operation", null)).toThrow("Unknown core operation");
  });

  it("preserves persisted JavaScript JSON hashes for runtime-specific objects and numbers", () => {
    class RecordValue { z = 1; a = 2; }
    const values = [new RecordValue(), new Date("2026-10-01T00:00:00.000Z"),
      { toJSON: () => ({ z: 1, a: 2 }) }, [1e-7, 1e21, -0, NaN, Infinity],
      { "10": 1, "2": 2, a: { z: 1, b: 2 }, missing: undefined }];
    const bytes = ['{"z":1,"a":2}', '"2026-10-01T00:00:00.000Z"', '{"z":1,"a":2}',
      '[1e-7,1e+21,0,null,null]', '{"2":2,"10":1,"a":{"b":2,"z":1}}'];
    values.forEach((value, index) => {
      expect(hash(value)).toBe(createHash("sha256").update(bytes[index]).digest("hex"));
    });
  });

  it("keeps every character of long tokens and never splits a surrogate pair", () => {
    const content = "😀" + "a".repeat(1801);
    const chunks = chunk(document(content));
    expect(chunks.map(item => item.text).join("")).toBe(content);
    expect(chunks.every(item => Array.from(item.text).every(char => { const point = char.codePointAt(0)!; return point < 0xd800 || point > 0xdfff; }))).toBe(true);
    expect(chunks.every(item => item.text.length <= 900)).toBe(true);
    expect(chunk(document("\u0085Payment\u0085"))[0].text).toBe("\u0085Payment\u0085");
  });

  it("restores searchable chunks when a tombstoned document is reimported unchanged", () => {
    const index = new HybridIndex();
    const doc = document("Payment recovery guide");
    index.upsert(doc);
    index.tombstone(doc.docId);
    expect(index.search("recovery")).toEqual([]);
    expect(index.upsert(doc).contentChanged).toBe(true);
    expect(index.search("recovery")).toHaveLength(1);
  });

  it("rejects overflowing saved vectors without corrupting the live index", async () => {
    const index = new HybridIndex();
    index.upsert(document("Payment recovery guide"));
    const corrupted = index.documents.get("drive:doc")!;
    corrupted.chunks[0].embedding = { payment: 1e308, cutover: 1e308 };
    expect(() => index.restore([corrupted])).toThrow("Invalid stored sparse vector");
    expect(index.search("payment recovery")).toHaveLength(1);
    expect(await index.searchAsync("payment recovery")).toHaveLength(1);
  });

  it("uses native async ranking with the same result and defensive document snapshots", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
      const index = new HybridIndex();
      index.upsert(document("Payment recovery guide"));
      const expected = index.search("payment recovery", Number.MAX_SAFE_INTEGER);
      expect(await Promise.all(Array.from({ length: 8 }, () => index.searchAsync("payment recovery", Number.MAX_SAFE_INTEGER))))
        .toEqual(Array(8).fill(expected));
      const copy = index.documents.get("drive:doc")!;
      copy.chunks.length = 0;
      copy.content = "mutated";
      expect(index.documents.get("drive:doc")!.content).toBe("Payment recovery guide");
      expect(index.search("payment recovery")).toEqual(expected);
      index.remove("drive:doc");
      expect(await index.searchAsync("payment recovery")).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
