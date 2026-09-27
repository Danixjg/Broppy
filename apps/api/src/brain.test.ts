import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "@brain/audit";
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

  it("tombstones deleted items and removes them from retrieval", async () => {
    const brain = new Brain();
    await brain.syncAll();
    brain.connectors.drive.delete("drive:cutover-plan");
    await brain.sync("drive");
    expect(brain.index.documents.get("drive:cutover-plan")?.deletedAt).toBeTruthy();
    expect(brain.index.search("staged payment cutover").map(candidate => candidate.docId))
      .not.toContain("drive:cutover-plan");
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
  });

  it("applies a live permission revocation on the next query", async () => {
    const generate = vi.fn(async () => "Private review. [slack:fraud-private:0]");
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
    const answer = groundedOutput("Approved cutover. [jira:PAY-101:0]\nSecret unsupported claim.", allowed);
    expect(answer.text).toBe("Approved cutover. [jira:PAY-101:0]");
    expect(answer.citations).toHaveLength(1);
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
