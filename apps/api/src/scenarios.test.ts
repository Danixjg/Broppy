import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { LocalGroundedLlm, NO_RESULT, type LlmClient } from "@brain/retrieval";
import type { AuditEntry } from "@brain/types";
import { Brain } from "./brain.js";
import { searchAudit } from "./audit-search.js";
import { actorTrace, createApiServer } from "./server.js";

// Worked scenarios from the challenge brief.

const openServers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function start() {
  process.env.ALLOW_DEMO_AUTH = "true";
  const api = await createApiServer({ startOrchestrator: false });
  openServers.push(api.server);
  await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
  const address = api.server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, user: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "x-demo-user": user, "content-type": "application/json", ...init.headers }
    });
    return { status: response.status, body: await response.json() };
  };
  const ask = (user: string, question: string) =>
    request("/v1/query", user, { method: "POST", body: JSON.stringify({ question }) });
  return { ...api, request, ask };
}

function documents(brain: Brain) {
  return [...brain.index.documents.values()].map(doc => ({ docId: doc.docId, title: doc.title }));
}

function questions(entries: AuditEntry[]) {
  return entries.filter(entry => entry.type === "query_received").map(entry => entry.data.question);
}

function cited(answer: { citations: Array<{ docId: string }> }) {
  return answer.citations.map(citation => citation.docId);
}

// The local answer writer, recording the context it was given.
function recordingLlm() {
  const contexts: Array<Array<{ citation: string; text: string }>> = [];
  const local = new LocalGroundedLlm();
  const llm: LlmClient = {
    generate: async (context, question) => {
      contexts.push(structuredClone(context));
      return local.generate(context, question);
    }
  };
  const sent = () => contexts.flat().map(item => item.citation.slice(0, item.citation.lastIndexOf(":")));
  return { llm, contexts, sent };
}

const migrationQuestion =
  "What's the status of the database migration project and were there any blockers raised in Slack last week?";
const runbookQuestion = "What's the latest runbook for the payment-service incident?";
const failoverStep = "Step 4: if errors persist for ten minutes, fail over payment traffic to the standby region.";

describe("Scenario 1: unified natural-language query", () => {
  it("answers from Jira and the engineer's Slack channels, with citations and issue status", async () => {
    const brain = new Brain();
    await brain.syncAll();
    const answer = await brain.query(brain.user("david")!, migrationQuestion);
    expect(cited(answer)).toEqual(expect.arrayContaining(["jira:DB-12", "jira:DB-15", "slack:db-migration"]));
    expect(answer.text).toContain(
      "Blocker raised: the backfill job keeps timing out on the ledger database, so the final migration wave is on hold until DB-15 is fixed.");
    expect(answer.text).toContain("DB-12 (in progress) tracks the ledger database migration project.");
    expect(answer.text).toContain("DB-15 (blocked): Replica lag stays above five minutes");
    expect(answer.scope).toMatchObject({ sources: ["slack"] });
    expect(answer.scope?.from).toBeDefined();
  });

  it("omits a private channel the engineer is not in, everywhere but the compliance audit", async () => {
    const { llm, sent } = recordingLlm();
    const brain = new Brain(llm);
    await brain.syncAll();
    const answer = await brain.query(brain.user("david")!, migrationQuestion);
    expect(cited(answer)).not.toContain("slack:db-oncall");
    expect(sent()).not.toContain("slack:db-oncall");
    expect(JSON.stringify(answer)).not.toContain("lock timeouts");
    expect(brain.audit.entries.some(entry => entry.type === "access_decision" &&
      entry.data.docId === "slack:db-oncall" && entry.data.allowed === false)).toBe(true);

    const ravi = await brain.query(brain.user("ravi")!, migrationQuestion);
    expect(cited(ravi)).toContain("slack:db-oncall");
  });

  it("keeps the private channel out of the engineer's own trace, which shows how the question was read", async () => {
    const { request, ask } = await start();
    const answer = await ask("david", migrationQuestion);
    const trace = await request(`/v1/trace?traceId=${answer.body.traceId}`, "david");
    expect(trace.status).toBe(200);
    expect(JSON.stringify(trace.body)).not.toContain("db-oncall");
    expect(trace.body.entries).toContainEqual(expect.objectContaining({
      type: "query_planned", data: expect.objectContaining({ sources: ["slack"] })
    }));
  });

  it("limits the Slack part to last week, while older Jira issues still count", async () => {
    const { llm, sent } = recordingLlm();
    const brain = new Brain(llm);
    await brain.syncAll();
    await brain.query(brain.user("david")!, migrationQuestion);
    expect(sent()).not.toContain("slack:db-planning");
    expect(sent()).toContain("jira:DB-12");

    const anyTime = await brain.query(brain.user("david")!,
      "What's the status of the database migration project and were there any blockers raised in Slack?");
    expect(sent()).toContain("slack:db-planning");
    expect(anyTime.scope).toEqual({ sources: ["slack"] });
  });
});

