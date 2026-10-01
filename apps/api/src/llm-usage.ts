import { pathToFileURL } from "node:url";
import type { LlmClient } from "@brain/retrieval";
import { Brain } from "./brain.js";
import { modelsFromEnv, type UsageReportingLlm } from "./llm-budget.js";
import { ModelCallError, type TokenUsage } from "./llm.js";

/** What the demo, the video and the judges are likely to ask, by the people who would ask it. */
export const USAGE_QUESTIONS: ReadonlyArray<readonly [string, string]> = [
  ["david", "What's the status of the database migration project and were there any blockers raised in Slack last week?"],
  ["ravi", "What's the status of the database migration project and were there any blockers raised in Slack last week?"],
  ["david", "What's the latest runbook for the payment-service incident?"],
  ["ravi", "What does PAY-101 need before cutover?"],
  ["alex", "Summarize the current payment migration status, PAY-101, SEC-44, cutover decisions and the chargeback workflow for a new intern. Cite accessible sources only."],
  ["ravi", "Payment gateway operations"],
  ["maya", "What is the settlement reconciliation plan after the cutover?"],
  ["david", "Is the ledger database migration blocked on anything?"],
  ["maya", "How do we handle a chargeback dispute?"],
  ["wei", "Show me the security incident report from the Q3 breach"]
];

export interface UsageReport {
  /** `fallback` is why the built-in writer answered instead; `error` says more when the reason is "error". */
  calls: Array<{ user: string; question: string; usage?: TokenUsage; fallback?: string; error?: string }>;
  /** Average tokens per model call, counting calls that used tokens without a usable answer. */
  average: number;
  plannedCalls: number;
  projected: number;
  freeTokens: number;
  /** The plan stays under 70% of the free tokens, leaving a margin. */
  fits: boolean;
}

/** Asks the questions on the mock data through the model, recording what each answer used. */
export async function measureUsage(model: Pick<UsageReportingLlm, "generateWithUsage">, options: {
  plannedCalls?: number; freeTokens?: number; questions?: ReadonlyArray<readonly [string, string]> } = {}):
  Promise<UsageReport> {
  const plannedCalls = options.plannedCalls ?? 350;
  const freeTokens = options.freeTokens ?? 1_000_000;
  let current: TokenUsage | undefined;
  let failure: string | undefined;
  const recorder: LlmClient = {
    generate: async (context, question) => {
      try {
        const result = await model.generateWithUsage(context, question);
        current = result.usage;
        return result.text;
      } catch (error) {
        // An answer cut off at the limit, or otherwise unusable, still used tokens.
        if (error instanceof ModelCallError && error.usage) current = error.usage;
        failure = error instanceof Error ? error.message : "Unknown error";
        throw error;
      }
    }
  };
  const brain = new Brain(recorder);
  await brain.syncAll();
  const calls: UsageReport["calls"] = [];
  for (const [user, question] of options.questions ?? USAGE_QUESTIONS) {
    current = undefined;
    failure = undefined;
    await brain.query(brain.user(user)!, question);
    const traceId = brain.lastTraceIds.get(user);
    const fallback = brain.audit.entries.find(entry => entry.type === "llm_fallback" && entry.data.traceId === traceId)
      ?.data.reason;
    calls.push({ user, question, ...(current ? { usage: current } : {}),
      ...(typeof fallback === "string" ? { fallback } : {}),
      ...(fallback === "error" && failure ? { error: failure } : {}) });
  }
  const measured = calls.flatMap(call => call.usage ? [call.usage.total] : []);
  const average = measured.length ? Math.round(measured.reduce((sum, total) => sum + total, 0) / measured.length) : 0;
  const projected = average * plannedCalls;
  const answered = calls.some(call => call.usage && !call.fallback);
  return { calls, average, plannedCalls, projected, freeTokens, fits: answered && projected <= 0.7 * freeTokens };
}

export function formatUsageReport(report: UsageReport): string {
  const number = (value: number) => value.toLocaleString("en-US");
  const lines = report.calls.map(call => {
    const tokens = call.usage
      ? `${number(call.usage.total)} tokens (prompt ${number(call.usage.prompt)}, completion ${number(call.usage.completion)})`
      : undefined;
    const failed = call.fallback ? `no model answer (${call.error ?? call.fallback})` : undefined;
    const what = tokens && failed ? `${tokens}, ${failed}` : tokens ?? failed ?? "no model call (nothing the asker may see)";
    return `  ${call.user.padEnd(5)} ${what.padEnd(48)} ${call.question.slice(0, 60)}`;
  });
  const modelCalls = report.calls.filter(call => call.usage || call.fallback).length;
  const answered = report.calls.filter(call => call.usage && !call.fallback).length;
  const reasons = "\"ungrounded\" means the model didn't copy sentences word for word, and an answer cut off at " +
    "LLM_MAX_TOKENS needs a higher limit.";
  if (!answered) {
    lines.push("", `No model answers were measured. ${reasons} Otherwise, check the provider, key and model settings.`);
    return lines.join("\n");
  }
  if (answered < modelCalls) {
    lines.push("", `${modelCalls - answered} of ${modelCalls} model calls gave no usable answer, so the built-in ` +
      `writer answered those. ${reasons}`);
  }
  const share = Math.round(100 * report.projected / report.freeTokens);
  lines.push("", `Average: ${number(report.average)} tokens per model call.`,
    `Plan: ${number(report.plannedCalls)} answers ≈ ${number(report.projected)} tokens, ${share}% of the ` +
    `${number(report.freeTokens)} free tokens.`);
  if (report.fits) {
    lines.push("Verdict: fits, with a 30% margin.",
      "Each place that uses this Tencent Cloud account counts only its own calls, so their LLM_TOKEN_BUDGET values " +
      "together must stay below the free tokens, e.g. 100000 here and 700000 on the server.");
  } else {
    lines.push("Verdict: doesn't fit with a 30% margin. Use Groq's free plan instead.");
  }
  return lines.join("\n");
}

function option(name: string): number | undefined {
  const value = process.argv.find(argument => argument.startsWith(`--${name}=`))?.split("=")[1];
  return value && /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { llm } = modelsFromEnv(process.env);
  if (!llm) {
    console.error("No model is configured. Set LLM_PROVIDER, LLM_API_KEY and LLM_MODEL in .env.local " +
      "(for Hunyuan also LLM_USAGE_FILE and LLM_TOKEN_BUDGET).");
    process.exit(1);
  }
  const report = await measureUsage(llm, { plannedCalls: option("calls"), freeTokens: option("free") });
  console.log(formatUsageReport(report));
  const usage = llm.meter.usage();
  console.log(`\nCounted so far: ${usage.chatTokens.toLocaleString("en-US")} chat tokens, ` +
    `${usage.embeddingTokens.toLocaleString("en-US")} embedding tokens.`);
  process.exit(report.fits ? 0 : 1);
}
