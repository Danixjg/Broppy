import { describe, expect, it } from "vitest";
import { formatReview, reviewReplies } from "./llm-check.js";

const SCENARIO_1 = "What's the status of the database migration project and were there any blockers raised in Slack last week?";

describe("pnpm llm:check", () => {
  it("shows the checker's verdict on every line a model writes, with what backs it or why it was left out", async () => {
    const model = {
      generate: async (context: Array<{ citation: string; text: string }>) => [
        `${context[0].text.split(/(?<=[.!?])\s+/)[0]} [${context[0].citation}]`,
        ...(context.some(item => item.citation === "jira:DB-12:0")
          ? ["Waves 1 and 2 are done, and wave 3 is waiting on DB-15. [jira:DB-12:0]", "Waves one and three are complete. [jira:DB-12:0]"]
          : [])
      ].join("\n")
    };
    const replies = await reviewReplies(model, [["david", SCENARIO_1], ["wei", "Show me the security incident report from the Q3 breach"]]);
    expect(replies[0].kept.map(line => line.kind)).toEqual(["quoted", "reworded"]);
    expect(replies[0].kept[1].support).toEqual(["Waves one and two are complete, and wave three waits on DB-15."]);
    expect(replies[0].removed).toEqual([{ text: "Waves one and three are complete.", reason: "new_fact", detail: expect.stringContaining("three") }]);
    // Nothing the contractor may see, so the model is never asked.
    expect(replies[1]).toMatchObject({ user: "wei", kept: [], removed: [] });

    const text = formatReview(replies);
    expect(text).toContain("kept, reworded");
    expect(text).toContain("backed by: \"Waves one and two are complete, and wave three waits on DB-15.\"");
    expect(text).toContain("left out (new_fact)");
    expect(text).toContain("Waves one and three are complete.");
    expect(text).toContain("no model call: nothing the asker may see");
    expect(text).toContain("Totals: 3 lines from the model: 1 copied, 1 reworded, 1 left out (new_fact 1). " +
      "No reply was replaced by the built-in writer.");
  });

  it("marks a reply the built-in writer replaced, and lists the model's lines it left out", async () => {
    const model = { generate: async () => "PAY-101 just needs the SEC-44 drill done first. [jira:PAY-101:0]" };
    const replies = await reviewReplies(model, [["ravi", "What does PAY-101 need before cutover?"]]);
    expect(replies[0].fallback).toBe("ungrounded");
    expect(replies[0].removed.map(item => item.text)).toEqual(["PAY-101 just needs the SEC-44 drill done first."]);
    const text = formatReview(replies);
    expect(text).toContain("the built-in writer answered instead (ungrounded)");
    expect(text).toContain("Totals: 1 line from the model: 0 copied, 0 reworded, 1 left out");
    expect(text).toContain("1 reply was replaced by the built-in writer.");
  });
});
