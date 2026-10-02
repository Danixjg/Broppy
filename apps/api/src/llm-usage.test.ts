import { describe, expect, it, vi } from "vitest";
import { loadMockCorpus } from "@brain/connectors";
import { calibrate, CALIBRATION, formatCalibration } from "./llm-calibrate.js";
import { formatUsageReport, measureUsage } from "./llm-usage.js";
import { ModelCallError, ModelUnavailable } from "./llm.js";

// Copies the first context sentence, as a well-behaved model would, and reports a fixed token count.
const model = (total: number) => ({
  generateWithUsage: vi.fn(async (context: Array<{ citation: string; text: string }>) => ({
    text: `${context[0].text.split(/(?<=[.!?])\s+/)[0]} [${context[0].citation}]`,
    usage: { prompt: total - 100, completion: 100, total }
  }))
});

describe("pnpm llm:usage", () => {
  it("projects the planned answers against the free tokens", async () => {
    const small = await measureUsage(model(1000));
    expect(small.average).toBe(1000);
    expect(small.projected).toBe(350_000);
    expect(small.fits).toBe(true);
    // Nothing the contractor may see, so the model is never called.
    expect(small.calls.find(call => call.user === "wei")?.usage).toBeUndefined();
    expect(formatUsageReport(small)).toContain("Verdict: fits");

    const large = await measureUsage(model(2500));
    expect(large.fits).toBe(false);
    expect(formatUsageReport(large)).toContain("Use Groq's free plan instead");
  });

  it("says so when no model answer could be measured", async () => {
    const failing = { generateWithUsage: vi.fn(async () => { throw new ModelUnavailable("rate_limited"); }) };
    const report = await measureUsage(failing, { questions: [["ravi", "What does PAY-101 need before cutover?"]] });
    expect(report.fits).toBe(false);
    expect(report.calls[0].fallback).toBe("rate_limited");
    expect(formatUsageReport(report)).toContain("No model answers were measured");
  });

  it("reports a reply with nothing copied word for word as no usable answer, counting its tokens", async () => {
    const paraphrasing = { generateWithUsage: vi.fn(async () => ({
      text: "PAY-101 just needs the SEC-44 drill done first. [jira:PAY-101:0]",
      usage: { prompt: 900, completion: 100, total: 1000 }
    })) };
    const report = await measureUsage(paraphrasing, { questions: [["ravi", "What does PAY-101 need before cutover?"]] });
    expect(report.calls[0]).toMatchObject({ usage: { total: 1000 }, fallback: "ungrounded" });
    expect(report.fits).toBe(false);
    const text = formatUsageReport(report);
    expect(text).toContain("no model answer (ungrounded)");
    expect(text).toContain("No model answers were measured");
    expect(text).toContain("word for word");
  });

  it("counts the tokens of an answer cut off at the limit, and says why it gave no answer", async () => {
    const cutOff = {
      generateWithUsage: vi.fn(async (context: Array<{ citation: string; text: string }>, question: string) => {
        if (question.includes("PAY-101")) {
          throw new ModelCallError("Model answer cut off at LLM_MAX_TOKENS", { prompt: 400, completion: 1500, total: 1900 });
        }
        return { text: `${context[0].text.split(/(?<=[.!?])\s+/)[0]} [${context[0].citation}]`,
          usage: { prompt: 900, completion: 100, total: 1000 } };
      })
    };
    const report = await measureUsage(cutOff, { questions: [
      ["ravi", "What does PAY-101 need before cutover?"],
      ["maya", "How do we handle a chargeback dispute?"]
    ] });
    expect(report.calls[0]).toMatchObject({ usage: { total: 1900 }, fallback: "error",
      error: "Model answer cut off at LLM_MAX_TOKENS" });
    expect(report.average).toBe(1450);
    expect(report.fits).toBe(true);
    const text = formatUsageReport(report);
    expect(text).toContain("cut off at LLM_MAX_TOKENS");
    expect(text).toContain("1 of 2 model calls gave no usable answer");
  });
});

describe("pnpm llm:calibrate", () => {
  it("scores every labelled question against every document and suggests a cut-off", async () => {
    // A toy embedding: counts of a few topic words, so related texts point the same way.
    const words = ["database", "migration", "runbook", "payment", "cutover", "incident", "chargeback", "vendor", "gateway",
      "ledger"];
    const embed = async (text: string) => words.map(word => (text.toLowerCase().match(new RegExp(word, "g")) ?? []).length + 0.01);
    const result = await calibrate({ embed });
    const labelled = CALIBRATION.reduce((sum, item) => sum + item.relevant.length, 0);
    expect(result.relevant).toHaveLength(labelled);
    const documents = (await Promise.all(Object.values(loadMockCorpus().connectors).map(source => source.listIds()))).flat();
    expect(result.relevant.length + result.irrelevant.length).toBe(CALIBRATION.length * documents.length);
    expect(result.suggestion).toBeGreaterThan(0);
    expect(result.suggestion).toBeLessThanOrEqual(1);
    expect(formatCalibration(result)).toContain("Suggested SEMANTIC_MIN");
  });
});
