import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Brain } from "./brain.js";
import { createApiServer } from "./server.js";

async function brainWith() {
  const brain = new Brain();
  await brain.syncAll();
  return brain;
}
const cited = (answer: { citations: Array<{ docId: string }> }) => answer.citations.map(citation => citation.docId);

describe("catch-up with the generated company", () => {
  const demo = async () => {
    const brain = new Brain(undefined, { corpus: "demo" });
    await brain.syncAll();
    return brain;
  };

  it("points the intern to the intern overview, and Wei Ming to what is shared with Wei Ming", async () => {
    const brain = await demo();
    const titles = (answer: { citations: Array<{ docId: string }> }) =>
      answer.citations.map(citation => brain.index.documents.get(citation.docId)?.title);
    const intern = await brain.catchUp(brain.user("alex")!);
    if (intern.kind !== "question") throw new Error("Expected a question");
    expect(titles(intern.answer)).toContain("Intern overview: read first");
    const wei = brain.user("wei")!;
    const shared = await brain.catchUp(wei);
    if (shared.kind !== "question") throw new Error("Expected a question");
    expect(shared.answer.text).toContain("shared with Wei Ming");
    expect(shared.answer.text).toContain("Wei Ming will own");
    for (const docId of cited(shared.answer)) expect(brain.fga.check(wei, docId).allowed).toBe(true);
  });

  it("keeps a generated project's catch-up to that project, with its status and what is blocked", async () => {
    const brain = await demo();
    const david = brain.user("david")!;
    const result = await brain.catchUp(david, "PLAT");
    if (result.kind !== "question") throw new Error("Expected a question");
    const project = (await brain.workspace(david)).projects.find(item => item.key === "PLAT")!;
    expect(cited(result.answer).length).toBeGreaterThan(0);
    for (const docId of cited(result.answer)) expect(project.docIds).toContain(docId);
    expect(result.answer.text).toContain("Status: 62 of 80 build jobs now run on the new runner pool.");
    expect(result.answer.text).toContain("PLAT-1 is blocked because it waits on finance approval for the host order.");
    expect(result.answer.scope).toMatchObject({ project: "Build pipeline upgrade" });
  });
});

describe("catch-up by role and groups", () => {
  it("gives an intern an onboarding overview", async () => {
    const brain = await brainWith();
    const result = await brain.catchUp(brain.user("alex")!);
    expect(result).toMatchObject({ kind: "question",
      question: "What should a new hire read first: the overview, the milestones and the workflow guides?" });
    if (result.kind !== "question") throw new Error("Expected a question");
    expect(cited(result.answer)).toEqual(expect.arrayContaining(["drive:steering-deck", "drive:chargeback-guide"]));
  });

  it("tells someone in no group what is shared with them", async () => {
    const brain = await brainWith();
    const result = await brain.catchUp(brain.user("wei")!);
    expect(result).toMatchObject({ kind: "question", question: "What has been shared with Wei Ming, and what does Wei Ming own?" });
    if (result.kind !== "question") throw new Error("Expected a question");
    expect(cited(result.answer)).toEqual(["slack:vendor-integration"]);
  });

  it("gives a team member a project's status, blockers and decisions, from that project only", async () => {
    const brain = await brainWith();
    const david = brain.user("david")!;
    const result = await brain.catchUp(david, "DB");
    expect(result).toMatchObject({ kind: "question",
      question: "What is the status of Database migration plan, what are the blockers, and what was decided recently?" });
    if (result.kind !== "question") throw new Error("Expected a question");
    const project = (await brain.workspace(david)).projects.find(item => item.key === "DB")!;
    expect(cited(result.answer).length).toBeGreaterThan(0);
    for (const docId of cited(result.answer)) expect(project.docIds).toContain(docId);
    expect(cited(result.answer)).toContain("jira:DB-12");
    expect(result.answer.text).toContain("Blocker raised: the backfill job keeps timing out on the ledger database");
    expect(result.answer.scope).toMatchObject({ project: "Database migration plan" });
    // The asker's own trace says the answer kept to the project.
    expect(brain.audit.entries).toContainEqual(expect.objectContaining({ type: "query_planned",
      data: expect.objectContaining({ project: "Database migration plan" }) }));
  });

  it("ignores a project the person can't open", async () => {
    const brain = await brainWith();
    const maya = brain.user("maya")!;
    const page = (await brain.connectors.confluence.fetchPermissions("confluence:db-migration-plan"))!;
    const native = page.native as Extract<typeof page.native, { source: "confluence" }>;
    await brain.setNativePermissions(maya, "confluence:db-migration-plan", { ...page, native: { ...native,
      pageViewers: native.pageViewers!.filter(viewer => viewer !== "david@aspire.example") } });
    const david = brain.user("david")!;
    const named = await brain.catchUp(david, "DB");
    const plain = await brain.catchUp(david);
    expect(named.kind === "question" && named.question).toBe(plain.kind === "question" && plain.question);
    expect(named.kind === "question" && named.answer.scope?.project).toBeFalsy();
  });

  it("gives compliance the last week of the audit trail instead of a question", async () => {
    const brain = await brainWith();
    await brain.query(brain.user("ravi")!, "Payment gateway operations");
    const result = await brain.catchUp(brain.user("nur")!);
    expect(result.kind).toBe("audit");
    if (result.kind !== "audit") throw new Error("Expected the audit summary");
    expect(result.lines[0]).toBe("1 question in the last 7 days, from Ravi.");
    expect(result.lines).toContainEqual(expect.stringMatching(/^\d+ document checks? denied access\.$/));
    expect(result.lines.at(-1)).toMatch(/The chain verifies: yes\.$/);
  });
});

describe("catch-up route", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it("answers for the signed-in person", async () => {
    process.env.ALLOW_DEMO_AUTH = "true";
    const api = await createApiServer({ startOrchestrator: false });
    servers.push(api.server);
    await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
    const address = api.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const post = async (user: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/catch-up`, { method: "POST",
        headers: { "x-demo-user": user, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const alex = await post("alex", {});
    expect(alex.status).toBe(200);
    expect(alex.body).toMatchObject({ kind: "question", traceId: expect.any(String) });
    expect(alex.body.answer.citations.length).toBeGreaterThan(0);
    expect((await post("nur", {})).body).toMatchObject({ kind: "audit", lines: expect.any(Array) });
    expect((await post("david", { project: 42 })).status).toBe(400);
  });
});
