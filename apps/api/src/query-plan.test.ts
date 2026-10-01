import { describe, expect, it } from "vitest";
import type { Source } from "@brain/types";
import { balanceBySource, planQuery } from "./query-plan.js";

const now = new Date("2026-10-15T08:00:00.000Z");

describe("planQuery", () => {
  it("finds the platforms a question names, in order, and leaves them out of the search text", () => {
    const plan = planQuery("Any blockers in Slack or Jira about the database migration?", now);
    expect(plan.sources).toEqual(["slack", "jira"]);
    expect(plan.searchText).not.toMatch(/slack|jira/i);
    expect(plan.searchText).toContain("database migration");
    expect(planQuery("Is the runbook in Confluence or Google Drive?", now).sources).toEqual(["confluence", "drive"]);
  });

  it("matches platform names as whole words only", () => {
    expect(planQuery("Ask about slackline and drive-through approvals", now).sources).toEqual([]);
    expect(planQuery("database migration status", now)).toEqual({ searchText: "database migration status", sources: [] });
  });

  it("reads relative time windows", () => {
    expect(planQuery("blockers raised last week", now).window)
      .toEqual({ from: "2026-10-08T00:00:00.000Z", to: now.toISOString() });
    expect(planQuery("changes in the past 3 days", now).window)
      .toEqual({ from: "2026-10-12T00:00:00.000Z", to: now.toISOString() });
    expect(planQuery("what was decided yesterday", now).window)
      .toEqual({ from: "2026-10-14T00:00:00.000Z", to: "2026-10-14T23:59:59.999Z" });
    expect(planQuery("anything new today", now).window)
      .toEqual({ from: "2026-10-15T00:00:00.000Z", to: "2026-10-15T23:59:59.999Z" });
    expect(planQuery("the database migration plan", now).window).toBeUndefined();
    expect(planQuery("everything in the last 99999999999 days", now).window).toBeUndefined();
  });
});

describe("balanceBySource", () => {
  const sourceOf = (docId: string) => docId.split(":")[0] as Source;
  const ids = (list: Array<{ docId: string }>) => list.map(item => item.docId);
  const scored = (entries: Array<[string, number]>) => entries.map(([docId, score]) => ({ docId, score }));
  const ranked = scored([["jira:a", 0.9], ["jira:b", 0.8], ["confluence:c", 0.7], ["jira:d", 0.6], ["slack:e", 0.5],
    ["slack:f", 0.45], ["drive:g", 0.3]]);

  it("lets clearly relevant platforms take turns, and puts a barely relevant one last", () => {
    expect(ids(balanceBySource(ranked, [], sourceOf)))
      .toEqual(["jira:a", "confluence:c", "slack:e", "jira:b", "slack:f", "jira:d", "drive:g"]);
  });

  it("puts a named platform first, then lets the others in before more of it", () => {
    expect(ids(balanceBySource(ranked, ["slack"], sourceOf)))
      .toEqual(["slack:e", "slack:f", "jira:a", "confluence:c", "jira:b", "jira:d", "drive:g"]);
    const many = scored([["slack:1", 0.9], ["slack:2", 0.85], ["slack:3", 0.8], ["slack:4", 0.75], ["jira:5", 0.7]]);
    expect(ids(balanceBySource(many, ["slack"], sourceOf))).toEqual(["slack:1", "slack:2", "slack:3", "jira:5", "slack:4"]);
  });
});
