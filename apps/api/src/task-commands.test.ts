import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { loadMockCorpus } from "@brain/connectors";
import { Brain, type LiveJira } from "./brain.js";
import { createApiServer } from "./server.js";
import { CommandRejection, MemoryTaskCommandStore, parseEditFields, parseTransitionCommand,
  type EditFields } from "./task-commands.js";
import type { SourceOAuth } from "./source-oauth.js";

process.env.ALLOW_DEMO_AUTH = "true";

type Call = (path: string, user: string, method?: string, payload?: unknown, headers?: Record<string, string>) =>
  Promise<{ status: number; text: string; body: unknown }>;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function demoApi(corpus: "curated" = "curated") {
  const api = await createApiServer({ startOrchestrator: false, corpus });
  servers.push(api.server);
  await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
  const port = (api.server.address() as { port: number }).port;
  const call: Call = async (path, user, method = "GET", payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { "x-demo-user": user, "content-type": "application/json", ...headers },
      ...(method === "PUT" || method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}) });
    const text = await response.text();
    return { status: response.status, text, body: text === "" ? undefined : JSON.parse(text) as unknown };
  };
  return { api, call };
}

/** Counts the demo writer's dispatches, so a replay or a refusal is provable by its absence. */
function countDispatches(brain: Brain): { dispatches: () => number } {
  const jira = brain.connectors.jira as unknown as Record<"updateMetadata" | "updateDocument",
    (id: string, fields: unknown) => void>;
  let count = 0;
  const realMeta = jira.updateMetadata.bind(jira);
  const realDoc = jira.updateDocument.bind(jira);
  jira.updateMetadata = (id, fields) => { count++; realMeta(id, fields as Record<string, string>); };
  jira.updateDocument = (id, fields) => { count++; realDoc(id, fields as { metadata?: Record<string, string> }); };
  return { dispatches: () => count };
}

const currentRevision = async (call: Call, key: string): Promise<string> =>
  ((await call(`/v1/tasks/jira/${key}`, "maya")).body as { revision: string }).revision;

const put = (call: Call, key: string, user: string, fields: EditFields | { transitionId: string; fields: Record<string, string> },
  extra: { key?: string; id?: string; revision?: string } = {}) =>
  call(`/v1/tasks/jira/${key}${"transitionId" in fields ? "/transitions" : ""}`, user,
    "transitionId" in fields ? "POST" : "PUT",
    { clientIntentId: extra.id ?? "intent-1", ...("transitionId" in fields ? fields : { fields }) },
    { "idempotency-key": extra.key ?? "key-1", "if-match": extra.revision ?? "" });

