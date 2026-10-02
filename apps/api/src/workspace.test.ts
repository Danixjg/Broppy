import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMockCorpus } from "@brain/connectors";
import { Brain } from "./brain.js";
import { agreementsFor, type WorkspaceDocument } from "./workspace.js";

async function workspaceOf(userId: string, options: ConstructorParameters<typeof Brain>[1] = {}) {
  const brain = new Brain(undefined, options);
  await brain.syncAll();
  return brain.workspace(brain.user(userId)!);
}

describe("workspace", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("lists a project only to people who can open its master page", async () => {
    expect((await workspaceOf("wei")).projects).toEqual([]);
    expect((await workspaceOf("alex")).projects).toEqual([]);
    const david = await workspaceOf("david");
    expect(david.projects.map(project => [project.key, project.name, project.masterDocId])).toEqual([
      ["DB", "Database migration plan", "confluence:db-migration-plan"],
      ["PAY", "Payment migration", "confluence:payment-master"]
    ]);
    const db = david.projects.find(project => project.key === "DB")!;
    expect(db.docIds).toEqual(expect.arrayContaining(["confluence:db-migration-plan", "jira:DB-12", "jira:DB-15",
      "slack:db-migration", "slack:db-planning", "drive:db-wave-checklist"]));
    expect(db.docIds).not.toContain("slack:db-oncall");
    expect(db.docIds).not.toContain("jira:PAY-101");
    const pay = david.projects.find(project => project.key === "PAY")!;
    expect(pay.docIds).toEqual(expect.arrayContaining(["jira:PAY-101", "jira:SETL-27", "slack:payments-cutover",
      "drive:cutover-plan", "drive:api-spec", "drive:api-spec-copy"]));
    expect((await workspaceOf("ravi")).projects.find(project => project.key === "DB")!.docIds).toContain("slack:db-oncall");
  });

  it("lists each document's links to items the viewer can open, and no others", async () => {
    const linksOf = (workspace: Awaited<ReturnType<typeof workspaceOf>>, docId: string) =>
      workspace.documents.find(doc => doc.docId === docId)!.links;
    const david = await workspaceOf("david");
    expect(linksOf(david, "jira:DB-15")).toEqual(expect.arrayContaining(["jira:DB-12", "slack:db-migration"]));
    expect(linksOf(david, "jira:DB-15")).not.toContain("slack:db-oncall");
    expect(linksOf(await workspaceOf("ravi"), "jira:DB-15")).toContain("slack:db-oncall");
  });

  it("explains which file is the latest in each project", async () => {
    const david = await workspaceOf("david");
    const pay = david.latest.find(item => item.project === "PAY")!;
    expect(pay.docId).toBe("drive:cutover-plan");
    expect(pay.reasons).toEqual(expect.arrayContaining(["final (+40)", "version 5 (+5)", "linked to the master page (+15)"]));
    expect(pay.reasons).toContainEqual(expect.stringMatching(/^edited \d+ days? ago \(\+\d+\)$/));
    expect(david.latest.find(item => item.project === "DB")?.docId).toBe("drive:db-wave-checklist");
    // Superseded files never count as the latest.
    expect(david.latest.map(item => item.docId)).not.toContain("drive:cutover-duplicate");
  });

  it("finds duplicates by title or by content, and says which to keep", async () => {
    const david = await workspaceOf("david");
    expect(david.duplicates).toEqual(expect.arrayContaining([
      expect.objectContaining({ keep: "drive:cutover-plan", other: "drive:cutover-duplicate",
        reasons: expect.arrayContaining(["same title", "the other is marked superseded"]) }),
      expect.objectContaining({ keep: "drive:api-spec", other: "drive:api-spec-copy",
        reasons: expect.arrayContaining(["83% of their words are shared"]) })
    ]));
    const pair = david.duplicates.find(item => item.other === "drive:api-spec-copy")!;
    expect(pair.onlyInOther).toEqual(["Settlement API specification for SETL integrations."]);
    expect(pair.onlyInKeep).toEqual(["Settlement API specification for PAY and SETL integrations."]);
    expect((await workspaceOf("alex")).duplicates).toEqual([]);
  });

  it("suggests a Jira task for an agreement in a thread the viewer can open", async () => {
    expect((await workspaceOf("david")).suggestions).toEqual([{
      threadDocId: "slack:db-migration", project: "DB",
      sentence: "Agreed: Maya raises the replica storage quota before the final wave.",
      summary: "Maya raises the replica storage quota before the final wave", canCreate: true
    }]);
    expect((await workspaceOf("alex")).suggestions).toEqual([]);
  });

  it("offers the project in Jira instead when the sources are live", async () => {
    const david = await workspaceOf("david", { connectors: loadMockCorpus().connectors });
    expect(david.suggestions).toEqual([expect.objectContaining({ canCreate: false, jiraUrl: "https://jira.example/browse/DB" })]);
  });

  it("names nothing a viewer can't open", async () => {
    for (const userId of ["wei", "alex"]) {
      const text = JSON.stringify(await workspaceOf(userId));
      for (const hidden of ["db-oncall", "q3-incident", "payment-master", "db-migration-plan", "Payment migration",
        "Database migration", "Agreed", "SEC-44"]) {
        expect(text, `${userId}: ${hidden}`).not.toContain(hidden);
      }
    }
  });
});

describe("agreements in threads", () => {
  const doc = (docId: string, content: string, extra: Partial<WorkspaceDocument> = {}): WorkspaceDocument => ({
    docId, source: docId.split(":")[0] as WorkspaceDocument["source"], title: docId, content, url: `https://jira.example/browse/${docId.split(":")[1]}`,
    updatedAt: "2026-10-14T09:00:00.000Z", version: 1, metadata: {}, links: [], ...extra
  });

  it("reads fixed phrases at the start of a sentence only", () => {
    const issue = doc("jira:OPS-1", "OPS-1 tracks the freeze.", { metadata: { project: "OPS" } });
    const thread = doc("slack:ops", "Decision: we ship on Friday. We agreed earlier to wait. OK, let's freeze deploys. " +
      "Let's go with the blue route. Approved: the vendor contract.", { links: ["jira:OPS-1"] });
    expect(agreementsFor([issue, thread], false).map(item => item.summary)).toEqual([
      "We ship on Friday", "Freeze deploys", "The blue route", "The vendor contract"]);
  });

  it("skips an agreement a visible issue already quotes, and a thread with no project", () => {
    const sentence = "Agreed: Maya raises the quota.";
    const thread = doc("slack:ops", sentence, { links: ["jira:OPS-1"] });
    const tracked = doc("jira:OPS-2", `OPS-2 tracks the agreement in #ops: "${sentence}"`, { metadata: { project: "OPS" } });
    const issue = doc("jira:OPS-1", "OPS-1 tracks the freeze.", { metadata: { project: "OPS" } });
    expect(agreementsFor([issue, tracked, thread], false)).toEqual([]);
    expect(agreementsFor([doc("slack:lonely", sentence)], false)).toEqual([]);
  });
});
