import { describe, expect, it } from "vitest";
import { categoryOf, columnize, dueInWeek, dueOverdue, filterRows, localToday, localWeekBounds,
  nameCategory, pageOf, presetRows, priorityRank, sortRows, statusCategoryOf, summarize,
  type TaskQuery, type TaskRow } from "./tasks-lens.js";

const NOW = new Date(Date.parse("2026-10-20T18:30:00.000Z"));
const MILLISECONDS_SINGAPORE = new Date(Date.parse("2026-10-20T17:00:00.000Z"));
const MILLISECONDS_AHEAD = new Date(Date.parse("2026-10-20T00:30:00.000Z"));

function row(overrides: Partial<TaskRow> & Pick<TaskRow, "id" | "key">): TaskRow {
  return { title: "", projectKey: "DB", projectName: "DB", status: "open", category: "new" as const,
    dueDate: null, priority: null, priorityRank: null, updatedAt: "2026-10-01T00:00:00Z",
    url: "", mine: false, ...overrides };
}

function query(overrides: Partial<TaskQuery> = {}): TaskQuery {
  return { view: "list", projectIds: [], statusIds: [], priorityIds: [], mine: false, due: "any",
    q: [], sort: "dueAsc", timezone: "UTC", limit: 50, ...overrides };
}

const PAY1 = row({ id: "jira:PAY-1", key: "PAY-1", title: "Payment cutover summary", projectKey: "PAY", projectName: "PAY",
  status: "open", category: "new", priority: "High", priorityRank: priorityRank("High"), mine: true, dueDate: "2026-10-20" });
const PAY2 = row({ id: "jira:PAY-2", key: "PAY-2", title: "Cutover wrap-up", projectKey: "PAY", projectName: "PAY",
  status: "Released", category: "done", mine: false, dueDate: null });
const DB1 = row({ id: "jira:DB-1", key: "DB-1", title: "Raise replica storage quota in the migration plan",
  status: "in progress", category: "indeterminate", priority: "Highest", priorityRank: priorityRank("Highest"),
  mine: true, dueDate: "2026-10-19", updatedAt: "2026-10-02T00:00:00Z" });
const DB2 = row({ id: "jira:DB-2", key: "DB-2", title: "Quota raise blocked", status: "blocked", category: undefined,
  priority: "Medium", priorityRank: priorityRank("Medium"), dueDate: "2026-10-23", updatedAt: "2026-10-03T00:00:00Z" });
const DB3 = row({ id: "jira:DB-3", key: "DB-3", title: "Confirm quota owners", priority: "Low", priorityRank: priorityRank("Low"),
  mine: true, dueDate: "2026-10-26", updatedAt: "2026-10-04T00:00:00Z" });
const DB4 = row({ id: "jira:DB-4", key: "DB-4", title: "Wave three budget", status: "open", priority: "Highest",
  priorityRank: priorityRank("Highest"), mine: true, dueDate: "2026-10-25", updatedAt: "2026-10-05T00:00:00Z" });
const SEC7 = row({ id: "jira:SEC-7", key: "SEC-7", title: "Failover drill", projectKey: "SEC", projectName: "SEC",
  status: "done", category: "done", dueDate: "2026-10-20", updatedAt: "2026-10-06T00:00:00Z" });
const SETL40 = row({ id: "jira:SETL-40", key: "SETL-40", title: "Reconciliation sheet", projectKey: "SETL", projectName: "SETL",
  priority: "Lowest", priorityRank: priorityRank("Lowest"), dueDate: "2026-10-24", updatedAt: "2026-10-07T00:00:00Z" });

const rows = [PAY1, PAY2, DB1, DB2, DB3, DB4, SEC7, SETL40];

const ids = (found: readonly TaskRow[]) => found.map(got => got.id);

