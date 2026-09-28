import type { SemanticEmbeddingClient } from "@brain/retrieval";

const ENDPOINT = "https://api.hunyuan.cloud.tencent.com/v1/embeddings";
const MODEL = "hunyuan-embedding";
const DIMENSIONS = 1024;

interface HunyuanEmbeddingOptions {
  apiKey: string;
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
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Invalid Hunyuan embedding input");
    }
    const response = await this.fetcher(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: MODEL, input: text }),
      redirect: "error"
    });
    if (!response.ok) throw new Error("Hunyuan embedding request failed");

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("Invalid Hunyuan embedding response");
    }
    if (!result || typeof result !== "object" || !("data" in result) ||
      !Array.isArray(result.data) || result.data.length !== 1 ||
      !("model" in result) || result.model !== MODEL) {
      throw new Error("Invalid Hunyuan embedding response");
    }
    const item: unknown = result.data[0];
    if (!item || typeof item !== "object" || !("index" in item) || item.index !== 0 ||
      !("embedding" in item) || !Array.isArray(item.embedding) ||
      item.embedding.length !== DIMENSIONS ||
      !item.embedding.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Invalid Hunyuan embedding response");
    }
    return [...item.embedding];
  }
}

export function createHunyuanEmbeddingClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): HunyuanEmbeddingClient | undefined {
  const apiKey = env.HUNYUAN_EMBEDDING_API_KEY;
  return apiKey?.trim() ? new HunyuanEmbeddingClient({ apiKey }) : undefined;
}