describe("Context assembly: linked items", () => {
  const traceOf = (brain: Brain, traceId: string) => brain.audit.entries.filter(entry => entry.data.traceId === traceId);
  const linked = (entries: AuditEntry[]) => entries.filter(entry => entry.type === "candidate_linked").map(entry => entry.data.docId);

  it("brings in an item linked from a match, even one that shares no words with the question", async () => {
    const { llm, sent } = recordingLlm();
    const brain = new Brain(llm);
    await brain.syncAll();
    const answer = await brain.query(brain.user("david")!, "What's the status of DB-12?");
    expect(sent()).toContain("drive:db-wave-checklist");
    expect(answer.text).toContain("Wave three checklist: pause ledger writes");
    expect(answer.citations.find(citation => citation.docId === "drive:db-wave-checklist")?.linkedFrom).toBe("jira:DB-12");
    expect(answer.citations.find(citation => citation.docId === "jira:DB-12")?.linkedFrom).toBeUndefined();
    expect(brain.audit.entries).toContainEqual(expect.objectContaining({ type: "candidate_linked",
      data: expect.objectContaining({ docId: "drive:db-wave-checklist", fromDocId: "jira:DB-12" }) }));
  });

  it("never follows links from a document the asker may not open", async () => {
    const askWithLink = async (from: string) => {
      const { llm, sent } = recordingLlm();
      const brain = new Brain(llm);
      await brain.syncAll();
      // As if the source declared it: a link to the chargeback guide, which matches nothing in the question.
      brain.index.documents.get(from)!.links = ["drive:chargeback-guide"];
      await brain.query(brain.user("alex")!, "Q3 incident milestones");
      return { sent: sent(), linked: linked(brain.audit.entries) };
    };
    const fromRestricted = await askWithLink("confluence:q3-incident");
    expect(fromRestricted.sent).toEqual(["drive:steering-deck"]);
    expect(fromRestricted.linked).not.toContain("drive:chargeback-guide");
    const fromOpen = await askWithLink("drive:steering-deck");
    expect(fromOpen.linked).toContain("drive:chargeback-guide");
    expect(fromOpen.sent).toContain("drive:chargeback-guide");
  });

  it("checks a linked item like any other, and keeps a refused one out of the asker's trace", async () => {
    const question = "Why is DB-15 blocked?";
    const { llm, sent } = recordingLlm();
    const brain = new Brain(llm);
    await brain.syncAll();
    let traceId = "";
    await brain.query(brain.user("david")!, question, id => { traceId = id; });
    const trace = traceOf(brain, traceId);
    expect(linked(trace)).toContain("slack:db-oncall");
    expect(trace).toContainEqual(expect.objectContaining({ type: "access_decision",
      data: expect.objectContaining({ docId: "slack:db-oncall", allowed: false }) }));
    expect(sent()).not.toContain("slack:db-oncall");
    expect(JSON.stringify(actorTrace(trace))).not.toContain("db-oncall");

    const ravi = recordingLlm();
    const raviBrain = new Brain(ravi.llm);
    await raviBrain.syncAll();
    let raviTrace = "";
    await raviBrain.query(raviBrain.user("ravi")!, question, id => { raviTrace = id; });
    expect(ravi.sent()).toContain("slack:db-oncall");
    // Ravi's own trace says how the thread was reached.
    expect(actorTrace(traceOf(raviBrain, raviTrace))).toContainEqual(expect.objectContaining({ type: "candidate_linked",
      data: expect.objectContaining({ docId: "slack:db-oncall", fromDocId: "jira:DB-15" }) }));
  });

  it("applies the question's time window and access changes to linked items", async () => {
    const { llm, sent, contexts } = recordingLlm();
    const brain = new Brain(llm);
    await brain.syncAll();
    let traceId = "";
    await brain.query(brain.user("david")!, migrationQuestion, id => { traceId = id; });
    // The plan page links to #db-planning, but it's older than "last week".
    expect(linked(traceOf(brain, traceId))).toContain("drive:db-wave-checklist");
    expect(linked(traceOf(brain, traceId))).not.toContain("slack:db-planning");
    expect(sent()).not.toContain("slack:db-planning");

    // Scenario 4's removal also holds for the thread DB-12 links to.
    await brain.removeSlackMember(brain.user("maya")!, "slack:db-migration", "david");
    const before = contexts.length;
    await brain.query(brain.user("david")!, "What's the status of DB-12?");
    const latest = contexts.slice(before).flat().map(item => item.citation.slice(0, item.citation.lastIndexOf(":")));
    expect(latest).toContain("jira:DB-12");
    expect(latest).not.toContain("slack:db-migration");
  });

  it("drops what was reached through an item that fails its live check", async () => {
    const { llm, sent } = recordingLlm();
    const brain = new Brain(llm);
    await brain.syncAll();
    // DB-12 is closed to David at the source, but not yet synced: the index still allows it.
    const permissions = (await brain.connectors.jira.fetchPermissions("jira:DB-12"))!;
    const native = permissions.native as Extract<typeof permissions.native, { source: "jira" }>;
    brain.connectors.jira.updatePermissions("jira:DB-12", { ...permissions, native: { ...native,
      issueViewers: native.issueViewers!.filter(viewer => viewer !== "david@aspire.example") } });
    const answer = await brain.query(brain.user("david")!, "What's the status of DB-12?");
    expect(linked(brain.audit.entries)).toContain("drive:db-wave-checklist");
    expect(sent()).not.toContain("drive:db-wave-checklist");
    expect(cited(answer)).not.toContain("drive:db-wave-checklist");
  });

  it("keeps scenario 1's cited lines, and sends the checklist attached to DB-12 to the writer", async () => {
    const { llm, sent } = recordingLlm();
    const brain = new Brain(llm);
    await brain.syncAll();
    const answer = await brain.query(brain.user("david")!, migrationQuestion);
    expect(cited(answer)).toEqual(["slack:db-migration", "jira:DB-12", "confluence:db-migration-plan", "jira:DB-15"]);
    expect(sent()).toContain("drive:db-wave-checklist");
  });
});

