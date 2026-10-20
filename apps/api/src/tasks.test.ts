import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { LiveConnector } from "@brain/connectors/live";
import { loadMockCorpus, MockConnector } from "@brain/connectors";
import { Brain, taskIsDone, type LiveJira } from "./brain.js";
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

describe("tasks with live sources and a connected Jira", () => {
  function fakeJira(overrides: Partial<LiveJira> = {}) {
    const created: Array<{ user: string; input: { project: string; summary: string; description: string } }> = [];
    const closed: string[] = [];
    const jira: LiveJira = {
      canCreate: async () => true,
      createIssue: async (user, input) => { created.push({ user: user.id, input }); return { key: "DB-77", url: "https://acme.atlassian.net/browse/DB-77" }; },
      markDone: async (_user, key) => { closed.push(key); return true; },
      ...overrides
    };
    return { jira, created, closed };
  }

  it("creates the reviewed task in Jira with only the summary and an operation marker, once", async () => {
    const live = await brainWith({ connectors: loadMockCorpus().connectors });
    const { jira, created } = fakeJira();
    live.liveJira = jira;
    const david = live.user("david")!;
    expect((await live.workspace(david)).capabilities).toMatchObject({ mode: "live", createTask: true, markDone: true });
    expect(await live.createTask(david, thread, sentence)).toEqual({ docId: "jira:DB-77", title: "DB-77 Maya raises the replica storage quota before the final wave" });
    expect(created).toHaveLength(1);
    expect(created[0].user).toBe("david");
    expect(created[0].input.project).toBe("DB");
    expect(created[0].input.summary).toBe("Maya raises the replica storage quota before the final wave");
    // Jira never receives the thread's text or name.
    expect(created[0].input.description).toMatch(/^Approved summary: Maya raises the replica storage quota before the final wave\nBroppy operation: [a-f0-9-]{36}$/);
    expect(created[0].input.description).not.toContain("db-migration");
    expect(live.audit.entries).toContainEqual(expect.objectContaining({ type: "task_created", actor: "david",
      data: expect.objectContaining({ docId: "jira:DB-77", fromDocId: thread, project: "DB" }) }));
    await expect(live.createTask(david, thread, sentence)).rejects.toThrow();
    expect(created).toHaveLength(1);
  });

  it("sends the reviewed owner and due date to Jira, and reports a field Jira went without", async () => {
    const live = await brainWith({ connectors: loadMockCorpus().connectors, slackUserIds: { maya: "UMAYA", david: "UDAVID" } });
    const { jira, created } = fakeJira({ createIssue: async (user, input) => {
      created.push({ user: user.id, input }); return { key: "DB-77", url: "https://acme.atlassian.net/browse/DB-77", omitted: ["due date"] };
    } });
    live.liveJira = jira;
    const david = live.user("david")!;
    const proposal = (await live.workspace(david)).suggestions[0];
    const edited = await live.reviewCommitment(david, { id: proposal.id, revision: proposal.revision, action: "edit",
      summary: "Raise the replica quota", ownerSlackId: "UMAYA", dueDate: "2026-11-03" });
    const result = await live.createTask(david, proposal.threadDocId, proposal.sentence, { proposalId: proposal.id, revision: edited.revision });
    const maya = live.user("maya")!;
    expect(created[0].input).toMatchObject({ assigneeEmail: maya.platformIdentities?.jira || maya.email, dueDate: "2026-11-03" });
    expect(result).toMatchObject({ docId: "jira:DB-77", omitted: ["due date"] });
  });

  it("refuses a person whose Jira account can't create there, and someone who can't open the thread", async () => {
    const live = await brainWith({ connectors: loadMockCorpus().connectors });
    const { jira, created } = fakeJira({ canCreate: async () => false });
    live.liveJira = jira;
    await expect(live.createTask(live.user("david")!, thread, sentence)).rejects.toThrow("can't create issues in that project");
    await expect(live.createTask(live.user("alex")!, thread, sentence)).rejects.toThrow("Unknown document");
    expect(created).toEqual([]);
  });

  it("lets a task Jira refused outright be tried again, since nothing was created", async () => {
    const live = await brainWith({ connectors: loadMockCorpus().connectors });
    let calls = 0;
    live.liveJira = fakeJira({ createIssue: async () => { calls++; if (calls === 1) throw Object.assign(new Error("Jira request failed (400)"), { status: 400 });
      return { key: "DB-77", url: "https://acme.atlassian.net/browse/DB-77" }; } }).jira;
    await expect(live.createTask(live.user("david")!, thread, sentence)).rejects.toThrow("Jira refused this task");
    expect(await live.createTask(live.user("david")!, thread, sentence)).toMatchObject({ docId: "jira:DB-77" });
    expect(calls).toBe(2);
  });

  it("blocks a retry when Jira's answer was lost, so a task is never created twice", async () => {
    const live = await brainWith({ connectors: loadMockCorpus().connectors });
    let calls = 0;
    live.liveJira = fakeJira({ createIssue: async () => { calls++; throw new Error("socket hang up"); } }).jira;
    await expect(live.createTask(live.user("david")!, thread, sentence)).rejects.toThrow("couldn't confirm");
    await expect(live.createTask(live.user("david")!, thread, sentence)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("marks a task done in Jira only for someone who can open it", async () => {
    const live = await brainWith({ connectors: loadMockCorpus().connectors });
    const { jira, closed } = fakeJira();
    live.liveJira = jira;
    await live.markDone(live.user("david")!, "jira:DB-15");
    expect(closed).toEqual(["DB-15"]);
    expect(live.audit.entries).toContainEqual(expect.objectContaining({ type: "task_status_changed", actor: "david" }));
    await expect(live.markDone(live.user("wei")!, "jira:DB-15")).rejects.toThrow("Unknown document");
    live.liveJira = fakeJira({ markDone: async () => false }).jira;
    await expect(live.markDone(live.user("ravi")!, "jira:DB-15")).rejects.toThrow("didn't let you");
    expect(closed).toEqual(["DB-15"]);
  });
});

describe("whether a task is done", () => {
  it("follows Jira's status category, so Closed and Released count and a status merely named Done-ish does not", () => {
    expect(taskIsDone({ status: "Released", statusCategory: "done" })).toBe(true);
    expect(taskIsDone({ status: "Done review", statusCategory: "indeterminate" })).toBe(false);
    expect(taskIsDone({ status: "done" })).toBe(true);
    expect(taskIsDone({ status: "open" })).toBe(false);
  });
});

async function tasksDemoApi() {
  process.env.ALLOW_DEMO_AUTH = "true";
  const api = await createApiServer({ startOrchestrator: false, corpus: "curated" });
  await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
  const port = (api.server.address() as { port: number }).port;
  const call = async (path: string, user: string, method = "GET", payload?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { "x-demo-user": user, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    const text = await response.text();
    return { status: response.status, text, body: text === "" ? undefined : JSON.parse(text) as unknown };
  };
  return { api, call };
}

/** Assignee data never reaches a client: C13 keeps it a non-representable state, so no response names it. */
const withoutAssigneeData = (text: string) => {
  expect(text.toLowerCase().includes("assignee")).toBe(false);
  expect(text.toLowerCase().includes("reporter")).toBe(false);
};

type ListBody = {
  snapshotId: string; dataSnapshotId: string; dataGenerationExpiresAt: string;
  summary: { open: number; dueThisWeek: number; overdue: number; doneThisWeek: { knownCount: number; historyComplete: boolean } };
  appliedFilters: Record<string, unknown>;
  freshness: { observedAt: string; authorizedAt: string; authorizationExpiresAt: string; dataComplete: boolean; refreshPending: boolean };
  items: Array<{ id: string; key: string; title: string; projectKey: string; projectName: string;
    status: { name: string; category: string | null }; dueDate: string | null; priority: string | null;
    updatedAt: string; url: string; mine: boolean }>;
  page: { nextCursor: string | null; hasMore: boolean; total: number };
  columns: Array<{ id: string; name: string; total: number; items: ListBody["items"]; nextCursor: string | null }>;
};

describe("the task workbench routes", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it("covers every sound facet (FT01, FT05, FT76): issues made directly in Jira import into the same list exactly once", async () => {
    const { api, call } = await tasksDemoApi();
    servers.push(api.server);
    const brain = api.brain;
    const david = brain.user("david")!;
    const maya = brain.user("maya")!;

    const peers = ["ravi@aspire.example", "maya@aspire.example", "david@aspire.example", "nur@aspire.example"];
    const permissions = { users: [], groups: ["payments"], public: false,
      native: { source: "jira" as const, projectKey: "OPS", projectViewers: peers, issueViewers: peers } };
    brain.connectors.jira.create({ docId: "jira:OPS-8", source: "jira", sourceNativeId: "OPS-8",
      title: "OPS-8 Made directly in Jira", content: "OPS-8 was made directly in Jira, not through a suggestion.",
      url: "https://jira.example/browse/OPS-8", version: 1, updatedAt: new Date().toISOString(),
      metadata: { project: "OPS", status: "open" }, permissions, tier: "internal", links: [] });
    await brain.sync("jira");
    const direct = (await call("/v1/tasks", "ravi")).body as ListBody;
    expect(direct.page.total).toBe(8);
    expect(direct.items.filter(item => item.id.startsWith("jira:OPS-")).map(item => item.id))
      .toEqual(["jira:OPS-3", "jira:OPS-8"]);
    expect(direct.items.filter(item => item.id === "jira:OPS-8")).toHaveLength(1);
    withoutAssigneeData(direct.items.map(item => item.id).join(","));

    // A reviewed proposal's owner, not the creator, is whom "mine" means.
    const proposal = (await brain.workspace(david)).suggestions.find(item => item.threadDocId === thread)!;
    const edited = await brain.reviewCommitment(david, { id: proposal.id, revision: proposal.revision, action: "edit",
      summary: proposal.summary, ownerSlackId: maya.platformIdentities?.slack, dueDate: "2026-10-30" });
    const created = await call("/v1/tasks", "david", "POST",
      { threadDocId: thread, sentence: proposal.sentence, proposalId: proposal.id, revision: edited.revision });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ docId: "jira:DB-16" });

    const mayaList = await call("/v1/tasks", "maya");
    const mayaBody = mayaList.body as ListBody;
    expect((mayaList.text.match(/jira:DB-16/g) ?? []).length).toBe(1);
    expect(mayaBody.page.total).toBe(7);
    expect(mayaBody.appliedFilters).toMatchObject({ view: "list", projectIds: [], mine: false, due: "any",
      summaryPreset: null, sort: "dueAsc", timezone: "UTC", limit: 50 });
    const db16 = mayaBody.items.find(item => item.id === "jira:DB-16")!;
    expect(db16).toMatchObject({ mine: true, dueDate: "2026-10-30", status: { name: "open", category: "new" },
      projectKey: "DB", priority: null });
    withoutAssigneeData(JSON.stringify(mayaList));
    const davidView = (await call("/v1/tasks", "wei")).body as ListBody;
    expect(davidView.page.total).toBe(0);
    withoutAssigneeData(JSON.stringify(davidView));

    // A field nobody authorized uses: a 400 that names the field, never an empty page.
    const unknownFacet = await call("/v1/tasks?priorityIds=Huge", "david");
    expect(unknownFacet.status).toBe(400);
    expect(unknownFacet.body).toMatchObject({ error: { code: "INVALID_QUERY", fieldErrors: { priorityIds: expect.any(String) } } });
    const unknownField = await call("/v1/tasks?glue=1", "david");
    expect(unknownField.status).toBe(400);
    expect(unknownField.body).toMatchObject({ error: { code: "UNKNOWN_FIELD", fieldErrors: { glue: expect.any(String) } } });
    const assigneeFilter = await call("/v1/tasks?assigneeIds=someone", "david");
    expect(assigneeFilter.status).toBe(400);
  });

  it("composes project, due and priority filters into exactly the independently expected sets (FT05)", async () => {
    const demo = await tasksDemoApi();
    servers.push(demo.api.server);
    const mayaDb = (await demo.call("/v1/tasks?projectIds=DB", "maya")).body as ListBody;
    expect(mayaDb.items.map(item => item.key)).toEqual(["DB-15", "DB-12"]);
    withoutAssigneeData(JSON.stringify(mayaDb));
    const undated = (await demo.call("/v1/tasks?due=none", "maya")).body as ListBody;
    expect(undated.items.map(item => item.key)).toEqual(["DB-12", "REL-9", "SETL-27"]);
    const critical = (await demo.call("/v1/tasks?projectIds=DB&priorityIds=Critical", "maya")).body as ListBody;
    expect(critical.items.map(item => item.key)).toEqual(["DB-15"]);
    expect(critical.page.total).toBe(1);
    const hiddenProject = await demo.call("/v1/tasks?projectIds=SEC", "maya");
    expect(hiddenProject.status).toBe(400);
    const davidSeesSecurity = (await demo.call("/v1/tasks?projectIds=SEC&priorityIds=Highest", "david")).body as ListBody;
    expect(davidSeesSecurity.items.map(item => item.key)).toEqual(["SEC-44"]);
    const projects = (await demo.call("/v1/tasks/projects", "maya")).body as { projects: Array<{ key: string }> };
    expect(projects.projects.map(project => project.key)).toEqual(["DB", "PAY", "REL", "SETL"]);
  });

  it("answers hidden, missing, malformed and unresolved with the same 404 bytes (FT17, C12)", async () => {
    const demo = await tasksDemoApi();
    servers.push(demo.api.server);
    const paths = ["/v1/tasks/jira/NO-SUCH-1", "/v1/tasks/jira/SEC-44",
      "/v1/tasks/resolve?docId=jira:NO-SUCH-1", "/v1/tasks/resolve?docId=jira:SEC-44", "/v1/tasks/jira/not-a-key"];
    const responses = await Promise.all(paths.map(path => demo.call(path, "maya")));
    for (const response of responses) expect(response.status).toBe(404);
    expect(new Set(responses.map(response => response.text)).size).toBe(1);
    expect(responses[0].body).toMatchObject({ error: { code: "TASK_UNAVAILABLE", retryable: false } });

    const detail = await demo.call("/v1/tasks/jira/PAY-101", "maya");
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: "jira:PAY-101", key: "PAY-101",
      description: "PAY-101 tracks the payment cutover. Complete SEC-44 failover verification before production traffic moves.",
      status: { name: "in review", category: "indeterminate" }, dueDate: "2026-10-23", priority: "High", mine: false });
    expect((detail.body as { links: Array<{ id: string }> }).links.map(link => link.id).sort())
      .toEqual(["confluence:payment-master", "drive:cutover-plan", "slack:payments-cutover"]);
    withoutAssigneeData(detail.text);
    const resolved = await demo.call("/v1/tasks/resolve?docId=PAY-101", "maya");
    expect(resolved.body).toEqual({ id: "jira:PAY-101" });
  });

  it("binds a cursor to the actor, the query and the data generation", async () => {
    const { api, call } = await tasksDemoApi();
    servers.push(api.server);
    const first = (await call("/v1/tasks?limit=2", "maya")).body as ListBody;
    expect(first.page.hasMore).toBe(true);
    const cursor = first.page.nextCursor!;
    expect((await call(`/v1/tasks?limit=2&cursor=${cursor}`, "david")).status).toBe(400);
    expect((await call(`/v1/tasks?limit=3&cursor=${cursor}`, "maya")).status).toBe(400);
    await api.brain.blockUser(api.brain.user("maya")!, "jira:REL-9", "david");
    const stale = await call(`/v1/tasks?limit=2&cursor=${cursor}`, "maya");
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: "SNAPSHOT_EXPIRED" } });
    const fresh = (await call("/v1/tasks?limit=2", "maya")).body as ListBody;
    expect(fresh.page.total).toBe(5);
    expect(fresh.page.nextCursor).toBeTruthy();
  });
});