describe("FT04 explicit fallbacks", () => {
  it("treats missing due and priority as null and keeps an unknown status as Unmapped", () => {
    const noDue = row({ id: "jira:A-1", key: "A-1" });
    expect(noDue.dueDate).toBeNull();
    expect(noDue.priority).toBeNull();
    expect(dueOverdue(noDue.dueDate, "2026-10-20")).toBe(false);
    expect(dueInWeek(noDue.dueDate, { monday: "2026-10-19", sunday: "2026-10-25" })).toBe(false);
    expect(filterRows(rows, query({ due: "none" }), NOW)).toEqual(rows.filter(got => got.dueDate === null));
    expect(filterRows(rows, query({ priorityIds: ["High"] }), NOW)).toEqual([PAY1]);
    const blocked = columnize([DB2]).find(column => column.id === "unmapped");
    expect(blocked?.name).toBe("Unmapped");
    expect(ids(blocked?.rows ?? [])).toEqual(["jira:DB-2"]);
  });

  it("ranks only Jira's standard priorities", () => {
    expect(priorityRank("Highest")).toBe(5);
    expect(priorityRank("Lowest")).toBe(1);
    expect(priorityRank(null)).toBeNull();
    expect(priorityRank("Custom")).toBeNull();
  });
});

describe("FT05 composed filters, exactly", () => {
  it("composes project, mine, priority, text and due into the independently expected set", () => {
    expect(ids(filterRows(rows, query({ projectIds: ["DB"], mine: true, due: "overdue" }), NOW)))
      .toEqual(["jira:DB-1"]);
    expect(ids(filterRows(rows, query({ projectIds: ["DB"], mine: true, due: "thisWeek", q: ["quota"] }), NOW)))
      .toEqual(["jira:DB-1"]);
    expect(ids(filterRows(rows, query({ statusIds: ["done"], due: "thisWeek" }), NOW)))
      .toEqual(["jira:SEC-7"]);
    expect(ids(filterRows(rows, query({ priorityIds: ["Highest"], due: "any" }), NOW)))
      .toEqual(["jira:DB-1", "jira:DB-4"]);
    expect(ids(filterRows(rows, query({ mine: true }), NOW)))
      .toEqual(["jira:PAY-1", "jira:DB-1", "jira:DB-3", "jira:DB-4"]);
  });

  it("applies all due periods on the viewer's UTC date", () => {
    expect(ids(filterRows(rows, query({ due: "today" }), NOW))).toEqual(["jira:PAY-1", "jira:SEC-7"]);
    expect(ids(filterRows(rows, query({ due: "throughToday" }), NOW))).toEqual(["jira:PAY-1", "jira:DB-1", "jira:SEC-7"]);
    expect(ids(filterRows(rows, query({ due: "thisWeek" }), NOW)))
      .toEqual(["jira:PAY-1", "jira:DB-1", "jira:DB-2", "jira:DB-4", "jira:SEC-7", "jira:SETL-40"]);
    expect(ids(filterRows(rows, query({ due: "overdue" }), NOW))).toEqual(["jira:DB-1"]);
    expect(filterRows(rows, query({ due: "today", timezone: "Asia/Singapore" }), NOW)).toEqual([]);
  });

  it("matches every token across key, summary and project", () => {
    expect(ids(filterRows(rows, query({ q: ["quota"] }), NOW))).toEqual(["jira:DB-1", "jira:DB-2", "jira:DB-3"]);
    expect(ids(filterRows(rows, query({ q: ["replica", "quota"] }), NOW))).toEqual(["jira:DB-1"]);
    expect(ids(filterRows(rows, query({ q: ["db"] }), NOW))).toEqual(["jira:DB-1", "jira:DB-2", "jira:DB-3", "jira:DB-4"]);
  });
});

