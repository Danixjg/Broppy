import test from "node:test";
import assert from "node:assert/strict";
import { nativeRestriction } from "./admin.js";

test("each source's own permissions are named, so an admin knows what may be narrowed", () => {
  assert.match(nativeRestriction("slack", { source: "slack", channelId: "C1", visibility: "public", members: [] }),
    /Slack channel C1/);
  assert.match(nativeRestriction("jira", { source: "jira", projectKey: "PAY", projectViewers: [] }), /Jira project PAY/);
  assert.match(nativeRestriction("confluence", { source: "confluence", spaceKey: "FIN", spaceViewers: [] }),
    /Confluence space FIN/);
  assert.match(nativeRestriction("drive", { source: "drive", fileId: "F1", owner: "ravi", sharedUsers: [] }),
    /Drive file F1/);
});

test("permissions from another source are not read as this one's", () => {
  assert.equal(nativeRestriction("slack", { source: "jira", projectKey: "PAY" }),
    "Native permission details are unavailable.");
  assert.equal(nativeRestriction("slack", undefined), "Native permission details are unavailable.");
  assert.equal(nativeRestriction("other", { source: "other" }), "Unknown source restrictions.");
});
