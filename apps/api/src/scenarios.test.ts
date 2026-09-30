import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { NO_RESULT } from "@brain/retrieval";
import type { AuditEntry } from "@brain/types";
import { Brain } from "./brain.js";
import { searchAudit } from "./audit-search.js";
import { createApiServer } from "./server.js";

// Worked scenarios from the challenge brief. Scenarios 1, 2 and 4 join this suite with their mock data.

const openServers: Server[] = [];

afterEach(async () => {
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
