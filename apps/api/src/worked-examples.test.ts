import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelsFromEnv } from "./llm-budget.js";
import { runWorkedExamples } from "./worked-examples.js";

// `pnpm scenarios` rewrites docs/worked-examples.md from the built-in writer's run, and `pnpm test` fails when the file
// no longer matches it. `pnpm scenarios:model` captures the configured model's run in docs/worked-examples-model.md.
const modelRun = process.env.WORKED_EXAMPLES === "model";
const PROVIDERS: Record<string, string> = { tokenhub: "TokenHub", hunyuan: "Hunyuan", groq: "Groq" };

afterEach(() => {
  vi.useRealTimers();
});

describe("worked examples", () => {
  it.skipIf(modelRun)("match docs/worked-examples.md", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const markdown = await runWorkedExamples({
      at: iso => vi.setSystemTime(new Date(iso)),
      writer: "the built-in writer, which quotes the most relevant source in full and the best sentence of the next " +
        "three. `pnpm scenarios:model` runs the same steps with the chosen language model and writes " +
        "`worked-examples-model.md`."
    });
    await expect(markdown).toMatchFileSnapshot("../../../docs/worked-examples.md");
  });

  it.runIf(modelRun)("capture the configured model's run", async () => {
    const captured = new Date().toISOString().slice(0, 10);
    const { llm, embedding } = modelsFromEnv(process.env);
    if (!llm) throw new Error("No model is configured: set LLM_PROVIDER, LLM_API_KEY and LLM_MODEL in .env.local");
    const provider = process.env.LLM_PROVIDER ?? "hunyuan";
    const model = process.env.LLM_MODEL || process.env.HUNYUAN_MODEL || "";
    vi.useFakeTimers({ toFake: ["Date"] });
    const markdown = await runWorkedExamples({
      llm,
      embedding,
      at: iso => vi.setSystemTime(new Date(iso)),
      writer: `${PROVIDERS[provider] ?? provider}'s \`${model}\`, captured on ${captured}. Model answers vary from run ` +
        "to run, so the tests don't check this file. Where the model couldn't answer, the built-in writer did, as noted."
    });
    writeFileSync(new URL("../../../docs/worked-examples-model.md", import.meta.url), markdown);
  }, 15 * 60_000);
});
