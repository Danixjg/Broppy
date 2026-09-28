import type { LlmClient } from "@brain/retrieval";

const ENDPOINT = "https://api.hunyuan.cloud.tencent.com/v1/chat/completions";

interface HunyuanOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

export class HunyuanLlm implements LlmClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: HunyuanOptions) {
    if (!options.apiKey.trim() || !options.model.trim() || /[\r\n]/.test(options.apiKey)) {
      throw new Error("Invalid Hunyuan configuration");
    }
    this.fetcher = options.fetch ?? fetch;
  }

  async generate(context: Array<{ citation: string; text: string }>, question: string): Promise<string> {
    if (!question.trim() || !context.length || context.some(item =>
      !item || typeof item.citation !== "string" || !item.citation.trim() ||
      typeof item.text !== "string" || !item.text.trim())) {
      throw new Error("Invalid Hunyuan input");
    }

    const response = await this.fetcher(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.options.model,
        stream: false,
        enable_enhancement: false,
        messages: [
          { role: "system", content: "Answer with exact sentences copied from the supplied context, one sentence per line. Cite each sentence with its context citation in square brackets. If the context cannot answer, say so." },
          { role: "user", content: JSON.stringify({
            question,
            context: context.map(({ citation, text }) => ({ citation, text }))
          }) }
        ]
      }),
      redirect: "error"
    });
    if (!response.ok) throw new Error("Hunyuan request failed");

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("Invalid Hunyuan response");
    }
    if (!result || typeof result !== "object" || !("choices" in result) ||
      !Array.isArray(result.choices) || result.choices.length !== 1) {
      throw new Error("Invalid Hunyuan response");
    }
    const choice: unknown = result.choices[0];
    if (!choice || typeof choice !== "object" || !("finish_reason" in choice) ||
      choice.finish_reason !== "stop" || !("message" in choice) ||
      !choice.message || typeof choice.message !== "object" ||
      !("role" in choice.message) || choice.message.role !== "assistant" ||
      !("content" in choice.message) || typeof choice.message.content !== "string" ||
      !choice.message.content.trim()) {
      throw new Error("Invalid Hunyuan response");
    }
    return choice.message.content;
  }
}

export function createHunyuanLlmFromEnv(): HunyuanLlm {
  return new HunyuanLlm({
    apiKey: process.env.HUNYUAN_API_KEY ?? "",
    model: process.env.HUNYUAN_MODEL ?? ""
  });
}
