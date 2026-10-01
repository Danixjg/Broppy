import { describe, expect, it, vi } from "vitest";
import { createHunyuanEmbeddingClientFromEnv, HunyuanEmbeddingClient } from "./embedding.js";
import { ModelCallError } from "./llm.js";

const embedding: number[] = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
const validResponse = () => ({
  object: "list",
  model: "hunyuan-embedding",
  data: [{ object: "embedding", index: 0, embedding }]
});

describe("HunyuanEmbeddingClient", () => {
  it("posts the documented model and input using bearer authentication", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(validResponse()), { status: 200 }));
    const client = new HunyuanEmbeddingClient({ apiKey: "secret", fetch: fetcher as typeof fetch });
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
        const client = new HunyuanEmbeddingClient({ apiKey: "key", fetch: fetcher as typeof fetch });
        await expect(client.embed("private input")).rejects.toThrow(/Hunyuan embedding/);
      }
      const nonFinite = validResponse();
      nonFinite.data[0].embedding[0] = Infinity;
      const fetcher = vi.fn(async () => ({ ok: true, json: async () => nonFinite } as Response));
      await expect(new HunyuanEmbeddingClient({ apiKey: "key", fetch: fetcher as typeof fetch }).embed("private input"))
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
      new HunyuanEmbeddingClient({ apiKey: "key", timeoutMs, fetch: ((_url: string, init: RequestInit) =>
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
    expect(createHunyuanEmbeddingClientFromEnv({})).toBeUndefined();
    expect(createHunyuanEmbeddingClientFromEnv({ HUNYUAN_EMBEDDING_API_KEY: "key" }))
      .toBeInstanceOf(HunyuanEmbeddingClient);
    expect(() => new HunyuanEmbeddingClient({ apiKey: "" })).toThrow();
    expect(() => new HunyuanEmbeddingClient({ apiKey: "key\nother" })).toThrow();
    const fetcher = vi.fn();
    await expect(new HunyuanEmbeddingClient({ apiKey: "key", fetch: fetcher as typeof fetch }).embed(" "))
      .rejects.toThrow("Invalid Hunyuan embedding input");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
