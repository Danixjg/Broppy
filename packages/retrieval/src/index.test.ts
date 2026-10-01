import { describe, expect, it, vi } from "vitest";
import type { Citation, SourceDocument } from "@brain/types";
import { groundedOutput, HybridIndex, LocalGroundedLlm, type SemanticEmbeddingClient } from "./index.js";

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

  it("keeps a document's links with its metadata, so a link-only change never re-chunks or re-embeds", async () => {
    const index = new HybridIndex();
    const client = { embed: vi.fn(async () => vector(0)) };
    const original = { ...document("doc", "Reimbursement procedure"), links: ["jira:PAY-1"] };
    if (index.upsert(original).contentChanged) await index.refreshSemantic("doc", client);
    const before = index.documents.get("doc")!;

    const update = index.upsert({ ...original, links: ["jira:PAY-1", "slack:C1"] });
    if (update.contentChanged) await index.refreshSemantic("doc", client);
    expect(update).toEqual({ contentChanged: false, permissionChanged: false });
    const after = index.documents.get("doc")!;
    expect(after.links).toEqual(["jira:PAY-1", "slack:C1"]);
    expect(after.metadataHash).not.toBe(before.metadataHash);
    expect(after.chunks).toEqual(before.chunks);
    expect(after.lastIndexedAt).toBe(before.lastIndexedAt);
    expect(client.embed).toHaveBeenCalledTimes(1);
    expect(index.search("payment", 20, vector(0))).toHaveLength(1);
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

describe("HybridIndex relevance", () => {
  it("ignores stopwords and partial words when matching a question", () => {
    const index = new HybridIndex();
    index.upsert(document("vendor", "Vendor checklist: validate the sandbox callbacks before the deadline."));
    index.upsert(document("channel", "Channel members review each alert."));
    index.upsert(document("report", "Security incident report for the breach."));
    expect(index.search("Show me the security incident report from the Q3 breach").map(result => result.docId))
      .toEqual(["report"]);
    expect(index.search("Show me all of the ones from last week")).toEqual([]);
  });

  it("matches a hyphenated question term against its separate words", () => {
    const index = new HybridIndex();
    index.upsert(document("gateway", "Payment gateway operations and settlement health."));
    index.upsert(document("other", "Gateway timeouts for the partner portal."));
    expect(index.search("payment-gateway").map(result => result.docId)).toEqual(["gateway"]);
  });

  it("scores words that are also object property names", () => {
    const index = new HybridIndex();
    index.upsert(document("builder", "The payment constructor sets toString defaults."));
    const results = index.search("payment constructor toString");
    expect(results.map(result => result.docId)).toEqual(["builder"]);
    expect(Number.isFinite(results[0].score)).toBe(true);
  });

  it("treats blockers and blocker as the same topic", () => {
    const index = new HybridIndex();
    index.upsert(document("thread", "Blocker raised: the backfill keeps timing out."));
    expect(index.search("any blockers?").map(result => result.docId)).toEqual(["thread"]);
  });
});

describe("LocalGroundedLlm", () => {
  const citation = (chunkId: string): Citation => ({ docId: chunkId.split(":")[0], chunkId, title: chunkId,
    url: `https://example.test/${chunkId}`, version: 1, updatedAt: "2026-10-01T00:00:00.000Z",
    lastIndexedAt: "2026-10-01T00:00:00.000Z" });

  it("quotes the most relevant source in full, then the best sentence of the next three", async () => {
    const context = [
      { citation: "runbook:0", text: "Step 1: page on-call. Step 2: freeze deploys. Step 3: fail over traffic." },
      { citation: "thread:0", text: "Standup notes. Migration blocker raised by the team." },
      { citation: "issue:0", text: "Only one sentence here." },
      { citation: "plan:0", text: "Plan sentence." },
      { citation: "extra:0", text: "Never used." }
    ];
    const output = await new LocalGroundedLlm().generate(context, "migration blocker");
    expect(output.split("\n")).toEqual([
      "Step 1: page on-call. [runbook:0]",
      "Step 2: freeze deploys. [runbook:0]",
      "Step 3: fail over traffic. [runbook:0]",
      "Migration blocker raised by the team. [thread:0]",
      "Only one sentence here. [issue:0]",
      "Plan sentence. [plan:0]"
    ]);
    const answer = groundedOutput(output, new Map(context.map(item => [item.citation, citation(item.citation)])),
      new Map(context.map(item => [item.citation, item.text])));
    expect(answer.text).toBe(output);
    expect(answer.citations.map(item => item.chunkId)).toEqual(["runbook:0", "thread:0", "issue:0", "plan:0"]);
  });

  it("picks a source's best sentence by topic words, not by small words such as 'is' or 'of'", async () => {
    const context = [
      { citation: "first:0", text: "First source." },
      { citation: "thread:0", text: "The standup is one of the notes we are keeping. Blocker raised on the ledger database." }
    ];
    const output = await new LocalGroundedLlm().generate(context, "What is the status of the database, and what are the blockers?");
    expect(output.split("\n")[1]).toBe("Blocker raised on the ledger database. [thread:0]");
  });

  it("quotes at most six sentences of the first source", async () => {
    const text = Array.from({ length: 9 }, (_, index) => `Sentence ${index + 1}.`).join(" ");
    const output = await new LocalGroundedLlm().generate([{ citation: "long:0", text }], "sentence");
    expect(output.split("\n")).toHaveLength(6);
  });
});
