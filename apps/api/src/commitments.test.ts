import { expect, it, vi } from "vitest";
import { Brain } from "./brain.js";
import { loadMockCorpus } from "@brain/connectors";
import { MemoryTaskStore } from "../../slack/src/store.js";
import { agreementsFor, type WorkspaceDocument } from "./workspace.js";
import type { Persistence } from "./persistence.js";

async function setup(taskStore = new MemoryTaskStore(), options: ConstructorParameters<typeof Brain>[1] = {}) {
  const brain = new Brain(undefined, { ...options, taskStore });
  await brain.syncAll();
  const user = brain.user("david")!;
  const proposal = (await brain.workspace(user)).suggestions[0];
  return { brain, user, proposal, taskStore };
}

it("retains edited owner and date in the canonical proposal and approved mock task", async () => {
  const { brain, user, proposal, taskStore } = await setup();
  expect(proposal.ownerSlackId).toBe("");
  expect(proposal.dueDate).toBeUndefined();
  const edited = await brain.reviewCommitment(user, { id: proposal.id, revision: proposal.revision, action: "edit",
    summary: "Increase storage quota", ownerSlackId: "maya@aspire.example", dueDate: "2026-11-03" });
  const restored = await setup(taskStore);
  expect(restored.proposal).toMatchObject({ id: proposal.id, revision: edited.revision, summary: "Increase storage quota",
    ownerSlackId: "maya@aspire.example", dueDate: "2026-11-03" });
  const created = await brain.createTask(user, proposal.threadDocId, proposal.sentence, { proposalId: proposal.id, revision: edited.revision });
  expect(created.title).toBe("DB-16 Increase storage quota");
  expect(brain.index.documents.get(created.docId)?.metadata).toMatchObject({ ownerSlackId: "maya@aspire.example", dueDate: "2026-11-03" });
  expect(await taskStore.getProposal(proposal.id)).toMatchObject({ status: "created", issueKey: "DB-16" });
  expect((await taskStore.listTasks())[0]).toMatchObject({ channel: "db-migration", messageTs: expect.any(String), issueKey: "DB-16" });
  await expect(brain.createTask(user, proposal.threadDocId, proposal.sentence, { proposalId: proposal.id, revision: edited.revision })).rejects.toThrow("Stale commitment");
  expect((await brain.connectors.jira.listIds()).filter(id => id === "jira:DB-16")).toHaveLength(1);
});

it("keeps a dismissed proposal dismissed after a new Brain reads the same store", async () => {
  const { brain, user, proposal, taskStore } = await setup();
  await brain.reviewCommitment(user, { id: proposal.id, revision: proposal.revision, action: "dismiss" });
  const restored = await setup(taskStore);
  expect((await restored.brain.workspace(restored.user)).suggestions).toEqual([]);
  expect((await taskStore.getProposal(proposal.id))?.status).toBe("dismissed");
  await expect(brain.createTask(user, proposal.threadDocId, proposal.sentence)).rejects.toThrow("Stale commitment");
  await expect(brain.reviewCommitment(user, { id: proposal.id, revision: proposal.revision, action: "edit", summary: "Reopen" })).rejects.toThrow("Stale commitment");
});

it("requires an explicit reviewed link and hides linked issue metadata after access is removed", async () => {
  const { brain, user, proposal, taskStore } = await setup();
  expect(proposal.candidates.map(item => item.docId)).toContain("jira:DB-15");
  await expect(brain.reviewCommitment(user, { id: proposal.id, revision: proposal.revision, action: "link", issueDocId: "jira:PAY-101" })).rejects.toThrow("Unknown document");
  expect((await taskStore.getProposal(proposal.id))?.status).toBe("pending");
  await brain.reviewCommitment(user, { id: proposal.id, revision: proposal.revision, action: "link", issueDocId: "jira:DB-15" });
  expect((await taskStore.listTasks())[0]).toMatchObject({ channel: "db-migration", issueKey: "DB-15" });
  expect((await brain.workspace(user)).commitments[0]).toMatchObject({ status: "linked", issueDocId: "jira:DB-15" });
  await brain.blockUser(brain.user("maya")!, "jira:DB-15", user.id);
  expect((await brain.workspace(user)).commitments).toEqual([]);
});

it("rejects stale revisions and rechecks source access before editing or creating", async () => {
  const { brain, user, proposal } = await setup();
  await brain.reviewCommitment(user, { id: proposal.id, revision: proposal.revision, action: "edit", summary: "Reviewed summary" });
  await expect(brain.createTask(user, proposal.threadDocId, proposal.sentence, { proposalId: proposal.id, revision: proposal.revision })).rejects.toThrow("Stale commitment");
  expect(brain.index.documents.has("jira:DB-16")).toBe(false);
  await brain.blockUser(brain.user("maya")!, proposal.threadDocId, user.id);
  await expect(brain.reviewCommitment(user, { id: proposal.id, revision: proposal.revision + 1, action: "dismiss" })).rejects.toThrow("Unknown document");
  expect((await brain.workspace(user)).commitments).toEqual([]);
});

