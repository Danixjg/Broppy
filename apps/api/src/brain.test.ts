import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "@brain/audit";
import type { RemoteFgaAdapter } from "@brain/fga-adapter";
import type { SemanticEmbeddingClient, SupabaseIndex } from "@brain/retrieval";
import type { IndexedDocument } from "@brain/types";
import { Brain } from "./brain.js";
import { groundedOutput, NO_RESULT } from "@brain/retrieval";

describe("Internal Brain security and sync", () => {
  it("loads four connectors and finds the cutover and failover keys", async () => {
    const brain = new Brain();
    await brain.syncAll();
    expect(Object.keys(brain.connectors)).toEqual(["slack", "jira", "confluence", "drive"]);
    const ids = brain.index.search("PAY-101 SEC-44 cutover failover").map(candidate => candidate.docId);
    expect(ids).toContain("jira:PAY-101");
    expect(ids).toContain("jira:SEC-44");
    expect(ids).toContain("drive:cutover-plan");
    expect(brain.audit.verifyChain()).toBe(true);
  });

  it("does not re-embed permission-only changes", async () => {
    const brain = new Brain();
    await brain.syncAll();
    const before = brain.index.embeddingRefreshes;
    const connector = brain.connectors.slack;
    const permissions = (await connector.fetchPermissions("slack:fraud-private"))!;
    connector.updatePermissions("slack:fraud-private", { ...permissions, groups: [] });
    await brain.sync("slack");
    expect(brain.index.embeddingRefreshes).toBe(before);
    expect(brain.fga.check(brain.user("ravi")!, "slack:fraud-private").allowed).toBe(false);
  });

  it("persists semantic chunks, searches IDs through Supabase, and leaves embeddings alone on permission edits", async () => {
    const vector = [1, ...Array(1023).fill(0)] as number[];
    const embed = vi.fn(async () => vector);
    const syncDocument = vi.fn(async (_doc: IndexedDocument, _vectors: Map<string, number[]>, _changed: boolean) => undefined);
    const search = vi.fn(async (_query: string, _vector: number[], _limit: number) => [
      { docId: "jira:SEC-44", chunkId: "jira:SEC-44:0", score: 0.9 },
      { docId: "drive:steering-deck", chunkId: "drive:steering-deck:0", score: 0.8 }
    ]);
    const supabase = { syncDocument, search, tombstone: vi.fn(async () => undefined) } as unknown as SupabaseIndex;
    const embedding = { embed } as SemanticEmbeddingClient;
    const generated = vi.fn(async (context: Array<{ citation: string; text: string }>) =>
      `${context[0].text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? context[0].text} [${context[0].citation}]`);
    const brain = new Brain({ generate: generated }, { embedding, supabase });
    await brain.syncAll();
    expect(syncDocument).toHaveBeenCalledWith(
      expect.objectContaining({ docId: "jira:PAY-101" }),
      expect.any(Map), true
    );
    expect(syncDocument.mock.calls.find(call => call[0].docId === "jira:PAY-101")?.[1]
      .get("jira:PAY-101:0")).toHaveLength(1024);
    const before = embed.mock.calls.length;
    const permissions = (await brain.connectors.jira.fetchPermissions("jira:PAY-101"))!;
    brain.connectors.jira.updatePermissions("jira:PAY-101", {
      ...permissions, groups: permissions.groups.filter(group => group !== "security")
    });
    await brain.sync("jira");
    expect(embed.mock.calls.length).toBe(before);
    expect(syncDocument.mock.lastCall?.[2]).toBe(false);

    const answer = await brain.query(brain.user("alex")!, "PAY-101 cutover");
    expect(search).toHaveBeenCalledWith("PAY-101 cutover", vector, 30);
    expect(answer.citations.some(citation => citation.docId === "drive:steering-deck")).toBe(true);
    expect(generated.mock.calls.flatMap(call => call[0]).some(item => item.citation === "jira:SEC-44:0")).toBe(false);
  });

  it("retries a failed semantic refresh from the sync checkpoint", async () => {
    const vector = [1, ...Array(1023).fill(0)] as number[];
    let first = true;
    const embedding = { embed: vi.fn(async () => {
      if (first) { first = false; throw new Error("embedding unavailable"); }
      return vector;
    }) };
    const brain = new Brain(undefined, { embedding });
    await expect(brain.sync("slack")).rejects.toThrow("Semantic embedding refresh failed");
    expect(brain.runs.get("slack")?.status).toBe("failed");
    await brain.sync("slack");
    expect(brain.runs.get("slack")?.status).toBe("complete");
    expect(brain.index.semanticVectorsFor("slack:fraud-private").size).toBeGreaterThan(0);
  });

  it("tombstones deleted items and removes them from retrieval", async () => {
    const brain = new Brain();
    await brain.syncAll();
    brain.connectors.drive.delete("drive:cutover-plan");
    await brain.sync("drive");
    expect(brain.index.documents.get("drive:cutover-plan")?.deletedAt).toBeTruthy();
    expect(brain.index.search("staged payment cutover").map(candidate => candidate.docId))
      .not.toContain("drive:cutover-plan");
  });

  it("resumes a failed sync from its pending checkpoint", async () => {
    const brain = new Brain();
    const connector = brain.connectors.drive;
    const original = connector.fetchDocument.bind(connector);
    let failed = false;
    connector.fetchDocument = async id => {
      if (!failed && id === "drive:cutover-duplicate") {
        failed = true;
        throw new Error("Temporary source failure");
      }
      return original(id);
    };
    await expect(brain.sync("drive")).rejects.toThrow("Temporary source failure");
    expect(brain.runs.get("drive")?.status).toBe("failed");
    expect(brain.states.get("drive")?.cursor).toBe(0);
    await brain.sync("drive");
    expect(brain.runs.get("drive")?.status).toBe("complete");
    expect(brain.index.documents.has("drive:cutover-plan")).toBe(true);
  });

  it("never sends denied titles or private channel names to the LLM", async () => {
    const generate = vi.fn(async (_context: Array<{ citation: string; text: string }>) => "Safe. [jira:PAY-101:0]");
    const brain = new Brain({ generate });
    await brain.syncAll();
    await brain.query(brain.user("alex")!, "restricted Q3 payment incident fraud");
    expect(generate).not.toHaveBeenCalled();
    await brain.query(brain.user("maya")!, "PAY-101 fraud-ops-private");
    const context = generate.mock.calls.flatMap(call => call[0]);
    expect(JSON.stringify(context)).not.toContain("fraud-ops-private");
    expect(JSON.stringify(context)).not.toContain("Restricted Q3");
  });

  it("returns the same fixed result for zero allowed and skips the LLM", async () => {
    const generate = vi.fn(async () => "Should not run");
    const brain = new Brain({ generate });
    await brain.syncAll();
    const answer = await brain.query(brain.user("alex")!, "SEC-44 failover");
    expect(answer).toEqual({ text: NO_RESULT, citations: [] });
    expect(generate).not.toHaveBeenCalled();
    expect(await brain.query(brain.user("alex")!, "there is no such source item"))
      .toEqual(answer);
  });

  it("lets a remote FGA denial stop context and workspace content", async () => {
    const generate = vi.fn(async () => "Should not run");
    const remote = {
      syncDocument: vi.fn(async () => undefined),
      removeDocument: vi.fn(async () => undefined),
      batchCheck: vi.fn(async (_user: unknown, ids: string[]) => ids.map(docId => ({
        docId, allowed: false, reason: "fga" as const
      }))),
      narrowTier: vi.fn()
    } as unknown as RemoteFgaAdapter;
    const brain = new Brain({ generate }, { remoteFga: remote });
    await brain.syncAll();
    expect(await brain.query(brain.user("ravi")!, "PAY-101 cutover"))
      .toEqual({ text: NO_RESULT, citations: [] });
    expect(await brain.visibleDocuments(brain.user("ravi")!)).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("retries remote tuple removal after a live tombstone", async () => {
    let failRemoval = true;
    const removeDocument = vi.fn(async () => {
      if (failRemoval) { failRemoval = false; throw new Error("FGA unavailable"); }
    });
    const remote = {
      syncDocument: vi.fn(async () => undefined),
      removeDocument,
      batchCheck: vi.fn(async (_user: unknown, ids: string[]) => ids.map(docId => ({
        docId, allowed: true, reason: "fga" as const
      }))),
      narrowTier: vi.fn()
    } as unknown as RemoteFgaAdapter;
    const brain = new Brain(undefined, { remoteFga: remote });
    await brain.syncAll();
    brain.connectors.drive.delete("drive:cutover-plan");
    await brain.query(brain.user("ravi")!, "staged payment cutover");
    expect(brain.index.documents.get("drive:cutover-plan")?.deletedAt).toBeTruthy();
    await brain.sync("drive");
    expect(removeDocument).toHaveBeenCalledTimes(2);
    expect(brain.runs.get("drive")?.status).toBe("complete");
  });

  it("applies a live permission revocation on the next query", async () => {
    const generate = vi.fn(async () => "Private fraud review. [slack:fraud-private:0]");
    const brain = new Brain({ generate });
    await brain.syncAll();
    const ravi = brain.user("ravi")!;
    expect((await brain.query(ravi, "Private fraud review")).citations.length).toBeGreaterThan(0);
    const calls = generate.mock.calls.length;
    brain.connectors.slack.updatePermissions("slack:fraud-private", {
      users: [],
      groups: [],
      public: false
    });
    const answer = await brain.query(ravi, "Private fraud review");
    expect(answer).toEqual({ text: NO_RESULT, citations: [] });
    expect(generate).toHaveBeenCalledTimes(calls);
  });

  it("refreshes a newer source version before context assembly", async () => {
    const generate = vi.fn(async (context: Array<{ citation: string; text: string }>) =>
      `${context[0].text} [${context[0].citation}]`);
    const brain = new Brain({ generate });
    await brain.syncAll();
    brain.connectors.jira.updateContent(
      "jira:PAY-101",
      "PAY-101 cutover now requires a 2:05 PM rollback checkpoint."
    );
    const answer = await brain.query(brain.user("ravi")!, "PAY-101 rollback checkpoint");
    expect(answer.text).toContain("2:05 PM");
    expect(brain.index.documents.get("jira:PAY-101")?.version).toBe(3);
  });

  it("removes uncited output", () => {
    const allowed = new Map([["jira:PAY-101:0", {
      docId: "jira:PAY-101",
      chunkId: "jira:PAY-101:0",
      title: "PAY-101",
      url: "https://jira.example/browse/PAY-101",
      version: 1,
      updatedAt: "2026-09-26T00:00:00.000Z",
      lastIndexedAt: "2026-09-26T00:00:00.000Z"
    }]]);
    const answer = groundedOutput("Approved cutover. [jira:PAY-101:0]\nSecret unsupported claim.",
      allowed, new Map([["jira:PAY-101:0", "Approved cutover."]]));
    expect(answer.text).toBe("Approved cutover. [jira:PAY-101:0]");
    expect(answer.citations).toHaveLength(1);
    expect(groundedOutput("The restricted Q3 incident confirms a secret. [jira:PAY-101:0]",
      allowed, new Map([["jira:PAY-101:0", "Approved cutover."]]))).toEqual({
      text: NO_RESULT, citations: []
    });
  });

  it("prevents admins from broadening access and defaults contractors to deny", async () => {
    const brain = new Brain();
    await brain.syncAll();
    const maya = brain.user("maya")!;
    await brain.narrowTier(maya, "jira:PAY-101", "restricted");
    await expect(brain.narrowTier(maya, "jira:PAY-101", "open")).rejects.toThrow("narrow");
    expect(brain.fga.check(brain.user("wei")!, "jira:PAY-101").allowed).toBe(false);
    expect(await brain.query(brain.user("wei")!, "PAY-101")).toEqual({ text: NO_RESULT, citations: [] });
  });

  it("produces a verifiable Merkle inclusion proof", async () => {
    const brain = new Brain();
    await brain.syncAll();
    const batch = brain.audit.seal()!;
    const proof = brain.audit.proof(1)!;
    expect(AuditLog.verifyProof(proof, batch.root)).toBe(true);
    expect(AuditLog.verifyProof(proof, "0".repeat(64))).toBe(false);
    expect(brain.audit.verifyChain()).toBe(true);
  });
});