describe("field edits through the command path (FT18-FT22, FT48)", () => {
  it("applies one requested field to Jira's issue and refreshes the views (FT18)", async () => {
    const { call } = await demoApi();
    const before = await currentRevision(call, "DB-12");
    const receipt = (await put(call, "DB-12", "maya", { summary: "Ledger migration, wave one" }, { revision: before })).body as
      { operationId: string; state: string; task: { title: string; revision: string; dueDate: string | null; status: { name: string } } };
    expect(receipt.state).toBe("applied");
    expect(receipt.task.title).toBe("Ledger migration, wave one");
    expect(receipt.task.dueDate).toBeNull();
    expect(receipt.task.status.name).toBe("in progress");
    expect(receipt.task.revision).not.toBe(before);
    const fresh = (await call("/v1/tasks/jira/DB-12", "maya")).body as { revision: string; description: string };
    expect(fresh.revision).toBe(receipt.task.revision);
    expect(fresh.description).toContain("ledger database migr");
    expect(await currentRevision(call, "DB-15")).toBe("task-r2");
  });

  it("sets, changes, clears and leaves omitted fields alone (FT19)", async () => {
    const { call } = await demoApi();
    let revision = await currentRevision(call, "DB-12");
    await put(call, "DB-12", "maya", { dueDate: "2026-11-02" }, { revision, id: "i1", key: "k1" });
    expect(((await call("/v1/tasks/jira/DB-12", "maya")).body as { dueDate: string }).dueDate).toBe("2026-11-02");
    revision = await currentRevision(call, "DB-12");
    await put(call, "DB-12", "maya", { dueDate: "2026-11-03" }, { revision, id: "i2", key: "k2" });
    expect(((await call("/v1/tasks/jira/DB-12", "maya")).body as { dueDate: string }).dueDate).toBe("2026-11-03");
    revision = await currentRevision(call, "DB-12");
    const cleared = (await put(call, "DB-12", "maya", { dueDate: null }, { revision, id: "i3", key: "k3" })).body as { task: { dueDate: string | null } };
    expect(cleared.task.dueDate).toBeNull();
    revision = await currentRevision(call, "DB-12");
    await put(call, "DB-12", "maya", { priority: "Low" }, { revision, id: "i4", key: "k4" });
    expect(((await call("/v1/tasks/jira/DB-12", "maya")).body as { dueDate: string | null }).dueDate).toBeNull();
  });

  it("assigns an active person and refuses a target nobody can assign (FT20)", async () => {
    const { call } = await demoApi();
    let revision = await currentRevision(call, "DB-12");
    const assigned = (await put(call, "DB-12", "maya", { assignee: "ravi@aspire.example" }, { revision, id: "i1", key: "k1" })).body as { state: string };
    expect(assigned.state).toBe("applied");
    revision = await currentRevision(call, "DB-12");
    const inactive = await put(call, "DB-12", "maya", { assignee: "nobody@aspire.example" }, { revision, id: "i2", key: "k2" });
    expect(inactive.status).toBe(422);
    expect((inactive.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.assignee)
      .toBe("Nobody with that Jira identity is active in this workspace.");
    revision = await currentRevision(call, "DB-12");
    const unassign = await put(call, "DB-12", "maya", { assignee: null }, { revision, id: "i3", key: "k3" });
    expect(unassign.status).toBe(200);
  });

  it("keeps priority names and label lists intact on the round trip (FT21, FT22)", async () => {
    const { call } = await demoApi();
    let revision = await currentRevision(call, "DB-12");
    await put(call, "DB-12", "maya", { priority: "Medium" }, { revision, id: "i1", key: "k1" });
    expect(((await call("/v1/tasks/jira/DB-12", "maya")).body as { priority: string }).priority).toBe("Medium");
    revision = await currentRevision(call, "DB-12");
    const labels = (await put(call, "DB-12", "maya", { labels: ["db-migration", "wave-2"] }, { revision, id: "i2", key: "k2" })).body as { state: string };
    expect(labels.state).toBe("applied");
    revision = await currentRevision(call, "DB-12");
    await put(call, "DB-12", "maya", { labels: [] }, { revision, id: "i3", key: "k3" });
    const unknown = await put(call, "DB-12", "maya", { notAField: "x" } as unknown as EditFields, { revision, id: "i4", key: "k4" });
    expect(unknown.status).toBe(400);
    const statusEdit = await put(call, "DB-12", "maya", { status: "done" } as unknown as EditFields, { revision, id: "i5", key: "k5" });
    expect(statusEdit.status).toBe(400);
    expect(((statusEdit.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.status)).toContain("transitions");
  });

  it("keeps a stale baseline from reaching Jira and names the current revision (FT48)", async () => {
    const { api, call } = await demoApi();
    const { dispatches } = countDispatches(api.brain);
    const stale = await put(call, "DB-12", "maya", { summary: "Too late" }, { revision: "task-r1" });
    expect(stale.status).toBe(412);
    expect(((stale.body as { currentRevision: string }).currentRevision)).toBe("task-r4");
    expect(((stale.body as { error: { code: string } }).error.code)).toBe("TASK_CHANGED");
    expect(dispatches()).toBe(0);
    const noMatch = await call("/v1/tasks/jira/DB-12", "maya", "PUT", { clientIntentId: "i", fields: { summary: "x" } }, { "idempotency-key": "k" });
    expect(noMatch.status).toBe(428);
    const noKey = await call("/v1/tasks/jira/DB-12", "maya", "PUT", { clientIntentId: "i", fields: { summary: "x" } }, { "if-match": "task-r4" });
    expect(noKey.status).toBe(400);
    expect(((noKey.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.idempotencyKey)).toBeTruthy();
  });
});

describe("legal transitions (FT24-FT27)", () => {
  it("lists the moves the current state allows, resolution required for done (FT24 metadata)", async () => {
    const { call } = await demoApi();
    const choices = (await call("/v1/tasks/jira/DB-12/transitions", "maya")).body as { taskRevision: string; transitions: Array<{ id: string; target: { name: string; category: string }; fields: Array<{ id: string; required: boolean }> }> };
    expect(choices.transitions.map(item => item.id)).toEqual(["41", "51", "31", "91"]);
    const done = choices.transitions.find(item => item.id === "31")!;
    expect(done.target.category).toBe("done");
    expect(done.fields).toEqual([{ id: "resolutionId", name: "Resolution", type: "option", required: true, supported: true, allowedValues: [{ id: "1", name: "Done" }] }]);
    expect(choices.taskRevision).toBe(await currentRevision(call, "DB-12"));
    const blocked = ((await call("/v1/tasks/jira/DB-15/transitions", "maya")).body as { transitions: Array<{ id: string }> }).transitions.map(item => item.id);
    expect(blocked).toEqual(["71"]);
  });

  it("moves a task through the exact transition id, then reads the new state back (FT24)", async () => {
    const { call } = await demoApi();
    const revision = await currentRevision(call, "SETL-27");
    const receipt = (await put(call, "SETL-27", "maya", { transitionId: "21", fields: {} }, { revision })).body as
      { state: string; task: { status: { name: string; category: string } } };
    expect(receipt.state).toBe("applied");
    expect(receipt.task.status).toEqual({ name: "in progress", category: "indeterminate" });
    expect(((await call("/v1/tasks/jira/SETL-27", "maya")).body as { status: { name: string } }).status.name).toBe("in progress");
  });

  it("offers every legal done move and refuses a write Jira would not take (FT25)", async () => {
    const { api, call } = await demoApi();
    const { dispatches } = countDispatches(api.brain);
    const choices = ((await call("/v1/tasks/jira/DB-12/transitions", "maya")).body as { transitions: Array<{ id: string; target: { category: string } }> })
      .transitions.filter(item => item.target.category === "done").map(item => item.id);
    expect(choices).toEqual(["31", "91"]);
    const illegal = await put(call, "DB-15", "maya", { transitionId: "31", fields: { resolutionId: "1" } }, { revision: "task-r2" });
    expect(illegal.status).toBe(409);
    expect((illegal.body as { transitions: Array<{ id: string }> }).transitions.map(item => item.id)).toEqual(["71"]);
    expect(dispatches()).toBe(0);
    const done = await currentRevision(call, "REL-9");
    expect(done).toBe("task-r1");
    const nothing = await put(call, "REL-9", "maya", { transitionId: "31", fields: { resolutionId: "1" } }, { revision: done, id: "i2", key: "k2" });
    expect(nothing.status).toBe(409);
    expect((nothing.body as { transitions: unknown[] }).transitions).toEqual([]);
    expect(dispatches()).toBe(0);
  });

  it("collects the required resolution before Jira sees the transition (FT26)", async () => {
    const { call } = await demoApi();
    let revision = await currentRevision(call, "DB-12");
    const missing = await put(call, "DB-12", "maya", { transitionId: "31", fields: {} }, { revision, id: "i1", key: "k1" });
    expect(missing.status).toBe(422);
    expect((missing.body as { error: { fieldErrors: Record<string, string>; code: string } }).error).toMatchObject({ code: "FIELD_VALIDATION_FAILED" });
    revision = await currentRevision(call, "DB-12");
    const done = (await put(call, "DB-12", "maya", { transitionId: "31", fields: { resolutionId: "1" } }, { revision, id: "i2", key: "k2" })).body as
      { state: string; task: { status: { name: string; category: string } } };
    expect(done.state).toBe("applied");
    expect(done.task.status).toEqual({ name: "released", category: "done" });
  });

  it("refuses a stale transition and returns the refreshed choices (FT27)", async () => {
    const { api, call } = await demoApi();
    const { dispatches } = countDispatches(api.brain);
    const revision = await currentRevision(call, "DB-15");
    const stale = await put(call, "DB-15", "maya", { transitionId: "21", fields: {} }, { revision });
    expect(stale.status).toBe(409);
    expect((stale.body as { transitions: Array<{ id: string }> }).transitions.map(item => item.id)).toEqual(["71"]);
    expect(dispatches()).toBe(0);
  });
});

describe("one operation per intent (FT34-FT37)", () => {
  it("replays the same key with the same content as the same receipt, dispatching once (FT34)", async () => {
    const { api, call } = await demoApi();
    const { dispatches } = countDispatches(api.brain);
    const revision = await currentRevision(call, "DB-12");
    const first = await put(call, "DB-12", "maya", { priority: "Low" }, { revision });
    const second = await put(call, "DB-12", "maya", { priority: "Low" }, { revision });
    expect(second.body).toEqual(first.body);
    expect(dispatches()).toBe(1);
  });

  it("refuses a key reused with different content, and dispatches nothing more (FT35)", async () => {
    const { api, call } = await demoApi();
    const { dispatches } = countDispatches(api.brain);
    const revision = await currentRevision(call, "DB-12");
    await put(call, "DB-12", "maya", { priority: "Low" }, { revision });
    const conflict = await put(call, "DB-12", "maya", { priority: "High" }, { revision, id: "intent-2" });
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: { code: string }; operationId: string }).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(dispatches()).toBe(1);
  });

  it("races two instances over one store: one dispatch, same receipt (FT36)", async () => {
    const shared = new MemoryTaskCommandStore();
    const first = await apiFor(shared);
    const second = await apiFor(shared);
    const revision1 = await currentRevision(first.call, "DB-12");
    const revision2 = await currentRevision(second.call, "DB-12");
    const counted1 = countDispatches(first.api.brain);
    const counted2 = countDispatches(second.api.brain);
    const [a, b] = await Promise.all([
      put(first.call, "DB-12", "maya", { priority: "Low" }, { revision: revision1 }),
      put(second.call, "DB-12", "maya", { priority: "Low" }, { revision: revision2 })]);
    expect((b.body as { operationId: string }).operationId).toBe((a.body as { operationId: string }).operationId);
    expect(a.status).toBe(200);
    expect((a.body as { state: string }).state).toBe("applied");
    expect(counted1.dispatches() + counted2.dispatches()).toBe(1);
  });

  it("keeps an issue blocked and unverifiable writes uncertain, never re-dispatched (FT37)", async () => {
    const { api, call } = await demoApi();
    const brain = api.brain;
    const { dispatches } = countDispatches(brain);
    const revision = await currentRevision(call, "DB-12");
    const jira = brain.connectors.jira as unknown as { updateDocument: (id: string, fields: { metadata?: Record<string, string>; title?: string }) => void };
    const real = jira.updateDocument.bind(jira);
    jira.updateDocument = (id, fields) => { if (id === "jira:DB-12") throw new Error("instance died mid-write"); real(id, fields); };
    const lost = await put(call, "DB-12", "maya", { priority: "Low" }, { revision });
    expect(lost.status).toBe(202);
    expect((lost.body as { state: string }).state).toBe("uncertain");
    const blocked = await put(call, "DB-12", "maya", { priority: "High" }, { id: "intent-2", key: "key-2", revision: "task-r4" });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error: { code: string }; operationId: string }).error.code).toBe("OPERATION_IN_PROGRESS");
    const receipt = (await call("/v1/task-operations/" + (lost.body as { operationId: string }).operationId, "maya")).body as
      { operationId: string; state: string; taskUnavailable?: boolean };
    expect(receipt.state).toBe("uncertain");
    expect(dispatches()).toBe(0);
    const still = await brain.settleUncertain(brain.user("maya")!, (lost.body as { operationId: string }).operationId);
    expect(still.status).toBe("uncertain");
  });

  it("flips an expired executing lease to uncertain and keeps the issue behind its barrier (FT37)", async () => {
    const store = new MemoryTaskCommandStore();
    const holder = (await store.reserve({ orgId: "o", actorId: "a", idempotencyKey: "k", intentId: "i", payloadHash: "h", issueKey: "jira:X" })) as
      { kind: "new"; operation: { id: string; state: string } };
    expect(await store.claimLease("jira:X", holder.operation.id, 1_000)).toEqual({ kind: "claimed" });
    await store.advanceCommand(holder.operation.id, "reserved", { state: "executing" });
    const loser = (await store.reserve({ orgId: "o", actorId: "b", idempotencyKey: "k2", intentId: "i2", payloadHash: "h2", issueKey: "jira:X" })) as
      { kind: "new"; operation: { id: string } };
    expect((await store.claimLease("jira:X", loser.operation.id, 61_000 + 1)).kind).toBe("claimed");
    expect((await store.getCommand(holder.operation.id))!.state).toBe("uncertain");
    expect(((await store.barrierFor("jira:X")) as { id: string }).id).toBe(holder.operation.id);
  });

  it("replays a receipt only while the fresh check still authorizes this viewer", async () => {
    const { api, call } = await demoApi();
    const brain = api.brain;
    const revision = await currentRevision(call, "DB-12");
    const first = await put(call, "DB-12", "maya", { priority: "Low" }, { revision });
    expect(first.status).toBe(200);
    await brain.blockUser(brain.user("maya")!, "jira:DB-12", "maya");
    const replay = await put(call, "DB-12", "maya", { priority: "Low" }, { revision });
    expect(replay.status).toBe(404);
    expect((replay.body as { error: { code: string } }).error.code).toBe("TASK_UNAVAILABLE");
  });
});