it("keeps ordinary selected-project answers inside server-derived visible membership", async () => {
  const { brain, user } = await setup();
  const project = (await brain.workspace(user)).projects.find(item => item.key === "DB")!;
  const answer = await brain.query(user, "What is the status and blockers?", undefined, undefined, { project: "DB" });
  expect(answer.scope?.project).toBe("Database migration plan");
  expect(answer.citations.length).toBeGreaterThan(0);
  expect(answer.citations.every(citation => project.docIds.includes(citation.docId))).toBe(true);
  await expect(brain.query(brain.user("alex")!, "What is the status?", undefined, undefined, { project: "DB" })).rejects.toThrow("Unknown document");
});

it("reports live capabilities accurately and retains failed-import notices on gaps and catch-up", async () => {
  const live = new Brain(undefined, { connectors: loadMockCorpus().connectors }); await live.syncAll();
  expect((await live.workspace(live.user("david")!)).capabilities).toEqual({ mode: "live", createTask: false, markDone: false });
  const { brain, user } = await setup();
  brain.connections.get("jira")!.status = "Error";
  const workspace = await brain.workspace(user);
  expect(workspace.importNotice).toContain("Coverage is incomplete");
  expect(workspace.suggestions[0].importNotice).toContain("jira");
  expect(workspace.suggestions[0].notice).toContain("accessible, imported sources");
  expect((await brain.catchUp(user, "DB")).importNotice).toContain("Coverage is incomplete");
});

it("recognizes first-person and explicit tracking intake without inventing sender evidence", () => {
  const thread: WorkspaceDocument = { docId: "slack:C1", source: "slack", title: "#operations", content: "",
    updatedAt: "2026-10-05T00:00:00Z", url: "https://slack.example/channel", version: 1, links: ["jira:OPS-1"], metadata: {},
    slackMessages: [{ teamId: "T1", channelId: "C1", threadTs: "100.1", messageTs: "100.2", authorSlackId: "U1",
      permalink: "https://team.slack.com/archives/C1/p1002", text: "I will increase replicas by Friday.", updatedAt: "2026-10-05T00:00:00Z" }] };
  const issue = { ...thread, docId: "jira:OPS-1", source: "jira" as const, metadata: { project: "OPS" }, slackMessages: undefined };
  expect(agreementsFor([thread, issue], false)[0]).toMatchObject({ summary: "Increase replicas by Friday", message: { authorSlackId: "U1", messageTs: "100.2" } });
  expect(agreementsFor([{ ...thread, slackMessages: undefined, content: "Track this: rotate the test key." }, issue], false)[0].summary).toBe("Rotate the test key");
});

it("resolves first-person ownership only from the active source author identity", async () => {
  async function proposalFrom(authorSlackId: string, inactive = false, mapped = true) {
    const fixture = loadMockCorpus();
    if (inactive) fixture.users.find(user => user.id === "maya")!.active = false;
    const original = (await fixture.connectors.slack.fetchDocument("slack:db-migration"))!;
    const document = { ...original, content: "I will increase replicas by Friday.", version: original.version + 1,
      slackMessages: [{ teamId: "T1", channelId: "db-migration", threadTs: "100.1", messageTs: "100.2",
        authorSlackId, permalink: "https://team.slack.com/archives/db-migration/p1002", text: "I will increase replicas by Friday.", updatedAt: original.updatedAt }] };
    fixture.connectors.slack.delete(original.docId); fixture.connectors.slack.create(document);
    const brain = new Brain(undefined, { users: fixture.users, connectors: fixture.connectors, slackUserIds: mapped ? { maya: "U123" } : {} }); await brain.syncAll();
    return (await brain.workspace(brain.user("david")!)).suggestions[0];
  }
  expect(await proposalFrom("U123")).toMatchObject({ ownerSlackId: "U123",
    dueDate: undefined, permalink: "https://team.slack.com/archives/db-migration/p1002" });
  expect((await proposalFrom("U_UNKNOWN")).ownerSlackId).toBe("");
  expect((await proposalFrom("U123", true)).ownerSlackId).toBe("");
  expect((await proposalFrom("U123", false, false)).ownerSlackId).toBe("");
});

it("refuses a mock create while Slack has reserved the same canonical proposal", async () => {
  const { brain, user, proposal, taskStore } = await setup();
  const canonical = (await taskStore.getProposal(proposal.id))!;
  await taskStore.reserveOperation(canonical, "david@aspire.example");
  await expect(brain.createTask(user, proposal.threadDocId, proposal.sentence, { proposalId: proposal.id, revision: proposal.revision })).rejects.toThrow("Stale commitment");
  expect(brain.index.documents.has("jira:DB-16")).toBe(false);
});

