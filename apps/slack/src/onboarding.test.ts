import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { confirmProposal } from "./actions.js";
import { buttonValue, setup, suggestion } from "./test-fixtures.js";

describe("customer Slack onboarding baseline", () => {
  it("offers Add to Slack separately from delegated source connections", () => {
    expect(readFileSync("apps/web/connectors.html", "utf8")).toContain('id="slack-bot"');
  });
  it("withholds a proposal from another installed workspace before Jira writes", async () => {
    const ctx = setup();
    const value = buttonValue(await suggestion(ctx));
    const proposal = await ctx.deps.store.getProposal(JSON.parse(value).id);
    if (!proposal) throw new Error("Expected proposal");
    Object.assign(ctx.deps, { workspace: { appId: "AAPP", teamId: "TOTHER", orgId: "org-b", generation: 1, current: async () => true } });
    await confirmProposal(ctx.deps, proposal, "UMAYA");
    expect(ctx.calls.created).toHaveLength(0);
    expect(ctx.calls.messages).toHaveLength(0);
  });
});
