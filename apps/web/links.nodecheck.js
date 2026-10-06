import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceTarget, linkedTask } from "./links.js";

test("Slack task and answer navigation preserve exact values in a local sign-in destination", () => {
  const task = "Increase quota & verify replicas";
  const ask = "What happened in DB?";
  const target = workspaceTarget({ task, ask, project: "DB", returnTo: "https://other.example" });
  const parsed = new URL(target, "https://brain.example");
  assert.equal(parsed.pathname, "/workspace/index.html");
  assert.equal(parsed.searchParams.get("task"), task);
  assert.equal(parsed.searchParams.get("ask"), ask);
  assert.equal(parsed.searchParams.get("returnTo"), null);
  const login = new URL(`/auth/login?${new URLSearchParams({ returnTo: target })}`, parsed.origin);
  assert.equal(login.searchParams.get("returnTo"), target);
  assert.equal(workspaceTarget({ ask: "x".repeat(501), project: ["DB"] }), "/workspace/index.html");
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