describe("Scenario 2: data freshness", () => {
  it("includes a 1:00 PM runbook edit in a 2:05 PM answer, and never the superseded copy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    const brain = new Brain();
    await brain.syncAll();

    vi.setSystemTime(new Date("2026-10-15T13:00:00.000Z"));
    const runbook = (await brain.connectors.confluence.fetchDocument("confluence:payment-service-runbook"))!;
    // Edited in Confluence itself: no sync has run when the question arrives.
    brain.connectors.confluence.updateContent(runbook.docId, `${runbook.content} ${failoverStep}`);

    vi.setSystemTime(new Date("2026-10-15T14:05:00.000Z"));
    const answer = await brain.query(brain.user("david")!, runbookQuestion);
    expect(answer.text).toContain(failoverStep);
    expect(answer.text).toContain("Step 1: page the payments on-call engineer.");
    expect(answer.citations.find(citation => citation.docId === runbook.docId))
      .toMatchObject({ version: runbook.version + 1, updatedAt: "2026-10-15T13:00:00.000Z" });
    expect(cited(answer)).not.toContain("drive:runbook-2025");
    expect(answer.text).not.toContain("restart the payment service");
  });

  it("shows an admin's runbook edit in the next answer", async () => {
    const { request, ask } = await start();
    const docId = "confluence:payment-service-runbook";
    expect((await ask("david", runbookQuestion)).body.text).not.toContain(failoverStep);
    const workspace = await request("/v1/workspace", "maya");
    const runbook = workspace.body.documents.find((doc: { docId: string }) => doc.docId === docId);
    expect((await request("/v1/admin/content", "maya", {
      method: "POST", body: JSON.stringify({ docId, content: `${runbook.content} ${failoverStep}` })
    })).status).toBe(200);
    expect((await ask("david", runbookQuestion)).body.text).toContain(failoverStep);
  });
});

describe("Scenario 3: permission enforcement for negative cases", () => {
  const question = "Show me the security incident report from the Q3 breach";
  const absent = "Show me the zebra onboarding notes from the Q9 offsite";

  it("gives the contractor and the intern the fixed reply, identical to an absent topic", async () => {
    const brain = new Brain();
    await brain.syncAll();
    for (const id of ["wei", "alex"]) {
      const answer = await brain.query(brain.user(id)!, question);
      expect(answer).toEqual({ text: NO_RESULT, citations: [] });
      expect(await brain.query(brain.user(id)!, absent)).toEqual(answer);
    }
  });

  it("keeps the restricted report out of the contractor's response and trace", async () => {
    const { request, ask } = await start();
    const denied = await ask("wei", question);
    const missing = await ask("wei", absent);
    expect(denied.body.text).toBe(NO_RESULT);
    expect(denied.body.citations).toEqual([]);
    const deniedTrace = await request(`/v1/trace?traceId=${denied.body.traceId}`, "wei");
    const missingTrace = await request(`/v1/trace?traceId=${missing.body.traceId}`, "wei");
    const shape = (entries: Array<{ sequence: number; type: string; data: unknown }>) =>
      entries.map(({ sequence, type, data }) => ({ sequence, type, data }));
    expect(shape(deniedTrace.body.entries)).toEqual(shape(missingTrace.body.entries));
    for (const text of [JSON.stringify(denied.body), JSON.stringify(deniedTrace.body)]) {
      expect(text).not.toContain("Restricted Q3");
      expect(text).not.toContain("q3-incident");
      expect(text).not.toContain("sec-incident");
    }
  });

  it("still gives an authorized user a multi-source cited answer", async () => {
    const brain = new Brain();
    await brain.syncAll();
    const answer = await brain.query(brain.user("ravi")!, "What does PAY-101 need before cutover?");
    expect(answer.text).toContain("Complete SEC-44 failover verification before production traffic moves.");
    expect(new Set(answer.citations.map(citation => citation.docId.split(":")[0])).size).toBeGreaterThan(1);
  });
});

