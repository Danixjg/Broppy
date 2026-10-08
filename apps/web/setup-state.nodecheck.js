import test from "node:test";
import assert from "node:assert/strict";
import { addedMessage, checkLines, currentStep, parseEmails, plainError, returnMessage, setupSteps, toolState } from "./setup-state.js";

const connection = (source, extra = {}) => ({ source, status: "Connected", scope: {}, count: 0, ...extra });

test("shows each tool as not connected, connected, reading with progress, ready or needing attention", () => {
  assert.equal(toolState(undefined).state, "not_connected");
  assert.equal(toolState(connection("jira", { status: "Not connected" })).state, "not_connected");
  assert.equal(toolState(connection("jira")).state, "connected");
  assert.deepEqual(toolState(connection("jira", { status: "Importing" }), { status: "running", found: 40, indexed: 8, skipped: 2, failed: 0 }),
    { state: "reading", label: "Reading", percent: 25, found: 40, done: 10 });
  assert.equal(toolState(connection("jira", { status: "Importing" }), { status: "running", found: 0, indexed: 0, skipped: 0 }).percent, 0);
  assert.deepEqual(toolState(connection("jira", { scope: { mode: "all" }, count: 12 }), { status: "complete", failed: 1 }), { state: "ready", label: "Ready", items: 12, failed: 1 });
  assert.equal(toolState(connection("slack", { status: "Error", error: "Token rejected" })).detail, "Token rejected");
});

test("the first step not done is the current one, and connecting a tool comes first", () => {
  const none = setupSteps({});
  assert.deepEqual(none.map(step => step.status), ["current", "waiting", "waiting", "waiting", "waiting"]);
  assert.equal(currentStep(none), "connect");
  const connected = setupSteps({ connections: [connection("jira")] });
  assert.deepEqual(connected.map(step => step.status), ["done", "current", "waiting", "waiting", "waiting"]);
  const reading = setupSteps({ connections: [connection("jira", { scope: { mode: "all" }, count: 5 }), connection("slack")] });
  assert.equal(reading[1].status, "current", "a connected tool still waiting to be read keeps step two open");
});

test("adding a team and choosing an AI can be skipped, then the last step opens", () => {
  const ready = { connections: [connection("jira", { scope: { mode: "all" }, count: 5 })], people: [{ status: "active" }] };
  assert.equal(currentStep(setupSteps(ready)), "team");
  assert.equal(currentStep(setupSteps({ ...ready, skipped: ["team"] })), "ai");
  assert.equal(currentStep(setupSteps({ ...ready, people: [{ status: "active" }, { status: "invited" }] })), "ai");
  assert.equal(currentStep(setupSteps({ ...ready, people: [{ status: "active" }, { status: "removed" }] })), "team");
  assert.equal(currentStep(setupSteps({ ...ready, skipped: ["team", "model"] })), "ready");
  assert.equal(currentStep(setupSteps({ ...ready, skipped: ["team"], model: { provider: "anthropic", model: "m" } })), "ready");
});

test("reads work emails from pasted text, once each, and sets aside what is not an email", () => {
  const { valid, invalid } = parseEmails("Priya@Company.test, raj@company.test;\npriya@company.test  <Wei@company.test>\nnot an email\nx@y");
  assert.deepEqual(valid, ["priya@company.test", "raj@company.test", "wei@company.test"]);
  assert.deepEqual(invalid, ["not", "an", "email", "x@y"]);
  assert.deepEqual(parseEmails(""), { valid: [], invalid: [] });
  assert.deepEqual(parseEmails(undefined), { valid: [], invalid: [] });
});

test("says what happened when the admin comes back from a tool's approval page", () => {
  const message = query => returnMessage(new URLSearchParams(query));
  assert.deepEqual(message("connected=jira"), { kind: "good", text: "Jira is connected." });
  assert.match(message("connect_failed=slack&reason=email_mismatch").text, /^Slack: .*same email/);
  assert.match(message("connect_failed=drive&reason=denied").text, /^Google Drive: You cancelled/);
  assert.match(message("connect_failed=drive&reason=unknown").text, /didn't accept/);
  assert.equal(message("slack_install=installed").kind, "good");
  assert.equal(message("slack_install=denied").kind, "bad");
  assert.match(message("slack_install=conflict").text, /another company/);
  assert.equal(message("slack_install=failed").kind, "bad");
  assert.equal(message(""), undefined);
});

test("puts API errors in plain words", () => {
  assert.match(plainError("Source OAuth is not configured"), /isn't switched on/);
  assert.match(plainError("Forbidden"), /admin/);
  assert.match(plainError("TypeError: Failed to fetch"), /Couldn't reach/);
  assert.equal(plainError("Enter a valid work email address."), "Enter a valid work email address.");
  assert.match(plainError(""), /Something went wrong/);
});

test("lists the tools that don't know a person's email, and words each invitation outcome", () => {
  assert.deepEqual(checkLines({ slack: "found", jira: "not_found", confluence: "unavailable", drive: "not_checked" }),
    ["Jira has no account for this email", "Confluence couldn't be checked just now"]);
  assert.deepEqual(checkLines(undefined), []);
  assert.equal(addedMessage("a@b.test", { auth0: "invited" }), "a@b.test: invitation sent.");
  assert.match(addedMessage("a@b.test", { auth0: "not_configured" }), /aren't switched on/);
  assert.match(addedMessage("a@b.test", { auth0: "failed" }), /could not be sent/);
});
