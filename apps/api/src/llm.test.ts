import { describe, expect, it, vi } from "vitest";
import { ChatLlm, chatLlmFromEnv, ModelCallError, ModelUnavailable } from "./llm.js";

const context = [{ citation: "jira:PAY-101:0", text: "Cutover starts at 2 PM." }];
const reply = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", ...message } }], ...extra }),
    { status: 200 });

describe("ChatLlm", () => {
  it("sends only the supplied context and question to Hunyuan's endpoint", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => reply({ content: "At 2 PM. [jira:PAY-101:0]" }));
    const client = new ChatLlm({ provider: "hunyuan", apiKey: "secret-key", model: "hunyuan-t1-latest",
      fetch: fetcher as typeof fetch });
    const supplied = [{ ...context[0], title: "restricted-title-sentinel" }];
    expect(await client.generate(supplied, "When is cutover?")).toBe("At 2 PM. [jira:PAY-101:0]");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.hunyuan.cloud.tencent.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Authorization: "Bearer secret-key", "Content-Type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("hunyuan-t1-latest");
    expect(body.stream).toBe(false);
    expect(body.enable_enhancement).toBe(false);
    expect(body.max_tokens).toBe(1500);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
    expect(JSON.parse(body.messages[1].content)).toEqual({ question: "When is cutover?", context });
    expect(init.body).not.toContain("restricted-title-sentinel");
  });

  it("uses TokenHub's international endpoint without Hunyuan-only fields", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => reply({ content: "At 2 PM. [jira:PAY-101:0]" }));
    const client = new ChatLlm({ provider: "tokenhub", apiKey: "th-key", model: "hy3", fetch: fetcher as typeof fetch });
    await client.generate(context, "When is cutover?");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://tokenhub-intl.tencentcloudmaas.com/v1/chat/completions");
    expect(init.headers).toEqual({ Authorization: "Bearer th-key", "Content-Type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("enable_enhancement");
    expect(body).toMatchObject({ model: "hy3", stream: false, max_tokens: 1500 });
  });

  it("uses Groq's endpoint without Hunyuan-only fields", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => reply({ content: "At 2 PM. [jira:PAY-101:0]" }));
    const client = new ChatLlm({ provider: "groq", apiKey: "gsk-key", model: "llama-3.3-70b-versatile",
      fetch: fetcher as typeof fetch });
    await client.generate(context, "When is cutover?");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("enable_enhancement");
    expect(body).toMatchObject({ model: "llama-3.3-70b-versatile", stream: false, max_tokens: 1500 });
  });

  it("returns only the answer from a reasoning model, with the tokens the provider counted", async () => {
    const fetcher = vi.fn(async () => reply(
      { content: "<think>Which sentence?</think>\nAt 2 PM. [jira:PAY-101:0]", reasoning_content: "hidden reasoning" },
      { usage: { prompt_tokens: 120, completion_tokens: 480, total_tokens: 600 } }));
    const client = new ChatLlm({ provider: "hunyuan", apiKey: "key", model: "hunyuan-t1-latest", fetch: fetcher as typeof fetch });
    expect(await client.generateWithUsage(context, "When is cutover?")).toEqual({
      text: "At 2 PM. [jira:PAY-101:0]", usage: { prompt: 120, completion: 480, total: 600 }
    });
  });

  it("estimates the tokens when the provider doesn't count them", async () => {
    const fetcher = vi.fn(async () => reply({ content: "At 2 PM. [jira:PAY-101:0]" }));
    const client = new ChatLlm({ provider: "groq", apiKey: "key", model: "model", fetch: fetcher as typeof fetch });
    const { usage } = await client.generateWithUsage(context, "When is cutover?");
    expect(usage.prompt).toBeGreaterThan(0);
    expect(usage.completion).toBeGreaterThan(0);
    expect(usage.total).toBe(usage.prompt + usage.completion);
  });

  it("reports a rate limit as the model being unavailable, so the caller can fall back", async () => {
    const fetcher = vi.fn(async () => new Response("slow down", { status: 429 }));
    const client = new ChatLlm({ provider: "groq", apiKey: "key", model: "model", fetch: fetcher as typeof fetch });
    const failure = await client.generate(context, "question").catch(error => error);
    expect(failure).toBeInstanceOf(ModelUnavailable);
    expect(failure.reason).toBe("rate_limited");
  });

  it("says what a failed call may cost, so the usage meter can count it", async () => {
    const failure = async (response: Response) => {
      const client = new ChatLlm({ provider: "hunyuan", apiKey: "key", model: "model",
        fetch: (async () => response) as typeof fetch });
      return client.generate(context, "question").catch(error => error);
    };
    // Cut off at the token limit: the provider bills it, so its reported tokens count.
    const cutOff = await failure(new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { role: "assistant", content: "<think>Which sentence" } }],
      usage: { prompt_tokens: 100, completion_tokens: 1500, total_tokens: 1600 }
    }), { status: 200 }));
    expect(cutOff).toBeInstanceOf(ModelCallError);
    expect(cutOff.message).toContain("LLM_MAX_TOKENS");
    expect(cutOff.usage).toEqual({ prompt: 100, completion: 1500, total: 1600 });
    // An unreadable answer with no count: estimated.
    const unreadable = await failure(new Response("not json", { status: 200 }));
    expect(unreadable).toBeInstanceOf(ModelCallError);
    expect(unreadable.usage.total).toBeGreaterThan(0);
    // A server error: whether it was billed can't be known.
    const serverError = await failure(new Response("", { status: 502 }));
    expect(serverError).toBeInstanceOf(ModelCallError);
    expect(serverError.usage).toBeUndefined();
    // Refused before any work, such as a wrong key: nothing to bill.
    const refused = await failure(new Response("bad key", { status: 401 }));
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(ModelCallError);
  });

  it("gives up on a provider that doesn't answer in time", async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const client = new ChatLlm({ provider: "groq", apiKey: "key", model: "model", timeoutMs: 20,
      fetch: fetcher as typeof fetch });
    const failure = await client.generate(context, "question").catch(error => error);
    expect(failure).toBeInstanceOf(ModelCallError);
    expect(failure.usage).toBeUndefined();
  });

  it("reserves the prompt and the answer limit for each call", () => {
    const client = new ChatLlm({ provider: "groq", apiKey: "key", model: "model", maxTokens: 200 });
    const reserved = client.reservation(context, "When is cutover?");
    expect(reserved).toBeGreaterThan(200);
    expect(client.reservation(context, `When is cutover?${" again".repeat(50)}`)).toBeGreaterThanOrEqual(reserved + 99);
  });

  it("rejects empty context or question without contacting the provider", async () => {
    const fetcher = vi.fn();
    const client = new ChatLlm({ provider: "hunyuan", apiKey: "key", model: "model", fetch: fetcher as typeof fetch });
    await expect(client.generate([], "question")).rejects.toThrow("Invalid model input");
    await expect(client.generate(context, " ")).rejects.toThrow("Invalid model input");
    await expect(client.generate([{ citation: "", text: "text" }], "question")).rejects.toThrow("Invalid model input");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on provider errors and malformed output without logging context", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const response of [
        new Response("sensitive provider body", { status: 500 }),
        new Response("not json", { status: 200 }),
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
        reply({ content: "" }),
        reply({ content: "<think>only thinking</think>" }),
        new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "truncated" } }] }), { status: 200 })
      ]) {
        const fetcher = vi.fn(async () => response);
        const client = new ChatLlm({ provider: "hunyuan", apiKey: "key", model: "model", fetch: fetcher as typeof fetch });
        await expect(client.generate(context, "question")).rejects.toThrow();
      }
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("requires a key, a model and a known provider", () => {
    expect(() => new ChatLlm({ provider: "hunyuan", apiKey: "", model: "model" })).toThrow();
    expect(() => new ChatLlm({ provider: "hunyuan", apiKey: "key", model: "" })).toThrow();
    expect(() => new ChatLlm({ provider: "hunyuan", apiKey: "key\nInjected: header", model: "model" })).toThrow();
    expect(() => new ChatLlm({ provider: "other" as "groq", apiKey: "key", model: "model" })).toThrow();
  });
});

