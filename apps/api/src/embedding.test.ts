import { describe, expect, it, vi } from "vitest";
import { EmbeddingClient, embeddingFromEnv } from "./embedding.js";
import { ModelCallError } from "./llm.js";

const embedding: number[] = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
const validResponse = () => ({
  object: "list",
  model: "hunyuan-embedding",
  // A fresh copy each time: one test below sets a value to Infinity.
  data: [{ object: "embedding", index: 0, embedding: [...embedding] }]
});

describe("EmbeddingClient with the Hunyuan preset", () => {
  it("posts the documented model and input using bearer authentication", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(validResponse()), { status: 200 }));
    const client = new EmbeddingClient({ provider: "hunyuan", apiKey: "secret", fetch: fetcher as typeof fetch });
    expect(await client.embed("Private document text")).toEqual(embedding);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.hunyuan.cloud.tencent.com/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Authorization: "Bearer secret", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ model: "hunyuan-embedding", input: "Private document text" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed vectors, wrong model, and provider failures without logging text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const response of [
        new Response("private provider text", { status: 500 }),
        new Response("not json", { status: 200 }),
        new Response(JSON.stringify({ ...validResponse(), model: "other" }), { status: 200 }),
        new Response(JSON.stringify({ ...validResponse(), data: [] }), { status: 200 }),
        new Response(JSON.stringify({ ...validResponse(), data: [{ index: 0, embedding: [1] }] }), { status: 200 }),
        new Response(JSON.stringify({ ...validResponse(), data: [{ index: 0, embedding: Array(1024).fill("1") }] }), { status: 200 })
      ]) {
        const fetcher = vi.fn(async () => response);
        const client = new EmbeddingClient({ provider: "hunyuan", apiKey: "key", fetch: fetcher as typeof fetch });
        await expect(client.embed("private input")).rejects.toThrow(/Hunyuan embedding/);
      }
      const nonFinite = validResponse();
      nonFinite.data[0].embedding[0] = Infinity;
      const fetcher = vi.fn(async () => ({ ok: true, json: async () => nonFinite } as Response));
      await expect(new EmbeddingClient({ provider: "hunyuan", apiKey: "key", fetch: fetcher as typeof fetch }).embed("private input"))
        .rejects.toThrow("Invalid Hunyuan embedding response");
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("says what a failed call may cost, so the usage meter can count it", async () => {
    // "hang" stands for a provider that never answers; like fetch, it gives up when the signal aborts.
    const failure = (response: Response | "hang", timeoutMs?: number) =>
      new EmbeddingClient({ provider: "hunyuan", apiKey: "key", timeoutMs, fetch: ((_url: string, init: RequestInit) =>
        response === "hang"
          ? new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
          : Promise.resolve(response)) as typeof fetch })
        .embed("private input").catch(error => error);
    // A bad answer still counts what the provider reported.
    const bad = await failure(new Response(JSON.stringify({ ...validResponse(), data: [], usage: { total_tokens: 12 } }),
      { status: 200 }));
    expect(bad).toBeInstanceOf(ModelCallError);
    expect(bad.usage.total).toBe(12);
    // A server error or no answer in time: the cost can't be known.
    for (const unknown of [await failure(new Response("", { status: 503 })), await failure("hang", 20)]) {
      expect(unknown).toBeInstanceOf(ModelCallError);
      expect(unknown.usage).toBeUndefined();
    }
    // Refused before any work: nothing to bill.
    expect(await failure(new Response("bad key", { status: 401 }))).not.toBeInstanceOf(ModelCallError);
  });

  it("keeps the integration opt-in and validates configuration and input", async () => {
    expect(embeddingFromEnv({})).toBeUndefined();
    // The older setting still selects Hunyuan.
    expect(embeddingFromEnv({ HUNYUAN_EMBEDDING_API_KEY: "key" })?.provider).toBe("hunyuan");
    expect(() => new EmbeddingClient({ provider: "hunyuan", apiKey: "" })).toThrow();
    expect(() => new EmbeddingClient({ provider: "hunyuan", apiKey: "key\nother" })).toThrow();
    const fetcher = vi.fn();
    await expect(new EmbeddingClient({ provider: "hunyuan", apiKey: "key", fetch: fetcher as typeof fetch }).embed(" "))
      .rejects.toThrow("Invalid Hunyuan embedding input");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("EmbeddingClient with the Cloudflare preset", () => {
  it("posts bge-m3 to the account's Workers AI endpoint and reads the reported tokens", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      object: "list", data: [{ object: "embedding", index: 0, embedding }], usage: { prompt_tokens: 7, total_tokens: 7 }
    }), { status: 200 }));
    const client = new EmbeddingClient({ provider: "cloudflare", apiKey: "token", accountId: ACCOUNT,
      fetch: fetcher as typeof fetch });
    expect(await client.embedWithUsage("Private document text")).toEqual({ vector: embedding, tokens: 7 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/embeddings`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Authorization: "Bearer token", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ model: "@cf/baai/bge-m3", input: "Private document text" });
  });

  it("checks a vector by its size, whatever model name the response carries", async () => {
    const client = (body: unknown) => new EmbeddingClient({ provider: "cloudflare", apiKey: "token", accountId: ACCOUNT,
      fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch });
    const item = { object: "embedding", index: 0, embedding };
    expect(await client({ object: "list", data: [item] }).embed("text")).toEqual(embedding);
    expect(await client({ object: "list", model: "bge-m3", data: [item] }).embed("text")).toEqual(embedding);
    await expect(client({ object: "list", data: [{ ...item, embedding: embedding.slice(0, 768) }] }).embed("text"))
      .rejects.toThrow("Invalid Cloudflare embedding response");
    // A refusal, such as the free plan's daily allocation being used up, is not billed.
    const refused = new EmbeddingClient({ provider: "cloudflare", apiKey: "token", accountId: ACCOUNT,
      fetch: (async () => new Response("{}", { status: 429 })) as typeof fetch });
    const error = await refused.embed("text").catch(caught => caught);
    expect(error.message).toBe("Cloudflare embedding request refused");
    expect(error).not.toBeInstanceOf(ModelCallError);
  });

  it("reads its settings and refuses incomplete ones", () => {
    const cloudflare = { EMBEDDING_PROVIDER: "cloudflare", EMBEDDING_API_KEY: "token", CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
    expect(embeddingFromEnv(cloudflare)?.provider).toBe("cloudflare");
    expect(() => embeddingFromEnv({ ...cloudflare, CLOUDFLARE_ACCOUNT_ID: "" })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() => embeddingFromEnv({ ...cloudflare, CLOUDFLARE_ACCOUNT_ID: "../../zones" })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() => embeddingFromEnv({ ...cloudflare, EMBEDDING_API_KEY: "" })).toThrow("Invalid Cloudflare embedding configuration");
    expect(() => embeddingFromEnv({ ...cloudflare, EMBEDDING_PROVIDER: "gemini" })).toThrow(/EMBEDDING_PROVIDER/);
    expect(() => embeddingFromEnv({ EMBEDDING_API_KEY: "token" })).toThrow(/EMBEDDING_PROVIDER/);
  });
});