describe("counting a corpus larger than a page (FT10)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it("counts tiles and columns across every authorized row, past the page size", async () => {
    const fixture = loadMockCorpus();
    const peers = ["ravi@aspire.example", "maya@aspire.example", "david@aspire.example", "nur@aspire.example"];
    const synth = (i: number) => ({ docId: `jira:SYN-${i}`, source: "jira" as const, sourceNativeId: `SYN-${i}`,
      title: `SYN-${i} Workstream ${i}`, content: `SYN-${i} tracks workstream ${i}.`,
      url: `https://jira.example/browse/SYN-${i}`, version: 1,
      updatedAt: new Date(Date.parse("2026-09-20T00:00:00.000Z") + i * 60_000).toISOString(),
      metadata: { project: "SYN", status: i <= 10 ? "open" : i <= 71 ? "in progress" : "released" },
      permissions: { users: [], groups: ["payments"], public: false,
        native: { source: "jira" as const, projectKey: "SYN", projectViewers: peers, issueViewers: peers } },
      tier: "internal" as const, links: [] });
    const base = await fixture.connectors.jira.listItems();
    const jira = new MockConnector("jira", [...base, ...Array.from({ length: 80 }, (_, index) => synth(index + 1))]);
    const brain = new Brain(undefined, { users: fixture.users, connectors: { ...fixture.connectors, jira } });
    await brain.syncAll();
    process.env.ALLOW_DEMO_AUTH = "true";
    const api = await createApiServer({ brain, startOrchestrator: false });
    servers.push(api.server);
    await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
    const port = (api.server.address() as { port: number }).port;
    const call = async (path: string, user: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-demo-user": user } });
      const text = await response.text();
      return { status: response.status, text, body: text === "" ? undefined : JSON.parse(text) as unknown };
    };

    const list = (await call("/v1/tasks", "david")).body as ListBody;
    expect(list.page.total).toBe(86);
    expect(list.items).toHaveLength(50);
    expect(list.items[0].key).toBe("DB-15");
    expect(list.page.hasMore).toBe(true);
    expect(list.summary.open).toBe(76);
    expect(list.summary.overdue).toBeGreaterThanOrEqual(1);
    expect(list.freshness.dataComplete).toBe(true);
    withoutAssigneeData(JSON.stringify(list));
    const second = (await call(`/v1/tasks?cursor=${list.page.nextCursor}`, "david")).body as ListBody;
    expect(second.items).toHaveLength(36);
    expect(second.page.hasMore).toBe(false);

    const board = (await call("/v1/tasks?view=board", "david")).body as ListBody;
    expect(board.items).toEqual([]);
    expect(board.columns.map(column => [column.id, column.total])).toEqual(
      [["todo", 12], ["in-progress", 64], ["done", 10], ["unmapped", 0]]);
    const busy = board.columns.find(column => column.id === "in-progress")!;
    expect(busy.items).toHaveLength(50);
    expect(busy.items[0].key).toBe("DB-15");
    expect(busy.nextCursor).toBeTruthy();
    const continued = (await call(`/v1/tasks?view=board&cursor=${busy.nextCursor}`, "david")).body as ListBody;
    expect(continued.columns.map(column => column.id)).toEqual(["in-progress"]);
    expect(continued.columns[0].items).toHaveLength(14);
    expect(continued.columns[0].nextCursor).toBeNull();
    const wei = (await call("/v1/tasks", "wei")).body as ListBody;
    expect(wei.page.total).toBe(0);
    expect(wei.summary.open).toBe(0);
    withoutAssigneeData(JSON.stringify(wei));
  });
});