describe("chatLlmFromEnv", () => {
  it("stays off without settings, and reads the old Hunyuan settings", () => {
    expect(chatLlmFromEnv({})).toBeUndefined();
    const legacy = chatLlmFromEnv({ HUNYUAN_API_KEY: "key", HUNYUAN_MODEL: "hunyuan-t1-latest" });
    expect(legacy?.provider).toBe("hunyuan");
    expect(() => chatLlmFromEnv({ HUNYUAN_API_KEY: "key" })).toThrow();
  });

  it("picks the provider from LLM_PROVIDER and refuses unknown ones", () => {
    const groq = chatLlmFromEnv({ LLM_PROVIDER: "groq", LLM_API_KEY: "key", LLM_MODEL: "llama-3.3-70b-versatile" });
    expect(groq?.provider).toBe("groq");
    expect(groq?.endpoint).toBe("https://api.groq.com/openai/v1/chat/completions");
    const tokenhub = chatLlmFromEnv({ LLM_PROVIDER: "tokenhub", LLM_API_KEY: "key", LLM_MODEL: "hy3" });
    expect(tokenhub?.provider).toBe("tokenhub");
    expect(tokenhub?.endpoint).toBe("https://tokenhub-intl.tencentcloudmaas.com/v1/chat/completions");
    expect(() => chatLlmFromEnv({ LLM_PROVIDER: "other", LLM_API_KEY: "key", LLM_MODEL: "model" }))
      .toThrow("LLM_PROVIDER must be hunyuan, tokenhub or groq");
    expect(() => chatLlmFromEnv({ LLM_API_KEY: "key", LLM_MODEL: "model" })).toThrow("LLM_PROVIDER");
  });

  it("accepts another address only over HTTPS, or plain HTTP on this machine for a local stub", () => {
    const base = { LLM_PROVIDER: "groq", LLM_API_KEY: "key", LLM_MODEL: "model" };
    expect(chatLlmFromEnv({ ...base, LLM_BASE_URL: "http://127.0.0.1:4010/v1" })?.endpoint)
      .toBe("http://127.0.0.1:4010/v1/chat/completions");
    expect(chatLlmFromEnv({ ...base, LLM_BASE_URL: "https://llm.example.test/openai/v1/" })?.endpoint)
      .toBe("https://llm.example.test/openai/v1/chat/completions");
    expect(() => chatLlmFromEnv({ ...base, LLM_BASE_URL: "http://llm.example.test/v1" })).toThrow("LLM_BASE_URL");
    expect(() => chatLlmFromEnv({ ...base, LLM_MAX_TOKENS: "0" })).toThrow("LLM_MAX_TOKENS");
  });
});
