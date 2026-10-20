import test from "node:test";
import assert from "node:assert/strict";
import { FALLBACKS, countsText, detailPath, doneTileLabel, dueText, errorText, nameText,
  priorityText, taskQuery } from "./tasks.js";

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

test("task route errors read as one plain message", () => {
  const envelope = { error: { code: "INVALID_QUERY", message: "The task query is not valid.",
    fieldErrors: { statusIds: "Unknown value: Blocked." }, retryable: false } };
  assert.equal(errorText(envelope), "The task query is not valid. statusIds: Unknown value: Blocked.");
  assert.equal(errorText({ error: "Not found" }), "Request failed.");
  assert.equal(errorText(undefined), "Request failed.");
  assert.equal(errorText({ error: {} }), "The request was not valid.");
});
