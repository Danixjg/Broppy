import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { loadMockCorpus } from "@brain/connectors";
import { Brain } from "./brain.js";
import type { Persistence } from "./persistence.js";
import { createApiServer } from "./server.js";

const thread = "slack:db-migration";
const sentence = "Agreed: Maya raises the replica storage quota before the final wave.";

async function brainWith(options: ConstructorParameters<typeof Brain>[1] = {}) {
  const brain = new Brain(undefined, options);
  await brain.syncAll();
  return brain;
}
const visibleTo = async (brain: Brain, userId: string, docId: string) =>
  (await brain.visibleDocuments(brain.user(userId)!)).some(doc => doc.docId === docId);

describe("a Jira task from an agreement", () => {
  it("is created in the thread's project from the agreed sentence, for the project's members only", async () => {
    const brain = await brainWith();
    const david = brain.user("david")!;
    expect(await brain.createTask(david, thread, sentence))
      .toEqual({ docId: "jira:DB-16", title: "DB-16 Maya raises the replica storage quota before the final wave" });
    const issue = brain.index.documents.get("jira:DB-16")!;
    expect(issue.content).toBe(`DB-16 tracks the agreement in #db-migration: "${sentence}"`);
    expect(issue.metadata).toEqual({ project: "DB", status: "open" });
    expect(issue.links).toContain(thread);
    // It copies the permissions of DB-15, the issue the thread links to.
    expect(issue.permissions).toEqual(brain.index.documents.get("jira:DB-15")!.permissions);
    for (const member of ["david", "ravi", "maya", "nur"]) expect(await visibleTo(brain, member, "jira:DB-16")).toBe(true);
    for (const outsider of ["wei", "alex"]) expect(await visibleTo(brain, outsider, "jira:DB-16")).toBe(false);
    expect(brain.audit.entries).toContainEqual(expect.objectContaining({ type: "task_created", actor: "david",
      data: expect.objectContaining({ docId: "jira:DB-16", fromDocId: thread, project: "DB" }) }));

    // The suggestion is gone, and asking again is refused.
    expect((await brain.workspace(david)).suggestions).toEqual([]);
    await expect(brain.createTask(david, thread, sentence)).rejects.toThrow("Already tracked");
  });

  it("is not readable by someone who lost access to the thread it quotes", async () => {
    const brain = await brainWith();
    await brain.removeSlackMember(brain.user("maya")!, thread, "nur");
    expect(await visibleTo(brain, "nur", thread)).toBe(false);
    await brain.createTask(brain.user("david")!, thread, sentence);
    expect(await visibleTo(brain, "nur", "jira:DB-16")).toBe(false);
    expect(await visibleTo(brain, "david", "jira:DB-16")).toBe(true);
  });

  it("is refused to someone who can't open the thread, for text that isn't an agreement, and on live sources", async () => {
    const brain = await brainWith();
    await expect(brain.createTask(brain.user("alex")!, thread, sentence)).rejects.toThrow("Unknown document");
    await expect(brain.createTask(brain.user("alex")!, "slack:no-such-thread", sentence)).rejects.toThrow("Unknown document");
    await expect(brain.createTask(brain.user("david")!, thread, "Agreed: ship everything today.")).rejects.toThrow("Not an agreement");
    await expect(brain.createTask(brain.user("david")!, thread,
      "Database migration project standup: waves one and two of the ledger move are complete.")).rejects.toThrow("Not an agreement");
    const live = await brainWith({ connectors: loadMockCorpus().connectors });
    await expect(live.createTask(live.user("david")!, thread, sentence)).rejects.toThrow("Live sources are read-only");
    expect(brain.index.documents.has("jira:DB-16")).toBe(false);
  });

  it("survives a restart with saved state", async () => {
    let snapshot: unknown;
    const persistence = { loadState: async () => structuredClone(snapshot), saveState: async (value: unknown) => { snapshot = structuredClone(value); } } as Persistence;
    const brain = await brainWith({ persistence });
    await brain.createTask(brain.user("david")!, thread, sentence);
    await brain.persist();
    const restored = new Brain(undefined, { persistence });
    await restored.restore();
    await restored.syncAll();
    expect(restored.index.documents.get("jira:DB-16")?.title).toBe("DB-16 Maya raises the replica storage quota before the final wave");
  });
});

describe("Mark done", () => {
  it("closes a Jira task the person can open, as a metadata change", async () => {
    const brain = await brainWith();
    const before = brain.index.embeddingRefreshes;
    const version = brain.index.documents.get("jira:DB-15")!.version;
    await brain.markDone(brain.user("david")!, "jira:DB-15");
    const issue = brain.index.documents.get("jira:DB-15")!;
    expect(issue.metadata.status).toBe("done");
    expect(issue.version).toBe(version + 1);
    expect(brain.index.embeddingRefreshes).toBe(before);
    expect(brain.audit.entries).toContainEqual(expect.objectContaining({ type: "task_status_changed", actor: "david",
      data: expect.objectContaining({ docId: "jira:DB-15", status: "done" }) }));
    // Asking again changes nothing.
    await brain.markDone(brain.user("david")!, "jira:DB-15");
    expect(brain.index.documents.get("jira:DB-15")!.version).toBe(version + 1);
  });

  it("is refused for an issue the person can't open, for anything but a Jira task, and on live sources", async () => {
    const brain = await brainWith();
    await expect(brain.markDone(brain.user("wei")!, "jira:DB-15")).rejects.toThrow("Unknown document");
    await expect(brain.markDone(brain.user("david")!, "slack:db-migration")).rejects.toThrow("Only Jira tasks");
    const live = await brainWith({ connectors: loadMockCorpus().connectors });
    await expect(live.markDone(live.user("david")!, "jira:DB-15")).rejects.toThrow("Live sources are read-only");
    expect(brain.index.documents.get("jira:DB-15")!.metadata.status).toBe("blocked");
  });
});

describe("task routes", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it("create and close tasks for the signed-in person, with clear refusals", async () => {
    process.env.ALLOW_DEMO_AUTH = "true";
    const api = await createApiServer({ startOrchestrator: false });
    servers.push(api.server);
    await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
    const address = api.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const post = async (path: string, user: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST",
        headers: { "x-demo-user": user, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    expect(await post("/v1/tasks", "david", { threadDocId: thread, sentence }))
      .toEqual({ status: 201, body: { docId: "jira:DB-16", title: "DB-16 Maya raises the replica storage quota before the final wave" } });
    expect((await post("/v1/tasks", "david", { threadDocId: thread, sentence })).status).toBe(409);
    expect((await post("/v1/tasks", "alex", { threadDocId: thread, sentence })).status).toBe(404);
    expect((await post("/v1/tasks", "david", { threadDocId: thread })).status).toBe(400);
    expect(await post("/v1/tasks/done", "david", { docId: "jira:DB-16" })).toEqual({ status: 200, body: { ok: true } });
    expect((await post("/v1/tasks/done", "wei", { docId: "jira:DB-16" })).status).toBe(404);
  });
});
