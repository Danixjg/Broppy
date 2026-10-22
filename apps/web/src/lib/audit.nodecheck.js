import test from "node:test";
import assert from "node:assert/strict";
import { auditCsv, csvCell, localAuditSearch } from "./audit.js";

const entry = (type, actor, data = {}) => ({ sequence: 1, timestamp: "2026-01-01T00:00:00.000Z", type, actor, data, hash: "abc" });

test("a search matches the entry's type, actor and details", () => {
  const entries = [
    entry("access_decision", "ravi", { docId: "jira:PAY-1", allowed: false }),
    entry("query_received", "alex", { question: "payroll" })
  ];
  assert.deepEqual(localAuditSearch(entries, "ravi"), [entries[0]]);
  assert.deepEqual(localAuditSearch(entries, "payroll"), [entries[1]]);
});

test("the words that carry no meaning are dropped, and the rest must all match", () => {
  const entries = [entry("access_decision", "ravi", { docId: "jira:PAY-1", allowed: false })];
  assert.deepEqual(localAuditSearch(entries, "show me the events for access"), entries);
  assert.deepEqual(localAuditSearch(entries, "access ravi"), entries);
  assert.deepEqual(localAuditSearch(entries, "access alex"), []);
});

test("a denied answer is found by the word people ask with", () => {
  const entries = [entry("access_decision", "ravi", { docId: "jira:PAY-1", allowed: false })];
  assert.deepEqual(localAuditSearch(entries, "denied"), entries);
  assert.deepEqual(localAuditSearch(entries, "allowed"), []);
});

test("an empty question matches everything", () => {
  const entries = [entry("query_received", "ravi")];
  assert.deepEqual(localAuditSearch(entries, "   "), entries);
});

test("a cell is quoted, and a formula never runs", () => {
  assert.equal(csvCell("plain"), '"plain"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("=SUM(A1)"), '"\'=SUM(A1)"');
  assert.equal(csvCell(undefined), '""');
});

test("the export names its columns and keeps one line per entry", () => {
  const csv = auditCsv([entry("query_received", "ravi", { question: "payroll" })]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], '"sequence","timestamp","type","actor","details","hash"');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /"query_received"/);
  assert.match(lines[1], /payroll/);
});