it("resumes the same approved mock issue after a post-create failure and reload", async () => {
  let snapshot: unknown;
  const persistence = { loadState: async () => structuredClone(snapshot), saveState: async (value: unknown) => { snapshot = structuredClone(value); } } as Persistence;
  const { brain, user, proposal, taskStore } = await setup(undefined, { persistence });
  const create = brain.connectors.jira.create.bind(brain.connectors.jira);
  vi.spyOn(brain.connectors.jira, "create").mockImplementationOnce(doc => { create(doc); throw new Error("Failed immediately after create"); });
  const approval = { proposalId: proposal.id, revision: proposal.revision };
  await expect(brain.createTask(user, proposal.threadDocId, proposal.sentence, approval)).rejects.toThrow("Failed immediately after create");
  expect(await taskStore.getProposal(proposal.id)).toMatchObject({ status: "pending", revision: proposal.revision });
  for (const command of [{ action: "edit", summary: "Changed after create" }, { action: "dismiss" }, { action: "link", issueDocId: "jira:DB-15" }] as const) {
    await expect(brain.reviewCommitment(user, { id: proposal.id, revision: proposal.revision, ...command })).rejects.toThrow("Stale commitment");
  }
  const restored = new Brain(undefined, { taskStore, persistence });
  await restored.restore(); await restored.syncAll();
  const retriedCreate = vi.spyOn(restored.connectors.jira, "create");
  expect(await restored.createTask(restored.user("david")!, proposal.threadDocId, proposal.sentence, approval))
    .toMatchObject({ docId: "jira:DB-16" });
  expect(retriedCreate).not.toHaveBeenCalled();
  expect((await restored.connectors.jira.listIds()).filter(id => /^jira:DB-(16|17)$/.test(id))).toEqual(["jira:DB-16"]);
  expect(await taskStore.getProposal(proposal.id)).toMatchObject({ status: "created", revision: proposal.revision + 1, issueKey: "DB-16" });
  expect((await taskStore.listTasks())[0]).toMatchObject({ channel: "db-migration", issueKey: "DB-16" });
});

it.each(["sync", "finalization"] as const)("locks an unfinalized mock receipt and completes it after %s recovers", async failure => {
  const { brain, user, proposal, taskStore } = await setup();
  const approval = { proposalId: proposal.id, revision: proposal.revision };
  if (failure === "sync") vi.spyOn(brain, "sync").mockRejectedValueOnce(new Error("Post-create sync failed"));
  else vi.spyOn(taskStore, "completeProposal").mockResolvedValueOnce(undefined);
  await expect(brain.createTask(user, proposal.threadDocId, proposal.sentence, approval))
    .rejects.toThrow(failure === "sync" ? "Post-create sync failed" : "Stale commitment");
  const operation = await taskStore.reserveOperation((await taskStore.getProposal(proposal.id))!, "workspace-demo:david");
  expect(operation).toMatchObject({ state: "remote_succeeded", issueKey: "DB-16" });
  for (const command of [{ action: "edit", summary: "Changed after receipt" }, { action: "dismiss" }, { action: "link", issueDocId: "jira:DB-15" }] as const) {
    await expect(brain.reviewCommitment(user, { id: proposal.id, revision: proposal.revision, ...command })).rejects.toThrow("Stale commitment");
  }
  const retriedCreate = vi.spyOn(brain.connectors.jira, "create");
  expect(await brain.createTask(user, proposal.threadDocId, proposal.sentence, approval)).toMatchObject({ docId: "jira:DB-16" });
  expect(retriedCreate).not.toHaveBeenCalled();
  expect(await taskStore.getProposal(proposal.id)).toMatchObject({ status: "created", operationId: operation!.id });
});

it("withholds another mock create when the first result cannot be proved", async () => {
  const { brain, user, proposal, taskStore } = await setup();
  const create = vi.spyOn(brain.connectors.jira, "create").mockImplementationOnce(() => { throw new Error("Unknown create result"); });
  const approval = { proposalId: proposal.id, revision: proposal.revision };
  await expect(brain.createTask(user, proposal.threadDocId, proposal.sentence, approval)).rejects.toThrow("Unknown create result");
  await expect(brain.createTask(user, proposal.threadDocId, proposal.sentence, approval)).rejects.toThrow("Mock task outcome needs reconciliation");
  expect(create).toHaveBeenCalledTimes(1);
  expect(await brain.connectors.jira.fetchDocument("jira:DB-16")).toBeUndefined();
  expect(await taskStore.getProposal(proposal.id)).toMatchObject({ status: "pending", revision: proposal.revision });
});

it("retains separate source references when two reviewed messages link to the same issue", async () => {
  const { brain, user, proposal, taskStore } = await setup();
  brain.connectors.slack.updateContent("slack:db-planning", proposal.sentence); await brain.sync("slack");
  const items = (await brain.workspace(user)).suggestions;
  expect(items).toHaveLength(2);
  for (const item of items) await brain.reviewCommitment(user, { id: item.id, revision: item.revision, action: "link", issueDocId: "jira:DB-15" });
  const links = await taskStore.listTasks();
  expect(links.map(link => link.channel).sort()).toEqual(["db-migration", "db-planning"]);
  expect(new Set(links.map(link => link.fingerprint)).size).toBe(2);
  expect(links.every(link => link.issueKey === "DB-15")).toBe(true);
});
