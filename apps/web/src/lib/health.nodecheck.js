import test from "node:test";
import assert from "node:assert/strict";
import { healthLine, plainSourceError, timeAgo } from "./health.js";

test("a source that is not connected says so, and who can connect it", () => {
  assert.deepEqual(healthLine({ status: "Not connected", items: 0 }, true),
    { text: "Not connected", kind: "muted" });
  assert.equal(healthLine({ status: "Not connected", items: 0 }, false).text,
    "Not connected · your admin can connect it");
});

test("a ready source says how much it read", () => {
  assert.equal(healthLine({ status: "Connected", items: 12 }, true).text, "Ready · 12 items");
  assert.equal(healthLine({ status: "Connected", items: 1 }, true).text, "Ready · 1 item");
});

test("a source with nothing in it says what to do next", () => {
  assert.match(healthLine({ status: "Connected", items: 0, scope: "none" }, true).text, /reading nothing yet/);
  assert.equal(healthLine({ status: "Connected", items: 0 }, true).kind, "warn");
});

test("an import in progress says how far it has got", () => {
  assert.equal(healthLine({ status: "Importing", items: 0, job: { status: "running", found: 20, indexed: 3 } }, true).text,
    "Reading · 3 of 20 items");
  assert.equal(healthLine({ status: "Importing", items: 0, job: { status: "running", found: 0, indexed: 0 } }, true).text,
    "Reading…");
});

test("an error is said in words an admin can act on, and keeps the source's own text", () => {
  const line = healthLine({ status: "Error", items: 0, error: "(401) credential was rejected" }, true);
  assert.match(line.text, /^Needs attention: /);
  assert.equal(line.kind, "bad");
  assert.equal(line.detail, "(401) credential was rejected");
});

test("each kind of failure gets its own words", () => {
  assert.match(plainSourceError("(401) credential was rejected"), /Reconnect it/);
  assert.match(plainSourceError("Reading stopped before it finished"), /carries on at the next sync/);
  assert.match(plainSourceError("(429) rate limited"), /slow down/);
  assert.match(plainSourceError("fetch failed"), /didn't answer in time/);
  assert.match(plainSourceError("something else"), /Press Sync now/);
});

test("the last sync reads as a moment ago, and a missing time reads as nothing", () => {
  assert.equal(timeAgo(new Date().toISOString()), "just now");
  assert.equal(timeAgo(new Date(Date.now() - 3 * 60 * 1000).toISOString()), "3 minutes ago");
  assert.equal(timeAgo(new Date(Date.now() - 2 * 3600 * 1000).toISOString()), "2 hours ago");
  assert.equal(timeAgo("not a date"), "");
});
