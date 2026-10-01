import type { LlmClient } from "@brain/retrieval";

export type LlmProvider = "hunyuan" | "groq";
export type UnavailableReason = "budget" | "daily_limit" | "rate_limited" | "meter";

/** The model can't be used right now, so the caller answers without it. */
export class ModelUnavailable extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(`Model unavailable: ${reason}`);
  }
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/**
 * A call that reached the provider, or may have, without a usable answer. `usage` is what the provider may bill: its
 * own count, or an estimate when it answered without one. It is undefined when that can't be known (a server error, or
 * no answer in time), and the usage meter then counts the call's whole reservation.
 */
export class ModelCallError extends Error {
  constructor(message: string, readonly usage?: TokenUsage) {
    super(message);
  }
}

/** How long a model call may take before the built-in writer answers instead. */
export const REQUEST_TIMEOUT_MS = 60_000;

// Both speak the same chat completions API; Hunyuan's search enhancement is turned off so answers use only our context.
const PRESETS: Record<LlmProvider, { baseUrl: string; extra: Record<string, unknown> }> = {
  hunyuan: { baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", extra: { enable_enhancement: false } },
  groq: { baseUrl: "https://api.groq.com/openai/v1", extra: {} }
};

const SYSTEM = "Answer with exact sentences copied from the supplied context, one sentence per line. Cite each " +
  "sentence with its context citation in square brackets. If the context cannot answer, say so.";

/** For a provider that doesn't report usage: about three characters a token, rounded up, so the count errs high. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function reportedUsage(result: unknown): TokenUsage | undefined {
  const usage = result && typeof result === "object" && "usage" in result && result.usage &&
    typeof result.usage === "object" ? result.usage : undefined;
  return usage && "prompt_tokens" in usage && "completion_tokens" in usage && "total_tokens" in usage &&
    count(usage.prompt_tokens) && count(usage.completion_tokens) && count(usage.total_tokens)
    ? { prompt: usage.prompt_tokens as number, completion: usage.completion_tokens as number,
      total: usage.total_tokens as number }
    : undefined;
}

export interface ChatLlmOptions {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  /** 60 seconds unless set. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ChatLlm implements LlmClient {
  readonly provider: LlmProvider;
  readonly endpoint: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ChatLlmOptions) {
    if (!Object.hasOwn(PRESETS, options.provider)) throw new Error("Invalid model provider");
    if (!options.apiKey.trim() || !options.model.trim() || /[\r\n]/.test(options.apiKey)) {
      throw new Error("Invalid model configuration");
    }
    this.provider = options.provider;
    this.endpoint = `${(options.baseUrl ?? PRESETS[options.provider].baseUrl).replace(/\/+$/, "")}/chat/completions`;
    this.maxTokens = options.maxTokens ?? 1500;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.fetcher = options.fetch ?? fetch;
  }

  /** The most a call may use: its prompt, estimated, plus the answer limit. The meter holds this while it runs. */
  reservation(context: Array<{ citation: string; text: string }>, question: string): number {
    return estimateTokens(this.request(context, question)) + this.maxTokens;
  }

  async generate(context: Array<{ citation: string; text: string }>, question: string): Promise<string> {
    return (await this.generateWithUsage(context, question)).text;
  }

  async generateWithUsage(context: Array<{ citation: string; text: string }>, question: string):
    Promise<{ text: string; usage: TokenUsage }> {
    if (!question.trim() || !context.length || context.some(item =>
      !item || typeof item.citation !== "string" || !item.citation.trim() ||
      typeof item.text !== "string" || !item.text.trim())) {
      throw new Error("Invalid model input");
    }

    const body = this.request(context, question);
    // No answer in time, or a broken connection: the provider may still bill for the call.
    const lost = () => new ModelCallError("Model request failed");
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw lost();
    }
    if (response.status === 429) throw new ModelUnavailable("rate_limited");
    // Refused before any work, such as a wrong key or model name: there is nothing to bill.
    if (response.status >= 400 && response.status < 500) throw new Error("Model request refused");
    if (!response.ok) throw lost();
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      throw lost();
    }

    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      result = undefined;
    }
    // The answer, reasoning included, as the provider counted it, or estimated from what came back.
    const prompt = estimateTokens(body);
    const completion = estimateTokens(raw);
    const usage = reportedUsage(result) ?? { prompt, completion, total: prompt + completion };
    const invalid = (message = "Invalid model response") => new ModelCallError(message, usage);
    if (!result || typeof result !== "object" || !("choices" in result) ||
      !Array.isArray(result.choices) || result.choices.length !== 1) {
      throw invalid();
    }
    const choice: unknown = result.choices[0];
    if (choice && typeof choice === "object" && "finish_reason" in choice && choice.finish_reason === "length") {
      throw invalid("Model answer cut off at LLM_MAX_TOKENS");
    }
    if (!choice || typeof choice !== "object" || !("finish_reason" in choice) ||
      choice.finish_reason !== "stop" || !("message" in choice) ||
      !choice.message || typeof choice.message !== "object" ||
      !("role" in choice.message) || choice.message.role !== "assistant" ||
      !("content" in choice.message) || typeof choice.message.content !== "string") {
      throw invalid();
    }
    // A reasoning model may think aloud in <think> tags or a separate field; only the answer counts.
    const text = choice.message.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (!text) throw invalid();
    return { text, usage };
  }

  private request(context: Array<{ citation: string; text: string }>, question: string): string {
    return JSON.stringify({
      model: this.options.model,
      stream: false,
      max_tokens: this.maxTokens,
      ...PRESETS[this.provider].extra,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify({
          question,
          context: context.map(({ citation, text }) => ({ citation, text }))
        }) }
      ]
    });
  }
}

/** A whole number above zero from a setting, or undefined when the setting is empty. */
export function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^[1-9]\d*$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a whole number above 0`);
  }
  return Number(value);
}

// Another address for the same API: HTTPS, or plain HTTP only on this machine (a local stub).
function baseUrlFromEnv(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LLM_BASE_URL must be an HTTPS address");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password ||
    url.search || url.hash) {
    throw new Error("LLM_BASE_URL must be an HTTPS address (plain HTTP only for this machine)");
  }
  return `${url.origin}${url.pathname}`;
}

/**
 * The chat model from settings, or undefined for the built-in writer. LLM_PROVIDER, LLM_API_KEY and LLM_MODEL pick
 * it; the older HUNYUAN_API_KEY and HUNYUAN_MODEL still select Hunyuan.
 */
export function chatLlmFromEnv(env: NodeJS.ProcessEnv = process.env, fetcher?: typeof fetch): ChatLlm | undefined {
  const legacy = Boolean(env.HUNYUAN_API_KEY || env.HUNYUAN_MODEL);
  if (!legacy && !env.LLM_PROVIDER && !env.LLM_API_KEY && !env.LLM_MODEL) return undefined;
  const provider = env.LLM_PROVIDER || (legacy ? "hunyuan" : undefined);
  if (provider !== "hunyuan" && provider !== "groq") throw new Error("LLM_PROVIDER must be hunyuan or groq");
  return new ChatLlm({
    provider,
    apiKey: env.LLM_API_KEY || (provider === "hunyuan" ? env.HUNYUAN_API_KEY : undefined) || "",
    model: env.LLM_MODEL || (provider === "hunyuan" ? env.HUNYUAN_MODEL : undefined) || "",
    baseUrl: baseUrlFromEnv(env.LLM_BASE_URL),
    maxTokens: positiveInteger(env.LLM_MAX_TOKENS, "LLM_MAX_TOKENS"),
    fetch: fetcher
  });
}
