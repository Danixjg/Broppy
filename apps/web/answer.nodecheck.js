import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerLines, isDemoAddress, looksLikeAuditQuestion, numberSources, quotedRanges } from "./answer.js";

const documents = JSON.parse(readFileSync(new URL("../../data/mock/documents.json", import.meta.url), "utf8"));
const content = docId => documents.find(doc => doc.docId === docId).content;
const citation = (docId, chunk, title) => ({ docId, chunkId: `${docId}:${chunk}`, title, url: `https://example.test/${docId}`,
  version: 1, updatedAt: "2026-10-01T00:00:00.000Z" });
const NO_RESULT = "No accessible information was found for this query.";

test("numbers each cited document once, in the order the answer first cites it", () => {
  const sources = numberSources([citation("jira:DB-12", 0, "DB-12"), citation("slack:db-oncall", 0, "#db-oncall"),
    citation("jira:DB-12", 1, "DB-12"), null, { docId: 5 }]);
  assert.deepEqual(sources.map(source => [source.number, source.docId, source.chunkIds]),
    [[1, "jira:DB-12", ["jira:DB-12:0", "jira:DB-12:1"]], [2, "slack:db-oncall", ["slack:db-oncall:0"]]]);
  assert.equal(sources[1].title, "#db-oncall");
  assert.deepEqual(numberSources(undefined), []);
});

test("turns each line's markers into source numbers and keeps the fixed reply as one plain line", () => {
  const sources = numberSources([citation("jira:DB-12", 0, "DB-12"), citation("slack:db-oncall", 0, "#db-oncall")]);
  const text = "DB-12 (in progress) tracks the ledger database migration project. [jira:DB-12:0]\n" +
    "On-call blocker raised overnight: the database migration hit lock timeouts on the settlements table. [slack:db-oncall:0] [jira:DB-12:0]\n\n" +
    "A line with an unknown marker. [slack:elsewhere:0]";
  assert.deepEqual(answerLines(text, sources), [
    { text: "DB-12 (in progress) tracks the ledger database migration project.", refs: [1] },
    { text: "On-call blocker raised overnight: the database migration hit lock timeouts on the settlements table.", refs: [2, 1] },
    { text: "A line with an unknown marker. [slack:elsewhere:0]", refs: [] }
  ]);
  assert.deepEqual(answerLines(NO_RESULT, []), [{ text: NO_RESULT, refs: [] }]);
  assert.deepEqual(answerLines("", []), []);
});

test("finds a quoted line in its document, including the two forms that add a Jira status", () => {
  const oncall = content("slack:db-oncall");
  const [range] = quotedRanges(oncall, ["On-call blocker raised overnight: the database migration hit lock timeouts on the settlements table."]);
  assert.equal(oncall.slice(...range), "On-call blocker raised overnight: the database migration hit lock timeouts on the settlements table.");

  // The status goes after the key when the text starts with it, and in front of the text otherwise.
  const twelve = content("jira:DB-12");
  const [inserted] = quotedRanges(twelve, ["DB-12 (in progress) tracks the ledger database migration project."]);
  assert.equal(twelve.slice(...inserted), "DB-12 tracks the ledger database migration project.");
  const fifteen = content("jira:DB-15");
  const [prefixed] = quotedRanges(fifteen, ["DB-15 (blocked): Replica lag stays above five minutes during the backfill, so the final wave of the database migration cannot start."]);
  assert.equal(fifteen.slice(...prefixed), fifteen);
});

test("merges and sorts ranges, ignores spacing differences, and finds nothing for a sentence that isn't there", () => {
  const text = "First   sentence here.\nSecond sentence here. Third one.";
  assert.deepEqual(quotedRanges(text, ["Second sentence here.", "First sentence here.", "Second sentence here."]),
    [[0, 22], [23, 44]]);
  assert.deepEqual(quotedRanges(text, ["A sentence from somewhere else."]), []);
  assert.deepEqual(quotedRanges(undefined, ["First sentence here."]), []);
});

test("recognises the demo's placeholder addresses and nothing else", () => {
  assert.equal(isDemoAddress("https://slack.example/archives/C-DB-OPS"), true);
  assert.equal(isDemoAddress("https://jira.example/browse/DB-12"), true);
  assert.equal(isDemoAddress("https://company.atlassian.net/browse/DB-12"), false);
  assert.equal(isDemoAddress("https://example.com/page"), false);
  assert.equal(isDemoAddress("not a url"), false);
  assert.equal(isDemoAddress(undefined), false);
});

test("spots audit questions without catching the scenarios' document questions", () => {
  for (const question of [
    "Show me everything user 'ravi' accessed in the last 30 days",
    "Show me everything user 'jdoe' accessed related to the 'payment-gateway' Confluence space in the last 30 days",
    "Who retrieved the Payment gateway operations page?",
    "What did Alex ask yesterday?",
    "Search the audit log for denied access"
  ]) assert.equal(looksLikeAuditQuestion(question), true, question);
  for (const question of [
    "What's the status of the database migration project and were there any blockers raised in Slack last week?",
    "What's the latest runbook for the payment-service incident?",
    "Show me the security incident report from the Q3 breach",
    "Show me the zebra onboarding notes from the Q9 offsite",
    "What does PAY-101 need before cutover?",
    "Who owns the access controls for the payment gateway?"
  ]) assert.equal(looksLikeAuditQuestion(question), false, question);
});