describe("the task workbench under live sources", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  function liveJiraBrain() {
    const fixture = loadMockCorpus();
    let delegatedStatus = 200;
    const issue = () => ({ id: "10001", fields: { summary: "PAY-101 Cutover",
      description: { content: [{ text: "Cutover requires approval." }] }, updated: "2026-10-05T09:00:00.000Z",
      status: { name: "Open", statusCategory: { key: "indeterminate" } }, project: { key: "PAY" },
      duedate: "2026-10-23", priority: { name: "High" } } });
    const transport = async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Headers(init?.headers).get("authorization") === "Bearer user" && delegatedStatus !== 200
        ? new Response("", { status: delegatedStatus })
        : Response.json(issue());
    const jira = new LiveConnector("jira", { ids: ["PAY-101"], baseUrl: "https://atlassian.example.test/",
      serviceAuthorization: "Bearer service", userAuthorizations: { ravi: "Bearer user" } }, fixture.users, transport,
      async () => undefined);
    const brain = new Brain(undefined, { users: fixture.users, connectors: { ...fixture.connectors, jira } });
    return { brain, fail: (status: number) => { delegatedStatus = status; }, recover: () => { delegatedStatus = 200; } };
  }

  it("authorizes list pages from the synced index while the detail still asks the source (C2)", async () => {
    const fx = liveJiraBrain();
    process.env.ALLOW_DEMO_AUTH = "true";
    const api = await createApiServer({ brain: fx.brain, startOrchestrator: false });
    servers.push(api.server);
    await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
    const port = (api.server.address() as { port: number }).port;
    const call = async (path: string, user: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-demo-user": user } });
      const text = await response.text();
      return { status: response.status, text, body: text === "" ? undefined : JSON.parse(text) as unknown };
    };

    const healthy = (await call("/v1/tasks", "ravi")).body as ListBody;
    expect(healthy.page.total).toBe(1);
    expect(healthy.items[0]).toMatchObject({ id: "jira:PAY-101", projectKey: "PAY",
      status: { name: "Open", category: "indeterminate" }, dueDate: "2026-10-23", priority: "High" });
    expect(((await call("/v1/tasks", "maya")).body as ListBody).page.total).toBe(0);
    expect((await call("/v1/tasks/jira/PAY-101", "ravi")).status).toBe(200);

    fx.fail(503);
    const outage = await call("/v1/tasks", "ravi");
    expect(outage.status).toBe(200);
    expect((outage.body as ListBody).page.total).toBe(1);
    const hidden = await call("/v1/tasks/jira/PAY-101", "ravi");
    expect(hidden.status).toBe(404);
    expect(hidden.body).toMatchObject({ error: { code: "TASK_UNAVAILABLE" } });
    fx.recover();
    expect((await call("/v1/tasks/jira/PAY-101", "ravi")).status).toBe(200);
  });
});
