import type { SemanticEmbeddingClient } from "@brain/retrieval";
import { estimateTokens, ModelCallError } from "./llm.js";

export type EmbeddingProvider = "cloudflare" | "hunyuan";

const DIMENSIONS = 1024;
// Questions wait for their embedding, so a provider that hangs is given up on sooner than a chat model.
export const EMBEDDING_TIMEOUT_MS = 10_000;

// Both speak the OpenAI-style embeddings API and return 1024 numbers, the size the index and Supabase store.
// Cloudflare Workers AI's bge-m3 is the one in use (D56); Tencent's Hunyuan stays as an unused option (D55).
const PRESETS: Record<EmbeddingProvider, {
  name: string;
  model: string;
  endpoint: (accountId: string) => string;
  /** Hunyuan names its model in every response; Cloudflare's OpenAI-style endpoint isn't documented to. */
  namesModel: boolean;
}> = {
  cloudflare: {
    name: "Cloudflare", model: "@cf/baai/bge-m3", namesModel: false,
    endpoint: accountId => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/embeddings`
  },
  hunyuan: {
    name: "Hunyuan", model: "hunyuan-embedding", namesModel: true,
    endpoint: () => "https://api.hunyuan.cloud.tencent.com/v1/embeddings"
  }
};

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

export interface EmbeddingClientOptions {
  provider: EmbeddingProvider;
  apiKey: string;
  /** Cloudflare only: the account ID shown in its dashboard. */
  accountId?: string;
  /** 10 seconds unless set. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class EmbeddingClient implements SemanticEmbeddingClient {
  readonly provider: EmbeddingProvider;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: EmbeddingClientOptions) {
    const preset = PRESETS[options.provider];
    if (!preset || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey) ||
      (options.provider === "cloudflare" && !ACCOUNT_ID.test(options.accountId ?? ""))) {
      throw new Error(preset ? `Invalid ${preset.name} embedding configuration` : "Invalid embedding configuration");
    }
    this.provider = options.provider;
    this.endpoint = preset.endpoint(options.accountId ?? "");
    this.fetcher = options.fetch ?? fetch;
  }

  async embed(text: string): Promise<number[]> {
    return (await this.embedWithUsage(text)).vector;
  }

  /** The vector and the tokens it used: as reported, or about three characters a token when not. */
  async embedWithUsage(text: string): Promise<{ vector: number[]; tokens: number }> {
    const { name, model, namesModel } = PRESETS[this.provider];
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`Invalid ${name} embedding input`);
    }
    // No answer in time, or a broken connection: the provider may still bill for the call.
    const lost = () => new ModelCallError(`${name} embedding request failed`);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model, input: text }),
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? EMBEDDING_TIMEOUT_MS)
      });
    } catch {
      throw lost();
    }
    // Refused before any work, such as a wrong key or a free plan's used-up allocation: there is nothing to bill.
    if (response.status >= 400 && response.status < 500) throw new Error(`${name} embedding request refused`);
    if (!response.ok) throw lost();

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new ModelCallError(`Invalid ${name} embedding response`, usageOf(estimateTokens(text)));
    }
    const usage = result && typeof result === "object" && "usage" in result && result.usage &&
      typeof result.usage === "object" && "total_tokens" in result.usage ? result.usage.total_tokens : undefined;
    const tokens = typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0
      ? usage : estimateTokens(text);
    // A bad answer still counts what the provider may bill for it.
    const invalid = () => new ModelCallError(`Invalid ${name} embedding response`, usageOf(tokens));
    if (!result || typeof result !== "object" || !("data" in result) ||
      !Array.isArray(result.data) || result.data.length !== 1 ||
      (namesModel && (!("model" in result) || result.model !== model))) {
      throw invalid();
    }
    const item: unknown = result.data[0];
    if (!item || typeof item !== "object" || ("index" in item && item.index !== 0) ||
      !("embedding" in item) || !Array.isArray(item.embedding) ||
      item.embedding.length !== DIMENSIONS ||
      !item.embedding.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw invalid();
    }
    return { vector: [...item.embedding], tokens };
  }
}

const usageOf = (tokens: number) => ({ prompt: tokens, completion: 0, total: tokens });

/**
 * The embedding provider from settings, or undefined for keyword search only. EMBEDDING_PROVIDER and
 * EMBEDDING_API_KEY pick it, with CLOUDFLARE_ACCOUNT_ID for Cloudflare; the older HUNYUAN_EMBEDDING_API_KEY still
 * selects Hunyuan.
 */
export function embeddingFromEnv(env: NodeJS.ProcessEnv = process.env, fetcher?: typeof fetch):
  EmbeddingClient | undefined {
  const legacy = Boolean(env.HUNYUAN_EMBEDDING_API_KEY);
  if (!legacy && !env.EMBEDDING_PROVIDER && !env.EMBEDDING_API_KEY && !env.CLOUDFLARE_ACCOUNT_ID) return undefined;
  const provider = env.EMBEDDING_PROVIDER || (legacy ? "hunyuan" : undefined);
  if (provider !== "cloudflare" && provider !== "hunyuan") {
    throw new Error("EMBEDDING_PROVIDER must be cloudflare or hunyuan");
  }
  if (provider === "cloudflare" && !ACCOUNT_ID.test(env.CLOUDFLARE_ACCOUNT_ID ?? "")) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID shown in the Cloudflare dashboard");
  }
  return new EmbeddingClient({
    provider,
    apiKey: env.EMBEDDING_API_KEY || (provider === "hunyuan" ? env.HUNYUAN_EMBEDDING_API_KEY : undefined) || "",
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    fetch: fetcher
  });
}