describe("Scenario 4: live permission changes", () => {
  it("drops a Slack channel from the next answer once the engineer leaves it", async () => {
    const { request, ask } = await start();
    expect(cited((await ask("david", migrationQuestion)).body)).toContain("slack:db-migration");
    expect((await request("/v1/admin/channel-member", "maya", {
      method: "POST", body: JSON.stringify({ docId: "slack:db-migration", userId: "david" })
    })).status).toBe(200);
    const after = await ask("david", migrationQuestion);
    expect(cited(after.body)).not.toContain("slack:db-migration");
    expect(after.body.text).not.toContain("backfill job");
    expect(cited(after.body)).toEqual(expect.arrayContaining(["jira:DB-12", "jira:DB-15"]));
  });

  it("hides a Confluence page from the next answer once it is restricted, without revealing it", async () => {
    const { request, ask } = await start();
    const docId = "confluence:payment-service-runbook";
    expect(cited((await ask("david", runbookQuestion)).body)).toContain(docId);
    const current = await request(`/v1/admin/permissions?docId=${docId}`, "maya");
    const native = current.body.permissions.native;
    const restricted = { ...current.body.permissions, native: { ...native,
      pageViewers: native.pageViewers.filter((email: string) => email !== "david@aspire.example") } };
    expect((await request("/v1/admin/permissions", "maya", {
      method: "POST", body: JSON.stringify({ docId, permissions: restricted })
    })).status).toBe(200);

    const after = await ask("david", runbookQuestion);
    expect(cited(after.body)).not.toContain(docId);
    expect(after.body.text).not.toContain("Step 1");
    const trace = await request(`/v1/trace?traceId=${after.body.traceId}`, "david");
    expect(JSON.stringify(trace.body)).not.toContain("payment-service-runbook");
    expect(JSON.stringify(trace.body)).not.toContain("Payment-service incident runbook");
    expect(cited((await ask("ravi", runbookQuestion)).body)).toContain(docId);
  });
});

describe("Scenario 5: audit inquiry", () => {
  it("reconstructs a user's payment-gateway activity over the last 30 days", async () => {
    const brain = new Brain();
    await brain.syncAll();
    await brain.query(brain.user("ravi")!, "Payment gateway operations");
    await brain.query(brain.user("ravi")!, "PAY-101 cutover");
    const result = searchAudit(brain.audit.entries, new URLSearchParams({
      q: "Show me everything user 'ravi' accessed related to the 'payment-gateway' Confluence space in the last 30 days"
    }), brain.users, new Date(), documents(brain));
    expect(result.filters).toMatchObject({ user: "ravi", source: "confluence", space: "payment-gateway" });
    expect(result.filters.from).toBeDefined();
    expect(questions(result.entries)).toEqual(["Payment gateway operations"]);
    expect(result.entries.some(entry => entry.type === "answer_returned" && typeof entry.data.answer === "string"))
      .toBe(true);
  });

  it("answers who retrieved a document, by title or ID", async () => {
    const brain = new Brain();
    await brain.syncAll();
    await brain.query(brain.user("ravi")!, "Payment gateway operations");
    await brain.query(brain.user("alex")!, "Executive milestones staged cutover decisions");
    for (const q of ["Who retrieved the Payment gateway operations page?", "who retrieved confluence:gateway-operations"]) {
      const result = searchAudit(brain.audit.entries, new URLSearchParams({ q }), brain.users, new Date(), documents(brain));
      expect(result.filters).toMatchObject({ doc: "confluence:gateway-operations" });
      expect(new Set(result.entries.filter(entry => entry.type === "context_sent").map(entry => entry.actor)))
        .toEqual(new Set(["ravi"]));
      expect(questions(result.entries)).toEqual(["Payment gateway operations"]);
    }
  });
});