describe("FT11 category truth, encoded once", () => {
  it("trusts metadata.statusCategory over a status name, live or not", () => {
    expect(statusCategoryOf({ status: "Done", statusCategory: "new" })).toBe("new");
    expect(categoryOf({ status: "Done", statusCategory: "indeterminate" }, true)).toBe("indeterminate");
    expect(statusCategoryOf({ statusCategory: "future" })).toBeUndefined();
  });

  it("maps legacy names only when liveMode is off, never guessing otherwise", () => {
    expect(nameCategory("Released")).toBe("done");
    expect(nameCategory("released")).toBe("done");
    expect(nameCategory("blocked")).toBeUndefined();
    expect(categoryOf({ status: "Released" }, false)).toBe("done");
    expect(categoryOf({ status: "Released" }, true)).toBeUndefined();
    expect(categoryOf({ status: "in review" }, false)).toBe("indeterminate");
  });

  it("counts Released-with-done-category as done and Done-named-but-open as open", () => {
    expect(summarize(rows, query(), NOW).open).toBe(6);
    const released = [row({ id: "jira:R-1", key: "R-1", status: "Released", category: "done" }),
      row({ id: "jira:R-2", key: "R-2", status: "Done-ish", category: "indeterminate" })];
    expect(summarize(released, query(), NOW).open).toBe(1);
  });
});

describe("FT12 local boundaries, exact", () => {
  it("derives the viewer's local date across UTC midnight", () => {
    expect(localToday(NOW, "UTC")).toBe("2026-10-20");
    expect(localToday(NOW, "Asia/Singapore")).toBe("2026-10-21");
    expect(localToday(MILLISECONDS_SINGAPORE, "UTC")).toBe("2026-10-20");
    expect(localToday(MILLISECONDS_SINGAPORE, "Asia/Singapore")).toBe("2026-10-21");
    expect(localToday(MILLISECONDS_AHEAD, "Pacific/Honolulu")).toBe("2026-10-19");
  });

  it("bounds the week Monday through Sunday", () => {
    expect(localWeekBounds("2026-10-20")).toEqual({ monday: "2026-10-19", sunday: "2026-10-25" });
    expect(localWeekBounds("2026-10-19")).toEqual({ monday: "2026-10-19", sunday: "2026-10-25" });
    expect(localWeekBounds("2026-10-25")).toEqual({ monday: "2026-10-19", sunday: "2026-10-25" });
    expect(localWeekBounds("2026-10-26")).toEqual({ monday: "2026-10-26", sunday: "2026-11-01" });
  });

  it("keeps today strictly out of overdue and inside the week", () => {
    expect(dueOverdue("2026-10-20", "2026-10-20")).toBe(false);
    expect(dueOverdue("2026-10-21", "2026-10-20")).toBe(false);
    expect(dueOverdue("2026-10-19", "2026-10-20")).toBe(true);
    expect(dueInWeek("2026-10-19", { monday: "2026-10-19", sunday: "2026-10-25" })).toBe(true);
    expect(dueInWeek("2026-10-25", { monday: "2026-10-19", sunday: "2026-10-25" })).toBe(true);
    expect(dueInWeek("2026-10-26", { monday: "2026-10-19", sunday: "2026-10-25" })).toBe(false);
  });

  it("lets a Singapore viewer count a due date that has not reached UTC yet", () => {
    const singaporeNow = MILLISECONDS_AHEAD;
    expect(localToday(singaporeNow, "Asia/Singapore")).toBe("2026-10-20");
    expect(localToday(singaporeNow, "UTC")).toBe("2026-10-20");
    const overnight = MILLISECONDS_SINGAPORE;
    expect(filterRows(rows, query({ due: "today", timezone: "Asia/Singapore" }), overnight)).toEqual([]);
    expect(ids(filterRows([DB1], query({ due: "overdue", timezone: "Asia/Singapore" }), overnight)))
      .toEqual(["jira:DB-1"]);
  });
});

