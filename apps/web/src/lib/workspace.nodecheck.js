import test from "node:test";
import assert from "node:assert/strict";
import { LIST_LIMIT, chosenProject, documentStatus, linkedTask, omittedNotes, quotesOf, safeText,
  scopeText, searchMatches, sentencesOf, showMoreLabel, sourceName, taskIsDone, visibleItems } from "./workspace.js";

const items = count => Array.from({ length: count }, (_, index) => `item ${index + 1}`);

test("shows the first eight items of a long list, and says how many wait behind the button", () => {
  assert.equal(LIST_LIMIT, 8);
  const { shown, hidden } = visibleItems(items(20), false);
  assert.deepEqual(shown, items(8));
  assert.equal(hidden, 12);
});

test("names what the button shows, so each list's button makes sense on its own", () => {
  assert.equal(showMoreLabel(12, "thread"), "Show 12 more threads");
  assert.equal(showMoreLabel(1, "task"), "Show 1 more task");
  assert.equal(showMoreLabel(297, "source"), "Show 297 more sources");
});

test("shows a short list whole, and a long one whole once it is expanded", () => {
  assert.deepEqual(visibleItems(items(8), false), { shown: items(8), hidden: 0 });
  assert.deepEqual(visibleItems(items(3), false), { shown: items(3), hidden: 0 });
  assert.deepEqual(visibleItems(items(20), true), { shown: items(20), hidden: 0 });
  assert.deepEqual(visibleItems([], false), { shown: [], hidden: 0 });
});

test("keeps the project on screen while the person may still open it, All sources included", () => {
  const keys = ["DB", "PAY", "PLAT"];
  assert.equal(chosenProject("PAY", "DB", keys), "PAY");
  assert.equal(chosenProject("", "DB", keys), "");
});

test("starts from the project last chosen, All sources included, else the first", () => {
  const keys = ["DB", "PAY", "PLAT"];
  assert.equal(chosenProject(null, "PLAT", keys), "PLAT");
  assert.equal(chosenProject(null, "", keys), "");
  assert.equal(chosenProject(null, null, keys), "DB");
});

test("moves on from a project the person can no longer open, and shows All sources when they have none", () => {
  const keys = ["DB", "PAY", "PLAT"];
  assert.equal(chosenProject("VEND", "PLAT", keys), "PLAT");
  assert.equal(chosenProject("VEND", "KYC", keys), "DB");
  assert.equal(chosenProject(null, "PLAT", []), "");
  assert.equal(chosenProject(null, null, []), "");
});

test("task deep-links match exact authorized issue ids or neutral titles", () => {
  const documents = [{ source: "jira", docId: "jira:DB-15", title: "DB-15 Increase quota" },
    { source: "slack", docId: "slack:db", title: "Increase quota" }];
  for (const value of ["DB-15", "jira:DB-15", "Increase quota", "DB-15 Increase quota"]) {
    assert.equal(linkedTask(documents, value)?.docId, "jira:DB-15");
  }
  assert.equal(linkedTask(documents, "Increase"), undefined);
  assert.equal(linkedTask(documents, "SEC-44"), undefined);
});

test("names the source a document came from, and its status, in the words the panels use", () => {
  assert.equal(sourceName("slack"), "Slack");
  assert.equal(sourceName("jira"), "Jira");
  assert.equal(sourceName("drive"), "Drive");
  assert.equal(sourceName("other"), "Source");
  assert.equal(documentStatus({ metadata: { status: "in review" } }), "in review");
  assert.equal(documentStatus({}), "source");
});

test("a task is done when its status category says so, whatever the workflow calls it", () => {
  assert.equal(taskIsDone({ metadata: { statusCategory: "done", status: "Released" } }), true);
  assert.equal(taskIsDone({ metadata: { status: "done" } }), true);
  assert.equal(taskIsDone({ metadata: { statusCategory: "indeterminate", status: "done" } }), false);
  assert.equal(taskIsDone({ metadata: { status: "in progress" } }), false);
});

test("splits a document into the sentences a conclusion is made of", () => {
  assert.deepEqual(sentencesOf("First line. Second line!\nThird line"), ["First line.", "Second line!", "Third line"]);
  assert.deepEqual(sentencesOf(""), []);
});

test("says where the answer looked, and what it kept to", () => {
  assert.equal(scopeText({ sources: ["slack", "jira"], project: "PAY" }), "Kept to PAY. Searched Slack and Jira first, then the other sources.");
  assert.equal(scopeText({}), "");
});

test("a reworded line shows the sentences that back it, a copied line shows its own words", () => {
  assert.deepEqual(quotesOf({ kind: "quoted", text: "copied" }), ["copied"]);
  assert.deepEqual(quotesOf({ kind: "reworded", text: "reworded", support: ["source line"] }), ["source line"]);
});

test("says which reviewed fields Jira went without", () => {
  assert.deepEqual(omittedNotes([]), []);
  assert.deepEqual(omittedNotes(["owner"]), ["No owner was set in Jira: we couldn't match them to a Jira account it would accept.", "Set it in Jira."]);
  assert.equal(omittedNotes(["due date"]).length, 2);
});

test("the search looks through the words a document carries", () => {
  const doc = { title: "Payment cutover", source: "slack", content: "Traffic moves on Friday", metadata: { status: "in review", project: "PAY" } };
  assert.equal(searchMatches(doc, ""), true);
  assert.equal(searchMatches(doc, "cutover"), true);
  assert.equal(searchMatches(doc, "friday"), true);
  assert.equal(searchMatches(doc, "SEC-44"), false);
});

test("text that is not text reads as empty", () => {
  assert.equal(safeText(undefined), "");
  assert.equal(safeText(7), "");
  assert.equal(safeText("words"), "words");
});
