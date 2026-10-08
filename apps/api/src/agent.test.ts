import { describe, expect, it } from "vitest";
import type { ChatTurn, LlmClient } from "@brain/retrieval";
import { ActionLimit, AgentActions, chatReply, parseHistory, proposeIssue, routeTurn, standaloneQuestion, typedProject } from "./agent.js";

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

describe("chatReply", () => {
  it("asks the model with only the conversation, never workspace content", async () => {
    const seen: Array<{ system: string; turns: ChatTurn[] }> = [];
    expect(await chatReply(model("Hello there.", seen), [], "hi")).toBe("Hello there.");
    expect(seen[0].turns).toEqual([{ role: "user", content: "hi" }]);
    expect(seen[0].system).toMatch(/no company information/);
  });
  it("answers without a model, or when the model fails", async () => {
    expect(await chatReply(undefined, [], "thanks")).toBe("You're welcome.");
    expect(await chatReply(model(new Error("down")), [], "hi")).toMatch(/Ask me about your work/);
    expect(await chatReply({ generate: async () => "" }, [], "what can you do?")).toMatch(/Jira ticket/);
  });
});

describe("proposeIssue", () => {
  it("takes the title and date from the model but never picks the project", async () => {
    const proposal = await proposeIssue(model('{"summary":"Fix login redirect","description":"Users loop back to login.","dueDate":"2026-10-20"}'), [], "create a ticket to fix the login redirect");
    expect(proposal).toMatchObject({ summary: "Fix login redirect", description: "Users loop back to login.", dueDate: "2026-10-20" });
    expect(proposal.project).toBeUndefined();
    expect(proposal.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("uses a project only when the person typed it", async () => {
    expect((await proposeIssue(undefined, [], "create a ticket in project DB for the quota")).project).toBe("DB");
    expect(typedProject("create a ticket in the OPS project")).toBe("OPS");
    expect(typedProject("create a ticket for the db migration")).toBeUndefined();
  });
  it("falls back to the person's own words when the model is unavailable or returns junk", async () => {
    expect(await proposeIssue(undefined, [], "Please create a Jira ticket for the quota increase.")).toMatchObject({ summary: "the quota increase" });
    expect(await proposeIssue(model("sure!"), [], "create a ticket for cleanup")).toMatchObject({ summary: "cleanup" });
    expect(await proposeIssue(model('{"summary":"x","dueDate":"tomorrow"}'), [], "create a ticket for x")).not.toHaveProperty("dueDate");
  });
});

describe("standaloneQuestion", () => {
  const history = [{ role: "user" as const, text: "status of DB-12?" }, { role: "assistant" as const, text: "DB-12 is blocked." }];
  it("restates a follow-up that leans on the earlier turns", async () => {
    expect(await standaloneQuestion(model("Who owns DB-12?"), history, "who owns it?")).toBe("Who owns DB-12?");
  });
  it("leaves a question that stands alone, and ignores a bad rewrite", async () => {
    expect(await standaloneQuestion(model("never"), history, "What is the status of the Q3 ledger migration plan?")).toBe("What is the status of the Q3 ledger migration plan?");
    expect(await standaloneQuestion(model("a\nb"), history, "who owns it?")).toBe("who owns it?");
    expect(await standaloneQuestion(model("x"), [], "who owns it?")).toBe("who owns it?");
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
