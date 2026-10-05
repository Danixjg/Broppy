import { describe, expect, it } from "vitest";
import { fingerprint, similarity, tokens } from "./fingerprint.js";
import { formatDue, parseDue, scoreMessage, type Person } from "./score.js";

const people: Person[] = [{ slackId: "UMAYA", name: "Maya" }, { slackId: "UDAVID", name: "David" }];
const posted = new Date("2026-10-05T10:22:00Z"); // a Monday

describe("scoreMessage", () => {
  it("suggests the mockup's agreement with title, owner and date", () => {
    const r = scoreMessage("Agreed: Maya raises the replica storage quota before the final wave. Due Fri 16 Oct.", people, posted);
    expect(r.suggest).toBe(true);
    expect(r.title).toBe("Raise replica storage quota");
    expect(r.assignee?.slackId).toBe("UMAYA");
    expect(r.due).toBe("2026-10-16");
    expect(formatDue(r.due!)).toBe("Fri 16 Oct");
  });

  it("does not suggest a blocker report with no owner or agreement", () => {
    const r = scoreMessage("Blocker raised: the backfill job keeps timing out on the ledger database.", people, posted);
    expect(r.suggest).toBe(false);
  });

  it("is deterministic", () => {
    const text = "Agreed: David will fix the ledger timeout by Friday";
    expect(scoreMessage(text, people, posted)).toEqual(scoreMessage(text, people, posted));
  });

  it("holds back questions and hedges", () => {
    expect(scoreMessage("Could we maybe have Maya raise the quota?", people, posted).suggest).toBe(false);
  });

  it("needs someone to show the suggestion to", () => {
    const r = scoreMessage("Agreed: raise the replica storage quota by Fri 16 Oct", people, posted);
    expect(r.score).toBeGreaterThanOrEqual(0.6);
    expect(r.suggest).toBe(false);
  });

  it("recognises a Slack mention as the owner", () => {
    expect(scoreMessage("Action: <@UDAVID> to update the runbook by tomorrow", people, posted).assignee?.slackId).toBe("UDAVID");
  });
});

describe("parseDue", () => {
  it("resolves weekdays forward and day-month dates", () => {
    expect(parseDue("by Friday", posted)).toBe("2026-10-09");
    expect(parseDue("on 3 Nov", posted)).toBe("2026-11-03");
    expect(parseDue("nothing here", posted)).toBeUndefined();
  });
});

describe("fingerprint", () => {
  it("treats reworded repeats as the same task", () => {
    expect(fingerprint("DB", "Raise replica storage quota")).toBe(fingerprint("db", "Raise the replica storage quotas"));
    expect(similarity(tokens("Raise replica storage quota"), tokens("Raise the replica storage quota now"))).toBeGreaterThan(0.75);
    expect(similarity(tokens("Raise replica storage quota"), tokens("Rotate payment API keys"))).toBeLessThan(0.2);
  });
});
