import { describe, expect, it } from "vitest";
import { answerBlocks, NOTHING_FOUND } from "./blocks.js";

const shown = (blocks: ReturnType<typeof answerBlocks>) => JSON.stringify(blocks);

describe("Slack answer blocks", () => {
  it("answer a miss in plain words that never hint something is hidden", () => {
    const miss = shown(answerBlocks("Q3 breach report?", { text: "No accessible information was found for this query.", citations: [] }, "https://broppy.example/a"));
    expect(miss).toContain(NOTHING_FOUND);
    expect(miss).not.toContain("No accessible information");
    expect(miss).not.toMatch(/restricted|denied|permission/i);
  });

  it("show a real answer as written", () => {
    const answer = { text: "DB-15 is blocked.", citations: [{ docId: "jira:DB-15", chunkId: "jira:DB-15:0", title: "DB-15", url: "https://jira.example/DB-15" }] };
    expect(shown(answerBlocks("Status?", answer as never, "https://broppy.example/a"))).toContain("DB-15 is blocked.");
  });
});
