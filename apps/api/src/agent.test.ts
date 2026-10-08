import { describe, expect, it } from "vitest";
import type { ChatTurn, LlmClient } from "@brain/retrieval";
import { ActionLimit, AgentActions, cannedReply, parseHistory, plainIssue, routeTurn, typedProject, understandTurn } from "./agent.js";

const model = (answer: string | Error, seen: Array<{ system: string; turns: ChatTurn[] }> = []): LlmClient => ({
  generate: async () => { throw new Error("not used"); },
  converse: async (system, turns) => { seen.push({ system, turns }); if (answer instanceof Error) throw answer; return answer; }
});

describe("routeTurn", () => {
  it("sends small talk, requests to act and questions down different paths", () => {
    for (const text of ["hi", "Hello!", "thanks", "what can you do?", "good morning"]) expect(routeTurn(text)).toBe("chat");
    for (const text of ["create a Jira ticket for the login bug", "Can you open a ticket to fix the quota", "raise an issue about the DB migration"]) expect(routeTurn(text)).toBe("action");
    for (const text of ["how do I create a ticket?", "what is the status of DB-12", "hi, what is the status of DB-12?", "who owns the migration"]) expect(routeTurn(text)).toBe("question");
  });
});

describe("parseHistory", () => {
  it("keeps the last six plain turns and starts at a user turn", () => {
    const turns = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `t${index}` }));
    expect(parseHistory(turns).map(turn => turn.text)).toEqual(["t4", "t5", "t6", "t7", "t8", "t9"]);
    expect(parseHistory([{ role: "assistant", text: "a" }, { role: "user", text: "u" }, { role: "system", text: "x" }, { role: "user", text: 4 }])).toEqual([{ role: "user", text: "u" }]);
    expect(parseHistory("nope")).toEqual([]);
    expect(parseHistory([{ role: "user", text: "x".repeat(5000) }])[0].text).toHaveLength(2000);
  });
});

describe("cannedReply", () => {
  it("answers small talk without a model", () => {
    expect(cannedReply("thanks")).toBe("You're welcome.");
    expect(cannedReply("hi")).toMatch(/Ask me about your work/);
    expect(cannedReply("what can you do?")).toMatch(/Jira ticket/);
  });
});

describe("plainIssue", () => {
  it("uses a project only when the person typed it", () => {
    expect(plainIssue("create a ticket in project DB for the quota").project).toBe("DB");
    expect(typedProject("create a ticket in the OPS project")).toBe("OPS");
    expect(typedProject("create a ticket for the db migration")).toBeUndefined();
  });
  it("takes the title from the person's own words", () => {
    expect(plainIssue("Please create a Jira ticket for the quota increase.")).toMatchObject({ summary: "the quota increase" });
    expect(plainIssue("create a ticket for cleanup").id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("AgentActions", () => {
  it("creates once per confirmation, retries a failure, and caps each person per hour", async () => {
    let at = 0;
    const actions = new AgentActions(2, () => at);
    let runs = 0;
    const make = async () => { runs++; return { key: "DB-1" }; };
    const [first, second] = await Promise.all([actions.once("u", "p1", make), actions.once("u", "p1", make)]);
    expect(first).toBe(second); expect(runs).toBe(1);
    await expect(actions.once("u", "p2", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await actions.once("u", "p2", make)).toEqual({ key: "DB-1" });
    expect(() => actions.once("u", "p3", make)).toThrow(ActionLimit);
    expect(await actions.once("v", "p3", make)).toEqual({ key: "DB-1" });
    at = 3_700_000;
    expect(await actions.once("u", "p3", make)).toEqual({ key: "DB-1" });
  });
  it("does not remember a refusal as a created ticket", async () => {
    const actions = new AgentActions();
    expect(await actions.once("u", "p", async () => undefined)).toBeUndefined();
    expect(await actions.once("u", "p", async () => ({ key: "DB-2" }))).toEqual({ key: "DB-2" });
  });
  it("can be switched off", () => {
    expect(AgentActions.enabled({ AGENT_ACTIONS: "off" })).toBe(false);
    expect(AgentActions.enabled({})).toBe(true);
  });
});

describe("understandTurn", () => {
  const history = [{ role: "user" as const, text: "status of DB-12?" }, { role: "assistant" as const, text: "DB-12 is blocked." }];
  it("lets the model decide, in one call, from its own wording of the message", async () => {
    const seen: Array<{ system: string; turns: ChatTurn[] }> = [];
    expect(await understandTurn(model('{"kind":"chat","reply":"Hi! Ask me about your work."}', seen), [], "heya broppy, you there?"))
      .toEqual({ kind: "chat", reply: "Hi! Ask me about your work." });
    expect(seen).toHaveLength(1);
    expect(seen[0].turns).toEqual([{ role: "user", content: "heya broppy, you there?" }]);
    const ticket = await understandTurn(model('{"kind":"ticket","summary":"Raise ledger quota","description":"Ledger quota is too low.","dueDate":"2026-10-20"}'), [], "could someone log a card for the quota thing in project DB");
    expect(ticket).toMatchObject({ kind: "action", proposal: { summary: "Raise ledger quota", project: "DB", dueDate: "2026-10-20" } });
    expect(await understandTurn(model('{"kind":"question","question":"Who owns DB-12?"}'), history, "who owns it?")).toEqual({ kind: "question", question: "Who owns DB-12?" });
  });
  it("never lets the model pick the project, and keeps the message when its question is unusable", async () => {
    const ticket = await understandTurn(model('{"kind":"ticket","summary":"x","project":"OPS"}'), [], "log a card for x");
    expect(ticket.kind === "action" && ticket.proposal.project).toBeFalsy();
    expect(await understandTurn(model('{"kind":"question","question":"a\\nb"}'), [], "who owns it?")).toEqual({ kind: "question", question: "who owns it?" });
  });
  it("falls back to the fixed patterns without a model, on junk, or on an error", async () => {
    expect(await understandTurn(undefined, [], "hi")).toMatchObject({ kind: "chat" });
    expect(await understandTurn(model("sure thing"), [], "create a ticket for cleanup")).toMatchObject({ kind: "action", proposal: { summary: "cleanup" } });
    expect(await understandTurn(model(new Error("down")), [], "what is DB-12?")).toEqual({ kind: "question", question: "what is DB-12?" });
    expect(await understandTurn(model('{"kind":"chat","reply":""}'), [], "what is DB-12?")).toEqual({ kind: "question", question: "what is DB-12?" });
  });
});