describe("boundary parsing", () => {
  const thrown = (run: () => unknown): CommandRejection | undefined => {
    try { run(); return undefined; } catch (error) { return error instanceof CommandRejection ? error : undefined; }
  };

  it("rejects empty, oversized and malformed edits without touching the task", () => {
    expect(() => parseEditFields({ fields: {} })).toThrow(CommandRejection);
    expect(thrown(() => parseEditFields({ fields: { summary: "" } }))?.fieldErrors.summary).toMatch(/1-250/);
    expect(() => parseEditFields({ fields: { summary: "x".repeat(251) } })).toThrow(CommandRejection);
    expect(() => parseEditFields({ fields: { dueDate: "2026-02-30" } })).toThrow(CommandRejection);
    expect(parseEditFields({ fields: { labels: ["a b", "a b"] } }).labels).toEqual(["a-b"]);
    expect(parseTransitionCommand({ transitionId: "31", fields: { resolutionId: "1" } })).toEqual({ transitionId: "31", fields: { resolutionId: "1" } });
    expect(thrown(() => parseTransitionCommand({}))?.fieldErrors.transitionId).toMatch(/legal transitions/);
  });
});

describe("the live-shaped Jira writer", () => {
  const identity = { id: "maya", name: "Maya", active: true, platformIdentities: { jira: "ravi@aspire.example" } } as never;
  const oauth = { authorization: async () => "Bearer service", siteFor: async () => ({ cloudId: "cid-1", baseUrl: "https://acme.atlassian.net" }) } as unknown as SourceOAuth;

  it("maps a field edit onto one Jira PUT with provider shapes, and sanitizes refusals", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    let refuseNextPut = true;
    const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = `${input}`;
      if (url.includes("/user/permission/search")) return Response.json([{ accountId: "acc-1" }]);
      if (init?.method === "PUT") {
        requests.push({ url, body: init.body ? JSON.parse(`${init.body}`) : undefined });
        if (refuseNextPut) { refuseNextPut = false; return new Response(null, { status: 400 }); }
        return new Response(null, { status: 204 });
      }
      return new Response("", { status: 404 });
    };
    const jira = new (await import("./service-jira.js")).JiraAsUser(oauth, async () => "acc-1", transport);
    const refused = await jira.editFields(identity, "DB-12", { summary: "x", assignee: "ravi@aspire.example" }).catch(error => error);
    expect(refused).toBeInstanceOf(CommandRejection);
    expect(refused.status).toBe(422);
    const applied = await jira.editFields(identity, "DB-12", { summary: "New", dueDate: "2026-11-02", priority: "Low", labels: ["a"], assignee: "ravi@aspire.example" });
    expect(applied).toEqual({ summary: "New", dueDate: "2026-11-02", priority: "Low", labels: ["a"], assignee: "ravi@aspire.example" });
    const edit = requests[1];
    expect(edit.url).toContain("/rest/api/3/issue/DB-12");
    expect(edit.body).toEqual({ fields: { summary: "New", duedate: "2026-11-02", priority: { name: "Low" }, labels: ["a"], assignee: { accountId: "acc-1" } } });
  });

  it("maps a transition onto one Jira POST, and lists legal moves with unsupported fields marked", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    let transitions: { transitions: Array<Record<string, unknown>> } = { transitions: [{ id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } }, fields: { resolution: { name: "Resolution", required: true, schema: { type: "option" }, allowedValues: [{ id: "1", name: "Done" }] } } }] };
    const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = `${input}`;
      if (url.includes("/user/permission/search")) return Response.json([{ accountId: "acc-1" }]);
      if (init?.method === "POST") { requests.push({ url, body: init.body ? JSON.parse(`${init.body}`) : undefined }); return new Response(null, { status: 204 }); }
      if (url.includes("/transitions")) return Response.json(transitions);
      return new Response("", { status: 404 });
    };
    const jira = new (await import("./service-jira.js")).JiraAsUser(oauth, async () => "acc-1", transport);
    expect(await jira.transitionIssue(identity, "DB-12", { transitionId: "31", fields: { resolutionId: "1" } }))
      .toEqual({ resolutionId: "1" });
    expect(requests[0].body).toEqual({ transition: { id: "31" }, fields: { resolution: { id: "1" } } });
    const listed = await jira.legalTransitions(identity, "DB-12");
    expect(listed[0]).toMatchObject({ id: "31", name: "Done", target: { name: "Done", category: "done" },
      fields: [{ id: "resolutionId", name: "Resolution", required: true, supported: true }] });
    transitions = { transitions: [{ id: "41", name: "Custom", to: { name: "Blocked", statusCategory: { key: "indeterminate" } }, fields: { customfield_10010: { name: "Wave", required: true, schema: { type: "string" } } } }] };
    const unsupported = (await jira.legalTransitions(identity, "DB-12"))[0];
    expect(unsupported.fields[0]).toMatchObject({ id: "customfield_10010", required: true, supported: false });
  });

  it("edits a live task through the command path with one audit entry per result", async () => {
    const fixture = loadMockCorpus();
    const brain = new Brain(undefined, { users: fixture.users, connectors: fixture.connectors });
    const jira: LiveJira = {
      canCreate: async () => true,
      createIssue: async () => undefined,
      markDone: async () => true,
      editFields: async (_user, key, fields) => {
        brain.connectors.jira.updateDocument(`jira:${key}`, { ...(fields.summary !== undefined ? { title: fields.summary } : {}), metadata: {} });
        return { ...fields };
      },
      legalTransitions: async () => [],
      transitionIssue: async () => ({}),
      settleUncertainEdit: async () => false
    };
    brain.liveJira = jira;
    const { call } = await serverFor(brain);
    const revision = await currentRevision(call, "DB-12");
    const receipt = (await put(call, "DB-12", "maya", { summary: "Live edit" }, { revision })).body as { state: string; task: { title: string; revision: string } };
    expect(receipt.state).toBe("applied");
    expect(receipt.task.title).toBe("Live edit");
    const events = brain.audit.entries.map(entry => entry.type);
    expect(events).toContain("task_command");
    expect(events).toContain("task_command_result");
  });

  it("settles an uncertain live edit from a readback without a second dispatch", async () => {
    const fixture = loadMockCorpus();
    let readbackMatches = true;
    const jira: LiveJira = {
      canCreate: async () => true,
      createIssue: async () => undefined,
      markDone: async () => true,
      editFields: async () => { throw new Error("connection lost mid-write"); },
      legalTransitions: async () => [],
      transitionIssue: async () => ({}),
      settleUncertainEdit: async () => readbackMatches
    };
    const brain = new Brain(undefined, { users: fixture.users, connectors: fixture.connectors });
    brain.liveJira = jira;
    const { call } = await serverFor(brain);
    const revision = await currentRevision(call, "DB-12");
    const lost = await put(call, "DB-12", "maya", { summary: "Halfway" }, { revision });
    expect(lost.status).toBe(202);
    const operationId = (lost.body as { operationId: string }).operationId;
    const settled = (await call(`/v1/task-operations/${operationId}/check`, "maya", "POST")).body as { state: string; outcome?: string };
    expect(settled.state).toBe("applied");
    expect(settled.outcome).toBe("desiredStateObserved");
    readbackMatches = false;
    const second = await put(call, "DB-12", "maya", { priority: "Low" }, { id: "i2", key: "k2", revision: "task-r4" });
    expect(second.status).toBe(202);
  });
});

async function apiFor(shared: MemoryTaskCommandStore) {
  const { api, call } = await demoApi();
  api.brain.commandStore = shared;
  return { api, call };
}

async function serverFor(brain: Brain) {
  const api = await createApiServer({ brain, startOrchestrator: false });
  servers.push(api.server);
  await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
  const port = (api.server.address() as { port: number }).port;
  const call: Call = async (path, user, method = "GET", payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { "x-demo-user": user, "content-type": "application/json", ...headers },
      ...(method === "PUT" || method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}) });
    const text = await response.text();
    return { status: response.status, text, body: text === "" ? undefined : JSON.parse(text) as unknown };
  };
  return { api, call };
}
