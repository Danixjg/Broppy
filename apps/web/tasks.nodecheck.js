import test from "node:test";
import assert from "node:assert/strict";
import { FALLBACKS, changedFields, countsText, detailPath, doneTileLabel, dueText, dueUrgency, errorText, movesByColumn,
  nameText, pickDrop, priorityText, taskQuery } from "./tasks.js";

test("absent card fields state their fallback and present fields pass through unchanged", () => {
  assert.equal(nameText(""), FALLBACKS.name);
  assert.equal(nameText("   "), FALLBACKS.name);
  assert.equal(nameText(undefined), FALLBACKS.name);
  assert.equal(nameText("DB-15 replica lag"), "DB-15 replica lag");
  assert.equal(dueText(null), FALLBACKS.dueDate);
  assert.equal(dueText(""), FALLBACKS.dueDate);
  assert.equal(dueText("2026-10-23"), "2026-10-23");
  assert.equal(priorityText(undefined), FALLBACKS.priority);
  assert.equal(priorityText("High"), "High");
});

test("the detail route splits a colon-bearing doc id into BFF-safe path segments", () => {
  const path = detailPath("jira:DB-77");
  assert.equal(path, "/v1/tasks/jira/DB-77");
  assert.ok(!path.includes(":"), "a path segment must never carry a colon");
  assert.equal(detailPath("jira:"), null);
  assert.equal(detailPath("confluence:page-1"), null);
  assert.equal(detailPath("DB-77"), null);
  assert.equal(detailPath(""), null);
  assert.equal(detailPath(undefined), null);
});

test("filter state and view round-trip through the one query string", () => {
  // Only the fields taskQuery emits, read back the way the API's own parser would see them.
  const roundTrip = params => ({
    view: params.get("view") || "list",
    projectIds: params.get("projectIds") ? params.get("projectIds").split(",") : [],
    priority: params.get("priorityIds") ?? "",
    status: params.get("statusIds") ?? "",
    mine: params.get("mine") === "true",
    due: params.get("due") ?? "any",
    preset: params.get("summaryPreset") ?? "",
    q: params.get("q") ?? ""
  });
  const filters = { projectIds: ["DB", "PAY"], mine: true, priority: "High", status: "In Progress",
    due: "thisWeek", preset: "overdue", q: "quota review" };
  const params = taskQuery("board", filters);
  assert.equal(params.toString(), "view=board&projectIds=DB%2CPAY&priorityIds=High&statusIds=In+Progress&due=thisWeek&summaryPreset=overdue&mine=true&q=quota+review");
  const recovered = roundTrip(params);
  assert.deepEqual(recovered, { view: "board", ...filters });
  assert.equal(taskQuery("board", recovered).toString(), params.toString());

  const quiet = taskQuery("list", {});
  assert.equal([...quiet.keys()].join(), "view");
  assert.equal(taskQuery("nonsense", {}).get("view"), "list");
  assert.equal(taskQuery("personal", {}).toString(), "view=personal", "the personal widget asks the API's own personal view");
});

test("counts text reads the response and the untracked done tile says so", () => {
  const summary = { open: 4, dueThisWeek: 1, overdue: 1, doneThisWeek: { knownCount: 0, historyComplete: false } };
  const text = countsText(summary);
  assert.match(text, /4 open/);
  assert.match(text, /1 due this week/);
  assert.match(text, /1 overdue/);
  assert.match(text, /0 done this week · not tracked yet/);
  assert.equal(doneTileLabel(summary), "Not tracked yet");
  assert.equal(doneTileLabel({ ...summary, doneThisWeek: { knownCount: 2, historyComplete: true } }), "Done this week");
  assert.match(countsText({ ...summary, doneThisWeek: { knownCount: 2, historyComplete: true } }), /2 done this week$/);
  assert.match(countsText({ open: 0, dueThisWeek: 0, overdue: 0, doneThisWeek: { knownCount: 3, historyComplete: false } }), /3 done this week · not tracked yet/);
});

test("only changed fields ride a save; cleared inputs ride as null", () => {
  const detail = { summary: "Ledger database migration", dueDate: "2026-10-23", priority: "Medium" };
  assert.deepEqual(changedFields(detail, { summary: detail.summary, dueDate: detail.dueDate, priority: "Low" }),
    { priority: "Low" });
  assert.deepEqual(changedFields(detail, { summary: "Renamed", dueDate: "", priority: detail.priority }),
    { summary: "Renamed", dueDate: null });
  assert.deepEqual(changedFields(detail, { summary: detail.summary }), {}, "an unchanged form saves nothing");
});

test("task route errors read as one plain message", () => {
  const envelope = { error: { code: "INVALID_QUERY", message: "The task query is not valid.",
    fieldErrors: { statusIds: "Unknown value: Blocked." }, retryable: false } };
  assert.equal(errorText(envelope), "The task query is not valid. statusIds: Unknown value: Blocked.");
  assert.equal(errorText({ error: "Not found" }), "Request failed.");
  assert.equal(errorText(undefined), "Request failed.");
  assert.equal(errorText({ error: {} }), "The request was not valid.");
});

test("personal widget dates name today and overdue days outright", () => {
  assert.equal(dueUrgency("2026-10-02", "2026-10-21"), "overdue");
  assert.equal(dueUrgency("2026-10-21", "2026-10-21"), "today");
  assert.equal(dueUrgency("2026-10-23", "2026-10-21"), "later");
  assert.equal(dueUrgency(null, "2026-10-21"), "");
  assert.equal(dueUrgency("   ", "2026-10-21"), "");
});

test("board drop destinations come from the card's own transitions", () => {
  const fieldless = { id: "21", name: "Start progress", target: { name: "in progress", category: "indeterminate" }, fields: [] };
  const back = { id: "41", name: "Back to open", target: { name: "open", category: "new" }, fields: [] };
  const done = { id: "31", name: "Done", target: { name: "released", category: "done" },
    fields: [{ id: "resolutionId", name: "Resolution", required: true, supported: true, allowedValues: [{ id: "1", name: "Done" }] }] };
  const release = { id: "91", name: "Release", target: { name: "released", category: "done" }, fields: [] };
  const odd = { id: "77", name: "Unknown status", target: { name: "weird" }, fields: [] };
  const columns = movesByColumn([fieldless, back, done, release, odd]);
  assert.deepEqual(columns.get("in-progress"), [fieldless]);
  assert.deepEqual(columns.get("todo"), [back]);
  assert.deepEqual(columns.get("done"), [done, release]);
  assert.deepEqual(columns.get("unmapped"), [odd], "a category the columns don't know may still land in Unmapped");
  assert.equal(columns.get("no-such-column"), undefined, "only mapped columns offer a drop");
  assert.deepEqual(movesByColumn([]).size, 0);
  assert.deepEqual(movesByColumn(undefined).size, 0);
  assert.deepEqual(movesByColumn([{ target: { category: "done" } }, { id: "  " }]).size, 0, "a move without an id is no destination");

  assert.deepEqual(pickDrop([fieldless]), { kind: "submit", transition: fieldless });
  assert.deepEqual(pickDrop([done]), { kind: "pick" }, "a move that needs fields opens the picker instead of a doomed submit");
  assert.deepEqual(pickDrop([done, release]), { kind: "pick" });
  assert.deepEqual(pickDrop([fieldless, back]), { kind: "pick" }, "two fieldless moves for one column ask which one");
  assert.deepEqual(pickDrop([]), { kind: "none" });
  assert.deepEqual(pickDrop(undefined), { kind: "none" });
});
