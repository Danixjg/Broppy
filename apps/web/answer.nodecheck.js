import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerLines, auditSummary, isDemoAddress, isRoutineSync, looksLikeAuditQuestion, numberSources, quotedRanges } from "./answer.js";

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

test("summarises audit events in plain words, without internal references", () => {
  const ref = "a".repeat(64);
  const entry = (type, data) => ({ sequence: 1, timestamp: "2026-10-03T14:27:08.000Z", type, actor: "ravi",
    data: { traceId: "t-1", orgId: "org_x", docRef: ref, chunkRef: ref, fromRef: ref, checkpointRef: ref, questionHash: ref, ...data } });
  const cases = [
    [entry("query_received", { question: "What's the status of DB-12?" }), "Asked: \"What's the status of DB-12?\""],
    [entry("query_planned", { sources: ["slack"], from: "2026-09-26T00:00:00.000Z", to: "2026-10-03T14:27:08.800Z" }), "Planned: Slack first, 2026-09-26 to 2026-10-03"],
    [entry("query_planned", { sources: [] }), "Planned: all sources"],
    [entry("candidates_found", { count: 8 }), "Found 8 candidates before any access check"],
    [entry("candidate_ranked", { docId: "jira:DB-12", score: 0.4706 }), "Ranked jira:DB-12 (score 0.4706)"],
    [entry("candidate_linked", { docId: "drive:db-wave-checklist", fromDocId: "jira:DB-12", score: 0.2353 }), "Linked drive:db-wave-checklist from jira:DB-12 (score 0.2353)"],
    [entry("access_decision", { docId: "jira:DB-12", allowed: true, reason: "fga" }), "Allowed jira:DB-12"],
    [entry("access_decision", { docId: "slack:db-oncall", allowed: false, reason: "fga" }), "Denied slack:db-oncall (no permission)"],
    [entry("access_decision", { docId: "drive:q3-incident", allowed: false, reason: "tier" }), "Denied drive:q3-incident (restricted tier)"],
    [entry("live_access_decision", { docId: "jira:DB-12", allowed: true, sourceVersion: 4, refreshed: false }), "Live check allowed jira:DB-12, version 4"],
    [entry("context_sent", { chunkIds: ["jira:DB-12:0", "slack:db-migration:0"] }), "Sent 2 passages to the writer: jira:DB-12:0, slack:db-migration:0"],
    [entry("llm_fallback", { reason: "rate_limited" }), "The built-in writer answered: the model service was busy"],
    [entry("llm_fallback", { reason: "ungrounded" }), "The built-in writer answered: the model quoted no source word for word"],
    [entry("output_access_decision", { docId: "jira:DB-12", allowed: true }), "Rechecked after writing: allowed jira:DB-12"],
    [entry("answer_returned", { answer: NO_RESULT, citationIds: [], empty: true }), "Answered with the fixed no-result reply"],
    [entry("answer_returned", { answer: "DB-12 (in progress) tracks the project. [jira:DB-12:0]\nThe [draft] plan is blocked. [jira:DB-15:0]", citationIds: ["jira:DB-12:0", "jira:DB-15:0"], empty: false }),
      "Answered with 2 citations: \"DB-12 (in progress) tracks the project. The [draft] plan is blocked.\""],
    [entry("document_synced", { docId: "slack:db-migration", contentChanged: false, permissionChanged: false }), "Synced slack:db-migration: no change"],
    [entry("document_synced", { docId: "slack:db-migration", contentChanged: false, permissionChanged: true }), "Synced slack:db-migration: permissions changed"],
    [entry("import_completed", { source: "slack", found: 5, indexed: 4, skipped: 1, failed: 0 }), "Finished importing Slack: 4 items indexed, 1 skipped"],
    [entry("sync_failed", { source: "jira" }), "Sync failed for Jira"],
    [entry("search_fallback", {}), "Searched the local index only: the Supabase search failed"],
    [entry("audit_searched", { query: "ravi", filters: { user: "ravi" }, results: 53 }), "Searched the audit for \"ravi\": 53 results"]
  ];
  for (const [event, summary] of cases) {
    assert.equal(auditSummary(event), summary);
    assert.doesNotMatch(auditSummary(event), /[0-9a-f]{64}|org_x|t-1/);
  }
  const unknown = auditSummary(entry("something_new", { docId: "jira:DB-12", note: "kept" }));
  assert.equal(unknown, "something new · docId: jira:DB-12 · note: kept");
  assert.equal(auditSummary(null), "");
});

test("has a summary of its own for every event the API writes", () => {
  const code = ["brain.ts", "server.ts"].map(file => readFileSync(new URL(`../api/src/${file}`, import.meta.url), "utf8")).join("\n");
  const types = [...new Set([...code.matchAll(/\b(?:append|audit)\(\s*"([a-z_]+)"/g)].map(match => match[1]))];
  assert.ok(types.length >= 35, `found only ${types.length} event types`);
  // An event without a summary of its own falls back to its type name with the underscores spaced out.
  for (const type of types) assert.notEqual(auditSummary({ type, data: {} }), type.replaceAll("_", " "), type);
});

test("treats only a sync that changed nothing as routine", () => {
  const sync = (contentChanged, permissionChanged) => ({ type: "document_synced", data: { docId: "jira:DB-12", contentChanged, permissionChanged } });
  assert.equal(isRoutineSync(sync(false, false)), true);
  assert.equal(isRoutineSync(sync(false, true)), false);
  assert.equal(isRoutineSync(sync(true, false)), false);
  assert.equal(isRoutineSync({ type: "document_synced", data: { docId: "jira:DB-12" } }), false);
  assert.equal(isRoutineSync({ type: "access_decision", data: { allowed: true } }), false);
  assert.equal(isRoutineSync(null), false);
});