describe("summary", () => {
  it("computes tiles over the explicit set, with doneThisWeek honestly unreachable", () => {
    expect(summarize(rows, query(), NOW)).toEqual({
      open: 6, dueThisWeek: 5, overdue: 1, doneThisWeek: { knownCount: 0, historyComplete: false }
    });
    expect(summarize([], query(), NOW)).toEqual({
      open: 0, dueThisWeek: 0, overdue: 0, doneThisWeek: { knownCount: 0, historyComplete: false }
    });
  });

  it("narrows only the displayed set for a preset", () => {
    expect(ids(presetRows(rows, "open", query(), NOW)))
      .toEqual(["jira:PAY-1", "jira:DB-1", "jira:DB-2", "jira:DB-3", "jira:DB-4", "jira:SETL-40"]);
    expect(ids(presetRows(rows, "dueThisWeek", query(), NOW)))
      .toEqual(["jira:PAY-1", "jira:DB-1", "jira:DB-2", "jira:DB-4", "jira:SETL-40"]);
    expect(ids(presetRows(rows, "overdue", query(), NOW))).toEqual(["jira:DB-1"]);
    expect(ids(presetRows(rows, "doneThisWeek", query(), NOW))).toEqual(["jira:PAY-2", "jira:SEC-7"]);
  });

  it("never lets a preset redefine the other tiles", () => {
    expect(summarize(rows, { ...query(), summaryPreset: "doneThisWeek" }, NOW)).toEqual(summarize(rows, query(), NOW));
    expect(summarize(rows, { ...query(), summaryPreset: "overdue" }, NOW)).toEqual(summarize(rows, query(), NOW));
    expect(summarize(rows.filter(row => row.category === "done"), query(), NOW).open).toBe(0);
  });
});

describe("sort and page", () => {
  it("orders dueAsc by date then priority then key, with no-date last", () => {
    expect(ids(sortRows(rows, "dueAsc"))).toEqual([
      "jira:DB-1", "jira:PAY-1", "jira:SEC-7", "jira:DB-2", "jira:SETL-40", "jira:DB-4", "jira:DB-3", "jira:PAY-2"
    ]);
  });

  it("orders the remaining sorts by their primary key, ties by key", () => {
    expect(ids(sortRows(rows, "keyAsc"))).toEqual([
      "jira:DB-1", "jira:DB-2", "jira:DB-3", "jira:DB-4", "jira:PAY-1", "jira:PAY-2", "jira:SEC-7", "jira:SETL-40"
    ]);
    expect(ids(sortRows(rows, "priorityDesc"))).toEqual([
      "jira:DB-1", "jira:DB-4", "jira:PAY-1", "jira:DB-2", "jira:DB-3", "jira:SETL-40", "jira:PAY-2", "jira:SEC-7"
    ]);
    expect(ids(sortRows(rows, "updatedDesc"))).toEqual([
      "jira:SETL-40", "jira:SEC-7", "jira:DB-4", "jira:DB-3", "jira:DB-2", "jira:DB-1", "jira:PAY-1", "jira:PAY-2"
    ]);
  });

  it("rebuilds identically for equal sort keys", () => {
    const tied = [row({ id: "jira:B-9", key: "B-9" }), row({ id: "jira:A-1", key: "A-1", dueDate: "2026-10-20" })];
    expect(sortRows(tied, "dueAsc").map(got => got.key)).toEqual(["A-1", "B-9"]);
    expect(sortRows(tied, "dueAsc").map(got => got.key)).toEqual(sortRows(tied, "dueAsc").map(got => got.key));
  });

  it("pages deterministically over the full sorted set", () => {
    expect(ids(pageOf(sortRows(rows, "keyAsc"), 3, 3).items))
      .toEqual(["jira:DB-4", "jira:PAY-1", "jira:PAY-2"]);
    expect(pageOf(sortRows(rows, "keyAsc"), 3, 3)).toMatchObject({ hasMore: true, nextOffset: 6 });
    expect(pageOf(sortRows(rows, "keyAsc"), 3, 9)).toMatchObject({ items: [], hasMore: false, nextOffset: 12 });
  });
});

describe("columns", () => {
  it("keeps every column present and empty ones honest", () => {
    expect(columnize([]).map(column => column.name)).toEqual(["To do", "In progress", "Done", "Unmapped"]);
    const board = columnize(rows);
    expect(ids(board[0].rows)).toEqual(["jira:PAY-1", "jira:DB-3", "jira:DB-4", "jira:SETL-40"]);
    expect(ids(board[1].rows)).toEqual(["jira:DB-1"]);
    expect(ids(board[2].rows)).toEqual(["jira:PAY-2", "jira:SEC-7"]);
    expect(ids(board[3].rows)).toEqual(["jira:DB-2"]);
  });
});
