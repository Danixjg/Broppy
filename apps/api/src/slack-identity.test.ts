import { expect, it } from "vitest";
import { slackUserIdsFromEnv } from "./slack-identity.js";

it("uses only explicit unique workspace-to-Slack identity mappings", () => {
  expect(slackUserIdsFromEnv({ SLACK_USERS_JSON: JSON.stringify([{ name: "Maya", slackId: "U123", brainUserId: "maya" }, { name: "David", slackId: "U456" }]) })).toEqual({ maya: "U123" });
  expect(slackUserIdsFromEnv({})).toEqual({});
  for (const people of [
    [{ brainUserId: "maya", slackId: "maya@example.test" }],
    [{ brainUserId: "maya", slackId: "U1" }, { brainUserId: "david", slackId: "U1" }],
    [{ brainUserId: "maya", slackId: "U1" }, { brainUserId: "maya", slackId: "U2" }]
  ]) expect(() => slackUserIdsFromEnv({ SLACK_USERS_JSON: JSON.stringify(people) })).toThrow("Invalid Slack identity mapping");
});
