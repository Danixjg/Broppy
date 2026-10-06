import { describe, expect, it } from "vitest";
import { fingerprint, tokens } from "./fingerprint.js";
import { MemoryTaskStore, SupabaseTaskStore, proposalId, type Proposal } from "./store.js";

const proposal = (): Proposal => ({ id: proposalId("CDB", "1.1", "TONE"), revision: 1, status: "pending", reviewerSlackId: "UMAYA", teamId: "TONE",
  suggestion: { t: "Raise storage quota", a: "UMAYA", p: "DB", c: "CDB", ts: "1.1", s: "Private source", th: "1.0" } });

describe("proposal persistence", () => {
  it("compares revisions and preserves immutable evidence and source identity", async () => {
    const store = new MemoryTaskStore(); const p = proposal(); expect(await store.saveProposal(p)).toBe(true);
    expect(await store.saveProposal({ ...p, id: proposalId("CDB", "2.0", "TONE") })).toBe(false);
    expect(await store.saveProposal({ ...p, revision: 2, suggestion: { ...p.suggestion, s: "Changed source" } }, 1)).toBe(false);
    expect(await store.saveProposal({ ...p, revision: 2, suggestion: { ...p.suggestion, t: "Increase storage quota" } }, 1)).toBe(true);
    expect(await store.saveProposal({ ...p, revision: 2, status: "dismissed" }, 1)).toBe(false);
    expect((await store.getProposal(p.id))?.suggestion.s).toBe("Private source");
  });
  it("locks proposal edits once an operation is reserved", async () => {
    const store = new MemoryTaskStore(); const p = proposal(); await store.saveProposal(p); const op = await store.reserveOperation(p, "UMAYA");
    expect(op?.state).toBe("reserved"); expect(await store.saveProposal({ ...p, revision: 2, status: "dismissed" }, 1)).toBe(false);
  });
  it("preserves unknown legacy track claims instead of recreating an unrecorded Jira write", async () => {
    const store = new MemoryTaskStore(); const p = proposal(); await store.saveProposal(p); await store.claim("track:CDB:1.1");
    expect((await store.reserveOperation(p, "UMAYA"))?.state).toBe("uncertain");
  });
  it("retains a legacy uncertainty fence when a different in-flight owner definitively refuses and edits", async () => {
    const store = new MemoryTaskStore(); const first = proposal(); await store.saveProposal(first); const op = await store.reserveOperation(first, "UMAYA");
    await store.advanceOperation(op!.id, "reserved", { state: "creating" });
    const legacy = { ...first, id: proposalId("CDB", "legacy", "TONE"), suggestion: { ...first.suggestion, ts: "legacy" } };
    await store.saveProposal(legacy); await store.claim("track:CDB:legacy"); await store.reserveOperation(legacy, "UMAYA");
    await store.advanceOperation(op!.id, "creating", { state: "refused" });
    expect(await store.saveProposal({ ...first, revision: 2, suggestion: { ...first.suggestion, t: "Different revised task" } }, 1)).toBe(true);
    const third = { ...first, id: proposalId("CDB", "third", "TONE"), suggestion: { ...first.suggestion, ts: "third" } };
    await store.saveProposal(third); expect((await store.reserveOperation(third, "UMAYA"))?.state).toBe("uncertain");
    expect((await store.reserveOperation(legacy, "UMAYA"))?.state).toBe("uncertain");
  });
  it.each(["reserved", "creating", "uncertain", "remote_succeeded", "linked", "notifying", "notified"] as const)("refuses draft mutation in operation state %s while retaining safe finalization", async state => {
    const store = new MemoryTaskStore(); const p = proposal(); await store.saveProposal(p); const op = await store.reserveOperation(p, "UMAYA");
    await store.advanceOperation(op!.id, "reserved", { state, ...(state === "remote_succeeded" ? { issueKey: "DB-1", issueUrl: "https://j/DB-1" } : {}) });
    expect(await store.saveProposal({ ...p, revision: 2, status: "dismissed" }, 1)).toBe(false);
    if (state === "remote_succeeded") expect((await store.completeProposal(p.id, 1, op!.id, "UMAYA", "2026-10-05T12:00:00Z"))?.status).toBe("created");
  });
  it("releases a definite no-effect refusal for a revised approval", async () => {
    const store = new MemoryTaskStore(); const p = proposal(); await store.saveProposal(p); const op = await store.reserveOperation(p, "UMAYA");
    await store.advanceOperation(op!.id, "reserved", { state: "refused" });
    const edited = { ...p, revision: 2, suggestion: { ...p.suggestion, t: "Rotate staging keys" } };
    expect(await store.saveProposal(edited, 1)).toBe(true);
    const next = await store.reserveOperation(edited, "UMAYA"); expect(next?.id).not.toBe(op?.id); expect(next?.proposal.suggestion.t).toBe("Rotate staging keys");
    expect(next?.state).toBe("reserved");
  });
  it("queries exact matches directly rather than hiding older tasks behind the 500 candidate bound", async () => {
    const requested: string[] = []; const store = new SupabaseTaskStore("org-one", "https://db.test", "key", async url => { requested.push(String(url)); return new Response(JSON.stringify([{ fingerprint: "exact", project: "DB", title: "Old task", tokens: [], issue_key: "DB-1", issue_url: "https://j/DB-1", assignee_slack_id: "UMAYA", tracked_by: "UMAYA", channel: "CDB", message_ts: "1.0", mention_count: 1 }])); });
    expect((await store.findTask("DB", "exact", []))?.issueKey).toBe("DB-1"); expect(requested[0]).toContain("org_id=eq.org-one"); expect(requested[0]).toContain("title_fingerprint=eq.exact&order=created_at.asc&limit=1");
  });
  it("does not merge title overlap as an exact task", async () => {
    const store = new MemoryTaskStore(); const title = "Raise replica storage quota";
    await store.saveTask({ fingerprint: fingerprint("DB", title), project: "DB", title, tokens: tokens(title), issueKey: "DB-1", issueUrl: "https://j/DB-1", assigneeSlackId: "UMAYA", trackedBy: "UMAYA", channel: "CDB", messageTs: "1", mentionCount: 1 });
    const similar = "Raise replica storage quota urgently";
    expect(await store.findTask("DB", fingerprint("DB", similar), tokens(similar))).toBeUndefined(); expect((await store.candidates("DB", fingerprint("DB", similar), tokens(similar)))[0].issueKey).toBe("DB-1");
  });
  it("keeps link-only admission scoped to its source and cannot arm it for Jira creation", async () => {
    const store = new MemoryTaskStore(); const p = proposal(); await store.saveProposal(p);
    const link = { fingerprint: "visible", project: "DB", title: "Raise storage quota", tokens: tokens("Raise storage quota"), issueKey: "DB-88", issueUrl: "https://j/DB-88", assigneeSlackId: "UMAYA", trackedBy: "UMAYA", channel: "CDB", messageTs: "visible", mentionCount: 1 };
    const op = await store.reserveLinkOperation(p, "UMAYA", link);
    expect(op).toMatchObject({ kind: "link", state: "remote_succeeded", issueKey: "DB-88" });
    expect((await store.reserveOperation(p, "UMAYA"))?.id).toBe(op!.id);
    expect(await store.advanceOperation(op!.id, "remote_succeeded", { state: "creating" })).toBeUndefined();
    expect(await store.reserveLinkOperation(p, "UMAYA", { ...link, issueKey: "DB-99" })).toBeUndefined();
  });
});
