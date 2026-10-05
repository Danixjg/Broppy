import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetedEmbedding, BudgetedLlm, modelsFromEnv, UsageMeter } from "./llm-budget.js";
import { ModelCallError, ModelUnavailable, type TokenUsage } from "./llm.js";

const context = [{ citation: "jira:PAY-101:0", text: "Cutover starts at 2 PM." }];
const dirs: string[] = [];
function usageFile() {
  const dir = mkdtempSync(join(tmpdir(), "llm-usage-"));
  dirs.push(dir);
  return join(dir, "usage.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function model(total: number) {
  return { reservation: () => 2000, generateWithUsage: vi.fn(async () => ({ text: "At 2 PM. [jira:PAY-101:0]",
    usage: { prompt: total / 2, completion: total / 2, total } })) };
}

// A model whose answers wait until finish() is called, to ask questions at the same moment.
function slowModel() {
  const waiting: Array<() => void> = [];
  return {
    finish: () => waiting.shift()?.(),
    reservation: () => 1000,
    generateWithUsage: vi.fn(() => new Promise<{ text: string; usage: TokenUsage }>(resolve => {
      waiting.push(() => resolve({ text: "At 2 PM. [jira:PAY-101:0]", usage: { prompt: 300, completion: 100, total: 400 } }));
    }))
  };
}

async function reason(promise: Promise<unknown>) {
  const failure = await promise.catch(error => error);
  expect(failure).toBeInstanceOf(ModelUnavailable);
  return (failure as ModelUnavailable).reason;
}

describe("UsageMeter and BudgetedLlm", () => {
  it("keeps counting across restarts and stops before the token budget is passed", async () => {
    const file = usageFile();
    const inner = model(600);
    expect(await new BudgetedLlm(inner, new UsageMeter(file, { chatTokens: 1000 })).generate(context, "q"))
      .toBe("At 2 PM. [jira:PAY-101:0]");
    // A restart reads the same file.
    const restarted = new BudgetedLlm(inner, new UsageMeter(file, { chatTokens: 1000 }));
    await restarted.generate(context, "q");
    expect(new UsageMeter(file, {}).usage().chatTokens).toBe(1200);
    expect(await reason(restarted.generate(context, "q"))).toBe("budget");
    expect(inner.generateWithUsage).toHaveBeenCalledTimes(2);
  });

  it("allows a set number of model answers per UTC day", async () => {
    let now = new Date("2026-10-15T23:00:00.000Z");
    const inner = model(100);
    const llm = new BudgetedLlm(inner, new UsageMeter(usageFile(), { dailyAnswers: 2 }, () => now));
    await llm.generate(context, "q");
    await llm.generate(context, "q");
    expect(await reason(llm.generate(context, "q"))).toBe("daily_limit");
    now = new Date("2026-10-16T00:01:00.000Z");
    await llm.generate(context, "q");
    expect(inner.generateWithUsage).toHaveBeenCalledTimes(3);
  });

  it("calls no model when the usage file can't be read or written", async () => {
    const corrupt = usageFile();
    writeFileSync(corrupt, "not json");
    const inner = model(100);
    expect(await reason(new BudgetedLlm(inner, new UsageMeter(corrupt, { chatTokens: 1000 })).generate(context, "q")))
      .toBe("meter");
    const missingDir = join(usageFile(), "missing", "usage.json");
    expect(await reason(new BudgetedLlm(inner, new UsageMeter(missingDir, { chatTokens: 1000 })).generate(context, "q")))
      .toBe("meter");
    expect(inner.generateWithUsage).not.toHaveBeenCalled();
  });

  it("counts calls still running against the limits, so questions asked together can't all get through", async () => {
    const slow = slowModel();
    const file = usageFile();
    const byTokens = new BudgetedLlm(slow, new UsageMeter(file, { chatTokens: 1000 }));
    // The first call holds its reservation (1000) until it ends.
    const first = byTokens.generate(context, "q");
    expect(await reason(byTokens.generate(context, "q"))).toBe("budget");
    slow.finish();
    await first;
    expect(new UsageMeter(file, {}).usage().chatTokens).toBe(400);
    // Once it ends, only what it used counts.
    const second = byTokens.generate(context, "q");
    slow.finish();
    await second;
    expect(slow.generateWithUsage).toHaveBeenCalledTimes(2);

    const byAnswers = new BudgetedLlm(slow, new UsageMeter(undefined, { dailyAnswers: 1 }));
    const third = byAnswers.generate(context, "q");
    expect(await reason(byAnswers.generate(context, "q"))).toBe("daily_limit");
    slow.finish();
    await third;
  });

  it("counts what a failed call may have cost: the reported tokens, else its whole reservation", async () => {
    const meter = new UsageMeter(usageFile(), { chatTokens: 100_000 });
    const cases: Array<[Error, number]> = [
      [new ModelCallError("Model answer cut off at LLM_MAX_TOKENS", { prompt: 100, completion: 1500, total: 1600 }), 1600],
      [new ModelCallError("Model request failed"), 2000],
      [new Error("Model request refused"), 0],
      [new ModelUnavailable("rate_limited"), 0]
    ];
    let expected = 0;
    for (const [error, cost] of cases) {
      const inner = { reservation: () => 2000, generateWithUsage: vi.fn(async () => { throw error; }) };
      await expect(new BudgetedLlm(inner, meter).generate(context, "q")).rejects.toBe(error);
      expected += cost;
      expect(meter.usage()).toMatchObject({ chatTokens: expected, answersToday: 0 });
    }
  });

  it("counts in memory when no file is set, for a provider that can't bill", async () => {
    const inner = model(100);
    const llm = new BudgetedLlm(inner, new UsageMeter(undefined, { dailyAnswers: 1 }));
    await llm.generate(context, "q");
    expect(await reason(llm.generate(context, "q"))).toBe("daily_limit");
  });
});

describe("BudgetedEmbedding", () => {
  it("stops embedding at its budget and says so before sync asks", async () => {
    const inner = { embedWithUsage: vi.fn(async () => ({ vector: [1, 0], tokens: 30 })) };
    const embedding = new BudgetedEmbedding(inner, new UsageMeter(usageFile(), { embeddingTokens: 50 }));
    expect(embedding.available()).toBe(true);
    expect(await embedding.embed("one")).toEqual([1, 0]);
    await embedding.embed("two");
    expect(embedding.available()).toBe(false);
    expect(await reason(embedding.embed("three"))).toBe("budget");
    expect(inner.embedWithUsage).toHaveBeenCalledTimes(2);
  });

  it("counts a failed call by its estimate when the provider's count is unknown", async () => {
    const meter = new UsageMeter(undefined, { embeddingTokens: 1000 });
    const inner = { embedWithUsage: vi.fn(async () => { throw new ModelCallError("Hunyuan embedding request failed"); }) };
    await expect(new BudgetedEmbedding(inner, meter).embed("x".repeat(30))).rejects.toThrow(ModelCallError);
    expect(meter.usage().embeddingTokens).toBe(10);
  });
});

describe("modelsFromEnv", () => {
  it("leaves the built-in writer in charge without settings", () => {
    expect(modelsFromEnv({})).toEqual({});
  });

  it("refuses to start Hunyuan without a usage file and budgets, so it can never go past the free tokens", () => {
    const hunyuan = { HUNYUAN_API_KEY: "key", HUNYUAN_MODEL: "hunyuan-t1-latest" };
    expect(() => modelsFromEnv(hunyuan)).toThrow(/LLM_USAGE_FILE.*LLM_TOKEN_BUDGET/);
    expect(() => modelsFromEnv({ ...hunyuan, LLM_USAGE_FILE: usageFile() })).toThrow(/LLM_TOKEN_BUDGET/);
    expect(modelsFromEnv({ ...hunyuan, LLM_USAGE_FILE: usageFile(), LLM_TOKEN_BUDGET: "800000" }).llm)
      .toBeInstanceOf(BudgetedLlm);
    expect(() => modelsFromEnv({ HUNYUAN_EMBEDDING_API_KEY: "key", LLM_USAGE_FILE: usageFile() }))
      .toThrow(/EMBEDDING_TOKEN_BUDGET/);
    expect(modelsFromEnv({ HUNYUAN_EMBEDDING_API_KEY: "key", LLM_USAGE_FILE: usageFile(), EMBEDDING_TOKEN_BUDGET: "800000" })
      .embedding).toBeInstanceOf(BudgetedEmbedding);
  });

  it("lets Cloudflare embeddings run without a budget, since its free plan can't bill", () => {
    const cloudflare = { EMBEDDING_PROVIDER: "cloudflare", EMBEDDING_API_KEY: "token",
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" };
    expect(modelsFromEnv(cloudflare).embedding).toBeInstanceOf(BudgetedEmbedding);
    expect(modelsFromEnv({ ...cloudflare, LLM_USAGE_FILE: usageFile(), EMBEDDING_TOKEN_BUDGET: "100000" }).embedding)
      .toBeInstanceOf(BudgetedEmbedding);
  });

  it("refuses to start TokenHub without a usage file and budget, since Tencent bills if post-paid is turned on", () => {
    const tokenhub = { LLM_PROVIDER: "tokenhub", LLM_API_KEY: "key", LLM_MODEL: "hy3" };
    expect(() => modelsFromEnv(tokenhub)).toThrow(/^TokenHub needs LLM_USAGE_FILE and LLM_TOKEN_BUDGET/);
    expect(() => modelsFromEnv({ ...tokenhub, LLM_TOKEN_BUDGET: "100000" })).toThrow(/LLM_USAGE_FILE/);
    expect(modelsFromEnv({ ...tokenhub, LLM_USAGE_FILE: usageFile(), LLM_TOKEN_BUDGET: "100000" }).llm)
      .toBeInstanceOf(BudgetedLlm);
  });

  it("lets Groq run without a budget, and checks the numbers it is given", () => {
    const groq = { LLM_PROVIDER: "groq", LLM_API_KEY: "key", LLM_MODEL: "llama-3.3-70b-versatile" };
    expect(modelsFromEnv(groq).llm).toBeInstanceOf(BudgetedLlm);
    expect(modelsFromEnv({ ...groq, LLM_DAILY_ANSWERS: "100" }).llm).toBeInstanceOf(BudgetedLlm);
    for (const bad of [{ LLM_TOKEN_BUDGET: "-5" }, { LLM_DAILY_ANSWERS: "many" }, { LLM_TOKEN_BUDGET: "1.5" }]) {
      expect(() => modelsFromEnv({ ...groq, ...bad })).toThrow();
    }
  });
});
