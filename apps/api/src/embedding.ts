import type { SemanticEmbeddingClient } from "@brain/retrieval";
import { estimateTokens, ModelCallError, REQUEST_TIMEOUT_MS } from "./llm.js";

const ENDPOINT = "https://api.hunyuan.cloud.tencent.com/v1/embeddings";
const MODEL = "hunyuan-embedding";
const DIMENSIONS = 1024;

interface HunyuanEmbeddingOptions {
  apiKey: string;
  /** 60 seconds unless set. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HunyuanEmbeddingClient implements SemanticEmbeddingClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: HunyuanEmbeddingOptions) {
    if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) {
      throw new Error("Invalid Hunyuan embedding configuration");
    }
    this.fetcher = options.fetch ?? fetch;
  }

  async embed(text: string): Promise<number[]> {
    return (await this.embedWithUsage(text)).vector;
  }

  /** The vector and the tokens it used: as reported, or about three characters a token when not. */
  async embedWithUsage(text: string): Promise<{ vector: number[]; tokens: number }> {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Invalid Hunyuan embedding input");
    }
    // No answer in time, or a broken connection: the provider may still bill for the call.
    const lost = () => new ModelCallError("Hunyuan embedding request failed");
    let response: Response;
    try {
      response = await this.fetcher(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: MODEL, input: text }),
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw lost();
    }
    // Refused before any work, such as a wrong key: there is nothing to bill.
    if (response.status >= 400 && response.status < 500) throw new Error("Hunyuan embedding request refused");
    if (!response.ok) throw lost();

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new ModelCallError("Invalid Hunyuan embedding response", usageOf(estimateTokens(text)));
    }
    const usage = result && typeof result === "object" && "usage" in result && result.usage &&
      typeof result.usage === "object" && "total_tokens" in result.usage ? result.usage.total_tokens : undefined;
    const tokens = typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0
      ? usage : estimateTokens(text);
    // A bad answer still counts what the provider may bill for it.
    const invalid = () => new ModelCallError("Invalid Hunyuan embedding response", usageOf(tokens));
    if (!result || typeof result !== "object" || !("data" in result) ||
      !Array.isArray(result.data) || result.data.length !== 1 ||
      !("model" in result) || result.model !== MODEL) {
      throw invalid();
    }
    const item: unknown = result.data[0];
    if (!item || typeof item !== "object" || !("index" in item) || item.index !== 0 ||
      !("embedding" in item) || !Array.isArray(item.embedding) ||
      item.embedding.length !== DIMENSIONS ||
      !item.embedding.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw invalid();
    }
    return { vector: [...item.embedding], tokens };
  }
}

const usageOf = (tokens: number) => ({ prompt: tokens, completion: 0, total: tokens });

export function createHunyuanEmbeddingClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): HunyuanEmbeddingClient | undefined {
  const apiKey = env.HUNYUAN_EMBEDDING_API_KEY;
  return apiKey?.trim() ? new HunyuanEmbeddingClient({ apiKey }) : undefined;
}
