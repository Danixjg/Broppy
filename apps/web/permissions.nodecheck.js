import test from "node:test";
import assert from "node:assert/strict";
import { narrowerPermissionError } from "./permissions.js";

const base = native => ({ users: ["ravi", "maya"], groups: ["payments"], public: false, native });
const cases = [
  ["slack", { source: "slack", channelId: "c1", visibility: "private", members: ["ravi", "maya"] }, { members: ["maya"] }, { visibility: "public" }],
  ["jira", { source: "jira", projectKey: "PAY", projectViewers: ["ravi", "maya"], issueViewers: ["maya"] }, { projectViewers: ["maya"] }, { issueViewers: ["ravi"] }],
  ["confluence", { source: "confluence", spaceKey: "PAY", spaceViewers: ["ravi", "maya"], pageViewers: ["maya"] }, { spaceViewers: ["maya"] }, { pageViewers: undefined }],
  ["drive", { source: "drive", fileId: "file1", owner: "maya", sharedUsers: ["ravi", "maya"] }, { sharedUsers: ["maya"] }, { owner: "ravi" }]
];

for (const [source, native, narrow, widen] of cases) {
  test(`${source} native edit accepts narrowing and rejects widening`, () => {
    const current = base(native);
    assert.equal(narrowerPermissionError(base({ ...native, ...narrow }), current, source), null);
    assert.match(narrowerPermissionError(base({ ...native, ...widen }), current, source), /only|Keep/);
    assert.match(narrowerPermissionError({ ...current, users: ["alex"] }, current, source), /only/);
  });
}

test("public Slack access can become private while source identifiers remain fixed", () => {
  const current = { users: [], groups: [], public: true, native: { source: "slack", channelId: "c1", visibility: "public", members: [] } };
  const narrowed = { ...current, public: false, native: { ...current.native, visibility: "private", members: ["maya"] } };
  assert.equal(narrowerPermissionError(narrowed, current, "slack"), null);
  assert.match(narrowerPermissionError({ ...narrowed, native: { ...narrowed.native, channelId: "c2" } }, current, "slack"), /channel ID/);
});
